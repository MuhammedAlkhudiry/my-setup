#!/usr/bin/env bun
// Finds agent friction episodes in recorded Claude Code and Codex sessions and ranks their causes by turns wasted.
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

type Obj = Record<string, unknown>;
type Category = "errors" | "not-finding" | "searching" | "slowness" | "wasted-work";
type Call = {
  id: string;
  tool: string;
  label: string;
  command: string;
  path: string;
  start: number;
  end: number;
  output: string;
  error: boolean;
  turn: number;
  line: number;
  endLine: number;
};
type Session = {
  file: string;
  harness: "claude" | "codex";
  cwd: string;
  subagent: boolean;
  calls: Call[];
  compactions: Array<{ at: number; ms: number; line: number; turn: number }>;
  requests: Array<{ model: string; start: number; ms: number }>;
  turnTokens: number[];
  startupTokens: number;
};
type Friction = {
  category: Category;
  cause: string;
  turns: number;
  tokens: number;
  lostMs: number;
  retries: number;
  file: string;
  ref: string;
  detail: string;
};
type Episode = { ref: string; turns: number; detail: string };
type Totals = { count: number; turns: number; tokens: number; lostMs: number };
type Cause = Totals & {
  key: string;
  category: Category;
  cause: string;
  sessions: number;
  retries: number;
  episodes: Episode[];
  before?: { count: number; turns: number; lostMs: number };
};

const home = process.env.HOME || process.env.USERPROFILE || "";
const HELP = `Usage: analyze-sessions.ts [options]
       analyze-sessions.ts --episode <file>:<from>-<to>

Finds friction episodes in recorded sessions and ranks their causes by turns and tokens wasted (wall time second).
Waiting on legitimate work (checks, builds, tests, QA, model responses) is totalled separately, not ranked.
Each cause lists up to five episode refs; --episode prints one ref's transcript slice compactly.

Options:
  --harness <name>      codex, claude, or all (default: every root that exists).
  --root <path>         Codex sessions. Default: ~/.codex/sessions.
  --claude-root <path>  Claude Code projects. Default: ~/.claude_cliproxy/projects.
  --days <number>       Lookback in days. Default: 7.
  --since <date>        Start of the window; overrides --days.
  --cwd <path>          Only sessions whose working directory is this path or below it.
  --limit <number>      Causes to print. Default: 10.
  --baseline <file>     Earlier --save report; adds before -> after per cause.
  --save <file>         Write the full JSON report to this file.
  --episode <ref>       Print one episode slice (lines <from>-<to> of a session file) and exit.
  --json                Print the JSON report.
  --verbose             Longer outputs in --episode slices.`;

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(values: string[]): Map<string, string> {
  const flags = new Set(["help", "json", "verbose"]);
  const options = new Set([
    "harness",
    "root",
    "claude-root",
    "days",
    "since",
    "cwd",
    "limit",
    "baseline",
    "save",
    "episode",
  ]);
  const result = new Map<string, string>();
  for (let i = 0; i < values.length; i++) {
    const raw = values[i] === "-h" ? "--help" : values[i];
    if (!raw.startsWith("--")) die(`Unknown argument: ${raw}`);
    const [key, inline] = raw.slice(2).split("=", 2);
    if (flags.has(key)) {
      result.set(key, "true");
      continue;
    }
    if (!options.has(key)) die(`Unknown option: --${key}. See --help.`);
    const value = inline ?? values[++i];
    if (!value || value.startsWith("--")) die(`Option --${key} requires a value.`);
    result.set(key, value);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  console.log(HELP);
  process.exit(0);
}

const object = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number => (typeof value === "number" ? value : 0);
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const short = (value: string, max = 80): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const normalized = (path: string): string =>
  resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path).replace(/[\\/]+$/, "");
const display = (path: string): string =>
  home && path.startsWith(home)
    ? `~${path.slice(home.length).replace(/\\/g, "/")}`
    : path.replace(/\\/g, "/");
const outputText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => string(object(part).text))
          .filter(Boolean)
          .join("\n")
      : JSON.stringify(value ?? "");

async function* jsonLines(file: string): AsyncGenerator<{ event: Obj; line: number }> {
  const decoder = new TextDecoder();
  let pending = "",
    line = 0;
  const parse = (text: string): Obj | undefined => {
    try {
      return object(JSON.parse(text));
    } catch {
      return undefined;
    }
  };
  for await (const chunk of createReadStream(file)) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end >= 0) {
      line++;
      const event = parse(pending.slice(0, end));
      if (event) yield { event, line };
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
  const last = parse(pending + decoder.decode());
  if (last) yield { event: last, line: line + 1 };
}

// --episode: print one transcript slice as compact lines so a reader never loads a whole session.
function blockLines(content: unknown, role: string, max: number): string[] {
  if (typeof content === "string") return content.trim() ? [`${role}: ${short(content, max)}`] : [];
  const lines: string[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    const item = object(block);
    const text = string(item.text);
    if (
      (item.type === "text" || item.type === "input_text" || item.type === "output_text") &&
      text.trim()
    )
      lines.push(`${role}: ${short(text, max)}`);
    if (item.type === "tool_use") {
      const input = object(item.input);
      const subject =
        string(input.command) ||
        string(input.file_path) ||
        string(input.pattern) ||
        JSON.stringify(input);
      lines.push(`call ${string(item.name)}: ${short(subject, max)}`);
    }
    if (item.type === "tool_result")
      lines.push(
        `result${item.is_error ? " (error)" : ""}: ${short(outputText(item.content), max)}`,
      );
  }
  return lines;
}
function describe(event: Obj, max: number): string[] {
  const message = object(event.message);
  const payload = object(event.payload);
  const type = string(event.type);
  if (type === "user" || type === "assistant") return blockLines(message.content, type, max);
  if (type === "system" && event.subtype === "compact_boundary") return ["compaction"];
  if (type === "system" && event.subtype === "api_error")
    return [`api error: ${short(JSON.stringify(event.error ?? event.content ?? ""), max)}`];
  if (type === "compacted") return ["compaction"];
  if (type !== "response_item") return [];
  const kind = string(payload.type);
  if (kind === "message" && payload.role !== "developer")
    return blockLines(payload.content, string(payload.role), max);
  if (kind === "function_call" || kind === "custom_tool_call")
    return [
      `call ${string(payload.name)}: ${short(string(payload.arguments) || string(payload.input), max)}`,
    ];
  if (kind === "function_call_output" || kind === "custom_tool_call_output")
    return [`result: ${short(outputText(payload.output), max)}`];
  return [];
}
async function printEpisode(ref: string): Promise<void> {
  const match = ref.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!match) die(`--episode must look like <file>:<from>-<to>: ${ref}`);
  const file = normalized(match[1]);
  if (!existsSync(file)) die(`Session file not found: ${match[1]}`);
  const from = Number(match[2]);
  const to = Number(match[3] ?? match[2]);
  const max = args.has("verbose") ? 1500 : 300;
  console.log(`episode ${display(file)}:${from}-${to}`);
  for await (const { event, line } of jsonLines(file)) {
    if (line > to) break;
    if (line >= from) for (const text of describe(event, max)) console.log(`L${line} ${text}`);
  }
}
if (args.has("episode")) {
  await printEpisode(args.get("episode")!);
  process.exit(0);
}

const positive = (name: string, fallback: number): number => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) die(`--${name} must be a positive number.`);
  return value;
};
const days = positive("days", 7);
const limit = Math.floor(positive("limit", 10));
const since = args.has("since") ? Date.parse(args.get("since")!) : Date.now() - days * 86_400_000;
if (!Number.isFinite(since)) die(`--since must be a date: ${args.get("since")}`);
const codexRoot = args.get("root") || join(home, ".codex", "sessions");
const claudeRoot = args.get("claude-root") || join(home, ".claude_cliproxy", "projects");
const harness = args.get("harness");
if (harness && !["codex", "claude", "all"].includes(harness))
  die(`--harness must be codex, claude, or all: ${harness}`);
const wanted = (name: "codex" | "claude", root: string): boolean =>
  harness === name || harness === "all" || (!harness && existsSync(root));
const useCodex = wanted("codex", codexRoot);
const useClaude = wanted("claude", claudeRoot);
if (!useCodex && !useClaude) die(`No session roots found: ${codexRoot}, ${claudeRoot}`);
const cwdFilter = args.has("cwd") ? normalized(args.get("cwd")!) : "";

// Worktrees and clones of one repository count as one project.
function project(cwd: string): string {
  const path = cwd.replace(/\\/g, "/");
  const worktree =
    path.match(/\/\.t3\/worktrees\/([^/]+)/) || path.match(/\/PhpstormProjects\/([^/]+)/);
  return worktree ? worktree[1] : basename(path) || "(unknown)";
}

const searchBinaries = new Set([
  "grep",
  "rg",
  "find",
  "fd",
  "ls",
  "tree",
  "locate",
  "which",
  "ag",
  "Grep",
  "Glob",
  "LS",
]);
const readBinaries = new Set(["cat", "head", "tail", "sed", "less", "bat", "nl", "wc", "jq"]);
// Quick programs that never explain a slow or failing call, such as a trailing "; date".
const quickPrograms = [
  ..."date uptime pwd whoami basename dirname sort uniq cut tr break continue exit wait".split(" "),
  ..."status log diff rev-parse branch show".split(" ").map((sub) => `git ${sub}`),
];
const lookupBinaries = new Set([...searchBinaries, ...readBinaries, ...quickPrograms]);
const commandPrefixes = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
  "do",
  "then",
  "else",
]);
const subcommandBinaries = new Set(
  "adb agent-device asc aws brew bun bunx cargo claude codex composer docker eas expo gh git go mise my-setup npm npx php pnpm python python3 system-tools uv xcrun yarn merge-queue decisions doctor".split(
    " ",
  ),
);
const scriptRunners = new Set(["run", "exec", "x", "artisan"]);
const skipped = new Set(
  "cd pushd popd set true false source . export echo printf for while until if case done fi esac [ [[ { } local read mkdir rm sleep tee".split(
    " ",
  ),
);
// The program a shell line runs, with the subcommand for multi-command CLIs ("git push", "mise run check").
// Prefers the last program that is not just reading or searching: in "edit && check | tail" the check is what is slow or failing.
function commandLabel(raw: string): string {
  const labels = programLabels(raw);
  return (
    labels.findLast((label) => !lookupBinaries.has(label)) ||
    labels[0] ||
    short(raw, 40) ||
    "(shell)"
  );
}
// Heredoc bodies are data, not commands.
const withoutHeredocs = (raw: string): string =>
  raw.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\b/g, "$2");
function programLabels(raw: string): string[] {
  const labels: string[] = [];
  const statements = withoutHeredocs(raw)
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((part) => part.split("|")[0].trim())
    .filter(Boolean);
  for (const statement of statements) {
    const tokens = statement.split(/\s+/);
    // Older sessions wrapped commands in the retired `heavy-run --class checks -- <argv>`.
    if (tokens[0] === "heavy-run" && tokens.includes("--"))
      tokens.splice(0, tokens.indexOf("--") + 1);
    while (tokens.length && (commandPrefixes.has(tokens[0]) || /^[A-Za-z_]\w*=/.test(tokens[0])))
      tokens.shift();
    const binary =
      (tokens[0] || "")
        .replace(/^['"(]+/, "")
        .split("/")
        .pop() || "";
    if (!binary || skipped.has(binary) || !/^[A-Za-z0-9_.@+-]+$/.test(binary)) continue;
    if (binary === "cat" && tokens[1]?.startsWith(">")) continue;
    if (!subcommandBinaries.has(binary)) {
      labels.push(binary);
      continue;
    }
    const rest = tokens.slice(1).filter((token) => !token.startsWith("-") && !/^\d+$/.test(token));
    const sub = rest[0] && /^[\w:.-]+$/.test(rest[0]) ? rest[0] : "";
    const script =
      scriptRunners.has(sub) && rest[1] && /^[\w:.-]+$/.test(rest[1]) ? ` ${rest[1]}` : "";
    labels.push(sub ? `${binary} ${sub}${script}` : binary);
  }
  return labels;
}

// The first line that explains a failure, with paths, ids, and numbers stripped so the same error groups across sessions.
const noise =
  /^(Exit code -?\d+|Script (failed|completed)\b.*|Wall time\b.*|Chunk ID\b.*|Original token count\b.*|Output:)$/i;
// Error lines, not file content a compound command printed before it failed.
const explains =
  /^(\S+:\s*)?(error|fatal|fail(ed|ure)?|panic)\b|\b\w*(Error|Exception)\b:|\bnot found\b|no such|denied|invalid|cannot|can't|unable to|refused|blocked|unknown (option|command|flag|argument)|no matches found|parse error|^\(fail\)|\bN? ?fail\b/i;
// The last line that explains a failure (summaries come last), with paths, ids, and numbers stripped so the same error groups
// across sessions. Without one, the cause is the command alone.
function errorMessage(output: string): string {
  const lines = output
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => /[A-Za-z]/.test(line) && !noise.test(line) && !line.startsWith('{"chunk_id"'),
    );
  const line = lines.findLast((item) => explains.test(item)) || "";
  return short(
    line
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
      .replace(/(?<![\w.-])(?:~|\.{1,2})?\/[^\s'"`:,()\]]+/g, "<path>")
      .replace(/(?<![\w.<>-])[\w.-]+(?:\/[\w.-]+)+/g, "<path>")
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<id>")
      .replace(/\d+(?:\.\d+)?/g, "N")
      // zsh names the word it choked on: "no matches found: --include=*.ts".
      .replace(/^\(eval\):N: (no matches found|parse error near|command not found)\b.*$/, "zsh: $1")
      .replace(/^\(eval\):N: =+ not found$/, "zsh: unquoted = word not found"),
    90,
  );
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...walk(path, accept));
    else if (accept(entry) && stat.mtimeMs >= since) found.push(path);
  }
  return found.sort();
}

// Forked and resumed transcripts copy earlier calls; count each call once.
const seenCalls = new Set<string>();
const newSession = (file: string, harness: "claude" | "codex", subagent: boolean): Session => ({
  file,
  harness,
  cwd: "",
  subagent,
  calls: [],
  compactions: [],
  requests: [],
  turnTokens: [],
  startupTokens: 0,
});

async function readClaude(file: string): Promise<Session> {
  const session = newSession(file, "claude", file.split(sep).includes("subagents"));
  const open = new Map<string, Call>();
  let previous = 0,
    inputAt = 0,
    request: { id: string; model: string; start: number; end: number } | undefined;
  const closeRequest = () => {
    if (request)
      session.requests.push({
        model: request.model,
        start: request.start,
        ms: request.end - request.start,
      });
    request = undefined;
  };
  let messageId = "";
  for await (const { event, line } of jsonLines(file)) {
    const at = time(event.timestamp);
    if (!at) continue;
    session.cwd ||= string(event.cwd);
    const message = object(event.message);
    const type = string(event.type);
    if (type === "assistant" && message.model !== "<synthetic>") {
      const id = string(message.id);
      // Each model request is one turn; its context size is what every wasted turn costs.
      if (id !== messageId) {
        const usage = object(message.usage);
        const context =
          number(usage.input_tokens) +
          number(usage.cache_read_input_tokens) +
          number(usage.cache_creation_input_tokens);
        session.startupTokens ||= context;
        session.turnTokens.push(context);
        messageId = id;
      }
      if (request?.id !== id) {
        closeRequest();
        if (inputAt && at >= since)
          request = { id, model: string(message.model) || "(unknown)", start: inputAt, end: at };
        inputAt = 0;
      } else request.end = at;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = object(block);
        if (item.type !== "tool_use" || !string(item.id) || at < since) continue;
        const tool = string(item.name);
        const input = object(item.input);
        const command = tool === "Bash" ? string(input.command) : "";
        const path = string(input.file_path) || string(input.notebook_path) || string(input.path);
        const label =
          tool === "Bash"
            ? commandLabel(command)
            : tool === "Read" && (input.offset || input.limit)
              ? `Read ${path}@${input.offset ?? ""}:${input.limit ?? ""}`
              : tool;
        const turn = session.turnTokens.length - 1;
        open.set(string(item.id), {
          id: string(item.id),
          tool,
          label,
          command,
          path,
          start: at,
          end: at,
          output: "",
          error: false,
          turn,
          line,
          endLine: line,
        });
      }
    } else if (type === "user") {
      closeRequest();
      inputAt = at;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const item = object(block);
        const call = open.get(string(item.tool_use_id));
        if (item.type !== "tool_result" || !call) continue;
        open.delete(call.id);
        call.end = at;
        call.endLine = line;
        call.output = outputText(item.content);
        call.error = item.is_error === true;
        session.calls.push(call);
      }
    } else if (type === "system") {
      closeRequest();
      const subtype = string(event.subtype);
      const turn = Math.max(0, session.turnTokens.length - 1);
      if (subtype === "compact_boundary" && at >= since && previous)
        session.compactions.push({ at, ms: at - previous, line, turn });
      if (subtype === "api_error" && at >= since) {
        const output = short(outputText(event.content) || JSON.stringify(event.error ?? ""), 200);
        session.calls.push({
          id: string(event.uuid),
          tool: "API",
          label: "API error",
          command: "",
          path: "",
          start: at,
          end: at,
          output,
          error: true,
          turn,
          line,
          endLine: line,
        });
      }
    }
    previous = at;
  }
  closeRequest();
  return session;
}

const exitCodes = /"exit_code"\s*:\s*(-?\d+)|Process exited with code (-?\d+)/g;
async function readCodex(file: string): Promise<Session> {
  const session = newSession(file, "codex", false);
  const open = new Map<string, Call & { commands: string[] }>();
  let previous = 0,
    inputAt = 0,
    model = "(unknown)",
    turnOpen = false;
  for await (const { event, line } of jsonLines(file)) {
    const at = time(event.timestamp);
    if (!at) continue;
    const payload = object(event.payload);
    const type = string(payload.type);
    const turn = Math.max(0, session.turnTokens.length - 1);
    if (event.type === "session_meta") {
      session.cwd ||= string(payload.cwd);
      session.subagent = Boolean(payload.forked_from_id || object(payload.source).subagent);
    }
    if (event.type === "turn_context") model = string(payload.model) || model;
    if (event.type === "compacted" && at >= since && previous)
      session.compactions.push({ at, ms: at - previous, line, turn });
    if (event.type === "event_msg" && type === "token_count") {
      const context = number(object(object(payload.info).last_token_usage).input_tokens);
      session.startupTokens ||= context;
      if (session.turnTokens.length) session.turnTokens[session.turnTokens.length - 1] ||= context;
    }
    if (event.type === "response_item") {
      const isCall = type === "function_call" || type === "custom_tool_call";
      const isModel =
        isCall || type === "reasoning" || (type === "message" && payload.role === "assistant");
      // A model item after new input starts a turn; several items of one response share it.
      if (isModel && !turnOpen) {
        session.turnTokens.push(0);
        turnOpen = true;
      }
      if (isModel && inputAt && at >= since)
        session.requests.push({ model, start: inputAt, ms: at - inputAt });
      if (isModel) inputAt = 0;
      if (type === "message" && payload.role === "user") {
        inputAt = at;
        turnOpen = false;
      }
      if (isCall && at >= since) {
        const name = string(payload.name);
        const source = string(payload.arguments) || string(payload.input);
        const leaf = name.split(/[.:/]/).pop() || name;
        let commands: string[] = [];
        if (leaf === "exec_command")
          try {
            commands = [string(object(JSON.parse(source)).cmd)];
          } catch {
            commands = [];
          }
        else if (leaf === "exec")
          for (const match of source.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g))
            try {
              commands.push(JSON.parse(match[1]) as string);
            } catch {
              commands.push(match[1].slice(1, -1));
            }
        const id = string(payload.call_id) || string(payload.id);
        const command = commands[0] || "";
        const label = commands.length ? commandLabel(command) : name;
        const callTurn = session.turnTokens.length - 1;
        open.set(id, {
          id,
          tool: commands.length ? "Bash" : name,
          label,
          command,
          path: "",
          start: at,
          end: at,
          output: "",
          error: false,
          turn: callTurn,
          line,
          endLine: line,
          commands,
        });
      }
      if (type === "function_call_output" || type === "custom_tool_call_output") {
        inputAt = at;
        turnOpen = false;
        const id = string(payload.call_id) || string(payload.id);
        const call = open.get(id);
        if (!call) continue;
        open.delete(id);
        call.end = at;
        call.endLine = line;
        call.output = outputText(payload.output);
        const codes = [...call.output.matchAll(exitCodes)].map((match) =>
          Number(match[1] ?? match[2]),
        );
        const failed = codes.findIndex((code) => code !== 0);
        call.error =
          failed >= 0 ||
          object(payload.output).isError === true ||
          /^Script failed/m.test(call.output);
        // A wrapper runs several commands; blame the one that failed.
        if (failed >= 0 && call.commands[failed]) {
          call.command = call.commands[failed];
          call.label = commandLabel(call.command);
        }
        // Each wrapped command reports a JSON chunk; keep the failing command's own output.
        const chunks = call.output.split("\n").filter((text) => text.startsWith('{"chunk_id"'));
        if (failed >= 0 && chunks[failed])
          try {
            call.output =
              `Exit code ${codes[failed]}\n${string(object(JSON.parse(chunks[failed])).output)}`.trim();
          } catch {
            // Keep the whole wrapper output when a chunk is not valid JSON.
          }
        const { commands: _, ...plain } = call;
        session.calls.push(plain);
      }
    }
    previous = at;
  }
  return session;
}

const shells = new Set(["zsh", "bash", "sh", "eval", "(eval)"]);
const userWait = /(^|[._/])(AskUserQuestion|ExitPlanMode|request_user_input\w*)$/;
// Waiting on purpose, or tools whose duration only reflects a parallel batch they shared.
const notSlow =
  /^(Agent|Task|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|TodoWrite)$|wait$|_wait|delegate|spawn_agent/i;
// Slow because the work is real: checks, builds, tests, QA, installs, deploys.
const legitimateWork =
  /\b(check|checks|signoff|premerge|test|tests|pest|phpunit|vitest|jest|lint|typecheck|tsc|build|qa|e2e|maestro|xcodebuild|gradlew|eas|install|deploy|heavy-run|merge-queue)\b/i;
const pollLoop = /(^|[\s;&|(])(sleep\s+\d|until\s|while\s+(true|:))|\s--watch\b/;
const helpCall = /(^|\s)--help(\s|$)|^\S+(\s+[\w:-]+)?\s+(help|-h|usage)\s*$/;
const notFound =
  /No such file or directory|File does not exist|Path does not exist|does not exist\b|ENOENT|cannot find the path/i;
// zsh prints "command not found: x", bash "x: command not found"; try zsh first.
const commandMissing = [
  /command not found:\s*([\w.@+-]+)/i,
  /([\w.@+-]+): command not found/i,
  /executable file not found[^\n]*?"([\w.@+-]+)"/i,
];
const emptyResult = /^(?:No matches found|No files found|Exit code 1|\s*)$/;
const userRejected =
  /The user doesn't want to|user (?:rejected|denied)|Request interrupted by user|tool call was interrupted/i;
const SLOW_TOOL_MS = 60_000;
const SLOW_MODEL_MS = 120_000;
const RECOVERY_CAP_MS = 5 * 60_000;
const STALL_MS = 2 * 3_600_000;
// An error episode runs from the failure through the retries and lookups that follow, until the first call that moves on.
const EPISODE_MAX_CALLS = 12;
// Episode refs start a few lines early so the reader sees what the agent meant to do.
const CONTEXT_LINES = 4;
const EPISODES_PER_CAUSE = 5;

const subjectOf = (call: Call): string => call.command || call.path || call.tool;
const evidence = (subject: string, output: string): string =>
  `${short(subject, 60)} -> ${short(output, 58)}`;

// Screenshots and logs are overwritten or grow between reads, so reading them again is not a re-read.
const changing = /\.(png|jpe?g|gif|webp|log|out)(@|$)/i;
function readTarget(call: Call): string {
  const target =
    call.tool === "Read"
      ? call.label.startsWith("Read ")
        ? call.label.slice(5)
        : call.path
      : call.tool === "Bash" &&
          readBinaries.has(call.label) &&
          call.command.trim().split(/\s+/).length <= 4 &&
          !/[|;&<>]/.test(call.command)
        ? call.command.trim().split(/\s+/).pop()!
        : "";
  return changing.test(target) ? "" : target;
}

function failureCause(call: Call, empty: boolean, where: string): [Category, string] {
  const missing = commandMissing.map((pattern) => call.output.match(pattern)).find(Boolean);
  const program = missing?.[1];
  if (missing)
    return [
      "not-finding",
      `command not found: ${program && !shells.has(program) ? program : call.label}`,
    ];
  if (notFound.test(call.output.slice(0, 500)))
    return [
      "not-finding",
      `missing path: ${call.label}${call.path ? ` in ${display(dirname(call.path))}` : ""}`,
    ];
  if (empty) return ["not-finding", `${call.label} empty result (${where})`];
  if (/hook (error|blocked)|blocked by hook|PreToolUse/i.test(call.output.slice(0, 300))) {
    const guard = call.output.match(/\[([^\]\s]+)/)?.[1];
    return ["errors", `hook refusal: ${guard ? basename(guard) : "unknown hook"}`];
  }
  const code = call.output.match(/"code"\s*:\s*"(\w+)"/)?.[1];
  if (code) return ["errors", `${call.label} failed: ${code}`];
  if (/Invalid parameters|InputValidationError/i.test(call.output))
    return ["errors", `${call.label} failed: invalid parameters`];
  const message = errorMessage(call.output);
  // The shell refused the line before any program ran, so the program is not the cause.
  if (message.startsWith("zsh: ")) return ["errors", `shell error: ${message}`];
  return [
    "errors",
    `${call.tool === "API" ? "API error" : `${call.label} failed`}${message ? `: ${message}` : ""}`,
  ];
}

type Wait = { label: string; ms: number };
// Turns one session's calls into friction episodes and legitimate waits.
function detect(
  session: Session,
  parentReads: Map<string, number> | undefined,
): { friction: Friction[]; waits: Wait[] } {
  const friction: Friction[] = [];
  const waits: Wait[] = [];
  const where = project(session.cwd);
  const calls = session.calls
    .filter((call) => !userWait.test(call.tool))
    .sort((a, b) => a.start - b.start);
  const reads = new Map<string, number>();
  const compactions = session.compactions.map((item) => item.at);
  const tokensOf = (turns: Set<number>) =>
    [...turns].reduce((sum, turn) => sum + (session.turnTokens[turn] ?? 0), 0);
  const refOf = (first: number, last: number) =>
    `${display(session.file)}:${Math.max(1, first - CONTEXT_LINES)}-${Math.max(first, last)}`;
  const add = (
    category: Category,
    cause: string,
    wasted: Call[],
    lostMs: number,
    detail: string,
    options: { retries?: number; first?: Call; end?: Call; noTurns?: boolean } = {},
  ) => {
    const turns = new Set(options.noTurns ? [] : wasted.map((call) => call.turn));
    const first = options.first ?? wasted[0];
    const end = options.end ?? wasted[wasted.length - 1];
    friction.push({
      category,
      cause,
      turns: turns.size,
      tokens: tokensOf(turns),
      lostMs,
      retries: options.retries ?? 0,
      file: session.file,
      ref: refOf(first.line, end.endLine),
      detail: short(detail, 120),
    });
  };
  const info = calls.map((call) => {
    const isSearch =
      (searchBinaries.has(call.label) || searchBinaries.has(call.tool)) &&
      !/\s-[ABC]\s?\d/.test(call.command);
    const isHelp = call.tool === "Bash" && helpCall.test(call.command.split("\n")[0]);
    const empty = isSearch && emptyResult.test(call.output.trim());
    const ignored =
      call.end - call.start > STALL_MS || userRejected.test(call.output.slice(0, 200));
    return {
      isSearch,
      isHelp,
      empty,
      ignored,
      failed: !ignored && (call.error || empty),
      lookup: isSearch || isHelp || Boolean(readTarget(call)),
    };
  });
  const stepOf = (index: number) => {
    const call = calls[index];
    const ms = call.end - call.start;
    const next = calls.slice(index + 1).find((item) => item.start > call.start);
    return Math.max(ms, Math.min(next ? next.start - call.start : ms, ms + RECOVERY_CAP_MS));
  };
  const trackRead = (call: Call): string => {
    if (call.tool === "Edit" || call.tool === "Write") reads.delete(call.path);
    return readTarget(call);
  };
  let chain: number[] = [];
  const flushChain = (end?: Call) => {
    // A subagent is often sent to search, so its chains are the work; its errors still count.
    if (chain.length >= 3 && !session.subagent) {
      const wasted = chain.slice(1).map((index) => calls[index]);
      const lost = chain.slice(1).reduce((sum, index) => sum + stepOf(index), 0);
      const tried = chain.map((index) => short(subjectOf(calls[index]), 40)).join(" | ");
      add("searching", `search chain before first read (${where})`, wasted, lost, tried, {
        first: calls[chain[0]],
        end,
      });
    }
    chain = [];
  };
  let consumedUntil = -1;

  for (const [index, call] of calls.entries()) {
    const ms = call.end - call.start;
    const subject = subjectOf(call);
    const { isSearch, isHelp, empty, ignored, failed } = info[index];
    if (ignored) continue;
    if (index <= consumedUntil) {
      const target = trackRead(call);
      if (target) reads.set(target, call.start);
      continue;
    }

    if (failed) {
      flushChain();
      let stop = index + 1;
      while (
        stop < calls.length &&
        stop - index < EPISODE_MAX_CALLS &&
        (info[stop].failed || info[stop].lookup || info[stop].ignored)
      )
        stop++;
      consumedUntil = stop - 1;
      const wasted = calls.slice(index, stop);
      const recovery = calls[stop];
      const last = wasted[wasted.length - 1];
      const lostMs = Math.max(
        ms,
        Math.min(recovery ? recovery.start : last.end, last.end + RECOVERY_CAP_MS) - call.start,
      );
      const retries = wasted
        .slice(1)
        .filter(
          (item, offset) => info[index + 1 + offset].failed && subjectOf(item) === subject,
        ).length;
      const [category, cause] = failureCause(call, empty, where);
      add(category, cause, wasted, lostMs, evidence(subject, call.output), {
        retries,
        end: recovery,
      });
      continue;
    }

    if (call.tool === "Bash" && pollLoop.test(withoutHeredocs(call.command))) {
      flushChain();
      add("slowness", `polling: ${call.label}`, [call], ms, subject, { noTurns: true });
      continue;
    }
    if (ms >= SLOW_TOOL_MS && !notSlow.test(call.tool)) {
      flushChain();
      if (legitimateWork.test(`${call.label} ${withoutHeredocs(call.command)}`))
        waits.push({ label: call.label, ms });
      else add("slowness", `slow tool: ${call.label}`, [call], ms, subject, { noTurns: true });
      continue;
    }
    if (isHelp) {
      add("searching", `help lookup: ${call.label}`, [call], stepOf(index), subject);
      chain.push(index);
      continue;
    }
    if (isSearch) {
      chain.push(index);
      continue;
    }
    flushChain(call);

    const target = trackRead(call);
    if (!target) continue;
    const previous = reads.get(target);
    reads.set(target, call.start);
    if (previous !== undefined) {
      const compacted = compactions.some((at) => at > previous && at < call.start);
      add(
        compacted ? "wasted-work" : "searching",
        `re-read ${compacted ? "after compaction" : "same file"} (${where})`,
        [call],
        stepOf(index),
        display(target),
      );
    } else if (
      session.subagent &&
      parentReads?.has(target) &&
      parentReads.get(target)! < (calls[0]?.start ?? 0)
    )
      add(
        "wasted-work",
        `subagent re-read parent's files (${where})`,
        [call],
        stepOf(index),
        display(target),
      );
  }
  flushChain();

  for (const item of session.compactions)
    if (item.ms < STALL_MS)
      friction.push({
        category: "wasted-work",
        cause: `compaction (${session.harness})`,
        turns: 1,
        tokens: session.turnTokens[item.turn] ?? 0,
        lostMs: item.ms,
        retries: 0,
        file: session.file,
        ref: refOf(item.line, item.line + CONTEXT_LINES),
        detail: `compaction at ${new Date(item.at).toISOString()}`,
      });
  for (const request of session.requests)
    if (request.ms >= SLOW_MODEL_MS && request.ms < STALL_MS)
      waits.push({ label: `model response: ${request.model}`, ms: request.ms });
  return { friction, waits };
}

function median(values: number[]): number {
  const sorted = values.filter(Boolean).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
function amount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

const inWindow = (session: Session): boolean =>
  !cwdFilter ||
  (Boolean(session.cwd) &&
    (normalized(session.cwd) === cwdFilter || normalized(session.cwd).startsWith(cwdFilter + sep)));
const sessions: Session[] = [];
const events: Friction[] = [];
const waits: Wait[] = [];
const ingest = (session: Session, parentReads?: Map<string, number>) => {
  session.calls = session.calls.filter((call) => {
    const key = `${session.harness}:${call.id}`;
    if (call.id && seenCalls.has(key)) return false;
    seenCalls.add(key);
    return true;
  });
  if (
    !inWindow(session) ||
    (!session.calls.length && !session.requests.length && !session.compactions.length)
  )
    return;
  sessions.push(session);
  const found = detect(session, parentReads);
  events.push(...found.friction);
  waits.push(...found.waits);
};

if (useClaude) {
  if (!existsSync(claudeRoot)) die(`Claude projects directory not found: ${claudeRoot}`);
  // Sorted paths put <id>.jsonl before its <id>/subagents/ transcripts.
  const parents = new Map<string, Map<string, number>>();
  for (const file of walk(claudeRoot, (name) => name.endsWith(".jsonl"))) {
    const session = await readClaude(file);
    const parentKey = session.subagent
      ? file.slice(0, file.lastIndexOf(`${sep}subagents${sep}`))
      : file.replace(/\.jsonl$/, "");
    if (!session.subagent) {
      const reads = new Map<string, number>();
      for (const call of session.calls) {
        const target = readTarget(call);
        if (target && !reads.has(target)) reads.set(target, call.start);
      }
      parents.set(parentKey, reads);
    }
    ingest(session, session.subagent ? parents.get(parentKey) : undefined);
  }
}
if (useCodex) {
  if (!existsSync(codexRoot)) die(`Codex sessions directory not found: ${codexRoot}`);
  for (const file of walk(
    codexRoot,
    (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  ))
    ingest(await readCodex(file));
}

const byWaste = (a: Totals, b: Totals) =>
  b.turns - a.turns || b.tokens - a.tokens || b.lostMs - a.lostMs || b.count - a.count;
const grouped = new Map<string, Friction[]>();
for (const event of events) {
  const key = `${event.category}|${event.cause}`;
  grouped.set(key, [...(grouped.get(key) ?? []), event]);
}
const baseline = new Map<string, Cause>();
if (args.has("baseline") && existsSync(normalized(args.get("baseline")!))) {
  try {
    // Reports from before turn counting rank a different way, so they cannot judge this run.
    for (const item of JSON.parse(readFileSync(normalized(args.get("baseline")!), "utf8"))
      .causes as Cause[])
      if (typeof item.turns === "number") baseline.set(item.key, item);
  } catch {
    die(`--baseline is not a saved analyze-sessions report: ${args.get("baseline")}`);
  }
}
const sum = (list: Friction[]): Totals => ({
  count: list.length,
  turns: list.reduce((total, item) => total + item.turns, 0),
  tokens: list.reduce((total, item) => total + item.tokens, 0),
  lostMs: list.reduce((total, item) => total + item.lostMs, 0),
});
// The costliest episodes first, one per session before a second from the same session.
function pickEpisodes(list: Friction[]): Episode[] {
  const sorted = [...list].sort((a, b) => b.turns - a.turns || b.lostMs - a.lostMs);
  const firsts = sorted.filter(
    (item, index) => sorted.findIndex((other) => other.file === item.file) === index,
  );
  const picked = [...firsts, ...sorted.filter((item) => !firsts.includes(item))].slice(
    0,
    EPISODES_PER_CAUSE,
  );
  return picked.map((item) => ({ ref: item.ref, turns: item.turns, detail: item.detail }));
}
const ranked: Cause[] = [...grouped.entries()]
  .map(([key, list]) => {
    const old = baseline.get(key);
    return {
      key,
      category: list[0].category,
      cause: list[0].cause,
      ...sum(list),
      sessions: new Set(list.map((item) => item.file)).size,
      retries: list.reduce((total, item) => total + item.retries, 0),
      episodes: pickEpisodes(list),
      ...(baseline.size
        ? { before: { count: old?.count ?? 0, turns: old?.turns ?? 0, lostMs: old?.lostMs ?? 0 } }
        : {}),
    };
  })
  .sort(byWaste);
const categories = [...new Set(events.map((event) => event.category))]
  .map((category) => ({ category, ...sum(events.filter((event) => event.category === category)) }))
  .sort(byWaste);
const waitTotals = new Map<string, { label: string; count: number; lostMs: number }>();
for (const wait of waits) {
  const total = waitTotals.get(wait.label) ?? { label: wait.label, count: 0, lostMs: 0 };
  total.count++;
  total.lostMs += wait.ms;
  waitTotals.set(wait.label, total);
}
const waiting = [...waitTotals.values()].sort((a, b) => b.lostMs - a.lostMs);
const startup = {
  claude: median(
    sessions.filter((s) => s.harness === "claude" && !s.subagent).map((s) => s.startupTokens),
  ),
  codex: median(sessions.filter((s) => s.harness === "codex").map((s) => s.startupTokens)),
};
const gone = [...baseline.values()]
  .filter((item) => !grouped.has(item.key))
  .sort(byWaste)
  .slice(0, limit);
const report = {
  window: {
    since: new Date(since).toISOString(),
    harnesses: [useClaude && "claude", useCodex && "codex"].filter(Boolean),
    cwd: cwdFilter || null,
  },
  sessions: sessions.length,
  friction: sum(events),
  waitingMs: waits.reduce((total, wait) => total + wait.ms, 0),
  startupTokensMedian: startup,
  categories,
  causes: ranked,
  waiting,
  gone: gone.map((item) => ({
    key: item.key,
    before: { count: item.count, turns: item.turns ?? 0, lostMs: item.lostMs },
  })),
};
if (args.has("save")) {
  const target = normalized(args.get("save")!);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}
if (args.has("json")) {
  console.log(
    JSON.stringify(
      { ...report, causes: ranked.slice(0, limit), waiting: waiting.slice(0, limit) },
      null,
      2,
    ),
  );
  process.exit(0);
}

const cost = (item: Totals) =>
  `${item.turns} turns ${amount(item.tokens)} tok ${duration(item.lostMs)}`;
console.log(
  `analyze-sessions: ${sessions.length} sessions since ${report.window.since.slice(0, 10)}; friction ${report.friction.count} episodes, ${cost(report.friction)}; waiting on work ${duration(report.waitingMs)} (not ranked); startup prompt median claude ${amount(startup.claude)}, codex ${amount(startup.codex)} tokens`,
);
console.log(
  `by category: ${categories.map((item) => `${item.category} ${cost(item)}`).join("; ")}`,
);
for (const [index, cause] of ranked.slice(0, limit).entries()) {
  const before = cause.before
    ? ` (before ${cause.before.turns} turns ${cause.before.count}x ${duration(cause.before.lostMs)})`
    : "";
  const retries = cause.retries ? ` ${cause.retries} retries` : "";
  console.log(
    `${index + 1}. ${cost(cause)} ${cause.count}x ${cause.sessions} sessions${retries} [${cause.category}] ${cause.cause}${before}`,
  );
  for (const episode of cause.episodes)
    console.log(`   ${episode.ref} ${episode.turns}t ${episode.detail}`);
}
for (const item of waiting.slice(0, 5))
  console.log(`waiting: ${item.label} ${duration(item.lostMs)} ${item.count}x`);
for (const item of gone)
  console.log(
    `gone: ${item.key} (before ${item.turns ?? 0} turns ${item.count}x ${duration(item.lostMs)})`,
  );
