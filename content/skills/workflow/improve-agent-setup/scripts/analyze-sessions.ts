#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";

type Obj = Record<string, unknown>;
type Usage = { input: number; cached: number; output: number };
type Call = { name: string; label: string; declared: number; commands: string[] };
type Command = {
  command: string;
  outputs: number;
  bytes: number;
  originalTokens: number;
  truncated: number;
  declared: number;
};
type Session = {
  file: string;
  id: string;
  cwd: string;
  bytes: number;
  lines: number;
  parsed: number;
  malformed: number;
  unknown: number;
  createdAt: number;
  firstActivity: number;
  lastActivity: number;
  status: "created" | "resumed" | "unknown";
  usageMode: "cumulative" | "last-only" | "none";
  forked: boolean;
  forkSource: "" | "subagent" | "forked-thread" | "parent-thread" | "history-base";
  parentId: string;
  forkBaselineInput: number;
  tokenEvents: number;
  firstInput: number;
  maxInput: number;
  totalInput: number;
  cachedInput: number;
  totalOutput: number;
  compactions: number;
  baseInstructionBytes: number;
  turnContextInstructionBytes: number;
  injectedUserMessages: number;
  injectedUserBytes: number;
  humanRequests: number;
  firstUserMessage: string;
  imageMessages: number;
  imageBytes: number;
  toolOutputs: number;
  execOutputs: number;
  largeExecOutputs: number;
  truncatedOutputs: number;
  unmatchedToolOutputs: number;
};
type Tree = {
  rootId: string;
  title: string;
  cwd: string;
  sessions: number;
  descendants: number;
  forkedSessions: number;
  maxDepth: number;
  totalInput: number;
  repeatedRootRequest: number;
  highStartupDescendants: number;
  incomplete: boolean;
};
type ClaudeTool = {
  tool: string;
  label: string;
  outputs: number;
  bytes: number;
  maxBytes: number;
  truncated: number;
};
type ClaudeSession = {
  file: string;
  project: string;
  id: string;
  agentId: string;
  cwd: string;
  sidechain: boolean;
  parentId: string;
  bytes: number;
  lines: number;
  parsed: number;
  malformed: number;
  createdAt: number;
  firstActivity: number;
  lastActivity: number;
  status: "created" | "resumed" | "unknown";
  models: string[];
  requests: number;
  firstInput: number;
  maxInput: number;
  totalInput: number;
  cachedInput: number;
  cacheWriteInput: number;
  totalOutput: number;
  compactions: number;
  compactedPreTokens: number;
  apiErrors: number;
  humanRequests: number;
  firstUserMessage: string;
  injectedUserMessages: number;
  injectedUserBytes: number;
  attachments: number;
  attachmentBytes: number;
  imageMessages: number;
  imageBytes: number;
  toolOutputs: number;
  toolOutputBytes: number;
  largestToolOutput: number;
  unmatchedToolOutputs: number;
};
type ClaudeTree = {
  sessionId: string;
  project: string;
  title: string;
  mainInput: number;
  subagentInput: number;
  subagents: number;
  totalInput: number;
};

const home = process.env.HOME || "";
function die(message: string): never {
  console.error(message);
  process.exit(2);
}
function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>(),
    flags = new Set(["help", "h", "json"]);
  const options = new Set([
    "root",
    "claude-root",
    "harness",
    "days",
    "limit",
    "cwd",
    "since",
    "since-mtime",
    "state-db",
  ]);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw === "-h") {
      result.set("h", "true");
      continue;
    }
    if (!raw.startsWith("--")) die(`Unknown argument: ${raw}`);
    const [key, inline] = raw.slice(2).split("=", 2);
    if (flags.has(key)) {
      if (inline !== undefined) die(`Option --${key} does not accept a value.`);
      result.set(key, "true");
      continue;
    }
    if (!options.has(key)) die(`Unknown option: --${key}`);
    const value = inline ?? values[++i];
    if (!value || value.startsWith("--")) die(`Option --${key} requires a value.`);
    result.set(key, value);
  }
  return result;
}
const args = parseArgs(process.argv.slice(2));
if (args.has("help") || args.has("h")) {
  console.log(`Usage:
  analyze-sessions.ts [options]

Audits recorded agent sessions for context waste. Covers Codex rollouts and
Claude Code transcripts.

Options:
  --harness <name>      codex, claude, or all. Default: every root that exists,
                        or only the harness whose root was passed explicitly.
  --root <path>         Codex session root. Default: ~/.codex/sessions.
  --claude-root <path>  Claude Code project root. Default: ~/.claude/projects.
  --days <number>       Event-time lookback when --since is absent. Default: 14.
  --limit <number>      Maximum ranked items per section. Default: 12.
  --cwd <path>          Include only sessions for this working directory.
  --since <date>        Include activity at or after this event timestamp.
  --since-mtime <time>  Diagnostic file prefilter using an epoch timestamp.
  --state-db <path>     Codex state database. Default: ~/.codex/state_5.sqlite.
  --json                Emit machine-readable output.`);
  process.exit(0);
}
function positive(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) die(`${option} must be a positive number.`);
  return number;
}
function epoch(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) die(`${option} must be a valid epoch timestamp.`);
  return number > 10_000_000_000 ? number : number * 1000;
}
const root = args.get("root") || join(home, ".codex", "sessions");
const claudeRoot = args.get("claude-root") || join(home, ".claude", "projects");
const requestedHarness = args.get("harness");
if (requestedHarness && !["codex", "claude", "all"].includes(requestedHarness))
  die(`--harness must be codex, claude, or all: ${requestedHarness}`);
const harnesses = new Set<"codex" | "claude">(
  requestedHarness === "codex" || requestedHarness === "claude"
    ? [requestedHarness]
    : requestedHarness === "all"
      ? ["codex", "claude"]
      : args.has("root") && !args.has("claude-root")
        ? ["codex"]
        : args.has("claude-root") && !args.has("root")
          ? ["claude"]
          : [
              ...(existsSync(root) ? (["codex"] as const) : []),
              ...(existsSync(claudeRoot) ? (["claude"] as const) : []),
            ],
);
if (!harnesses.size) die(`No session roots found: ${root} and ${claudeRoot} are both missing.`);
const days = positive(args.get("days") || "14", "--days");
const limit = positive(args.get("limit") || "12", "--limit");
const since = args.has("since") ? Date.parse(args.get("since")!) : Date.now() - days * 86_400_000;
if (!Number.isFinite(since)) die(`--since must be a valid date: ${args.get("since")}`);
const sinceMtime = args.has("since-mtime")
  ? epoch(args.get("since-mtime")!, "--since-mtime")
  : undefined;
const cwdFilter = args.get("cwd");
const stateDb = args.get("state-db") || join(home, ".codex", "state_5.sqlite");

const object = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number => (typeof value === "number" ? value : 0);
const bytes = (value: unknown): number =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? ""));
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const getUsage = (value: unknown): Usage => {
  const item = object(value);
  return {
    input: number(item.input_tokens),
    cached: number(item.cached_input_tokens),
    output: number(item.output_tokens),
  };
};
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => string(object(part).text) || string(object(part).input_text))
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";
const short = (value: string, max = 72): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
};
const normalizedPath = (value: string): string =>
  resolve(value.startsWith("~/") ? join(home, value.slice(2)) : value).replace(/\/+$/, "");
const displayPath = (value: string): string =>
  home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;

function walk(dir: string, accept: (entry: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry),
      stat = statSync(path);
    if (stat.isDirectory()) found.push(...walk(path, accept));
    else if (accept(entry) && (sinceMtime === undefined || stat.mtimeMs >= sinceMtime))
      found.push(path);
  }
  return found.sort();
}
async function* lines(file: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of createReadStream(file)) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}
const injectedBlocks =
  /<(recommended_plugins|app-context|environment_context|skills_instructions|permissions instructions|apps_instructions|plugins_instructions|system-reminder|local-command-stdout)>[\s\S]*?<\/\1>/gi;
function classify(message: string): { human: string; injected: boolean; injectedBytes: number } {
  let human = message.replace(injectedBlocks, "").trim();
  human = human
    .replace(
      /^# AGENTS\.md instructions for [^\n]+\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i,
      "",
    )
    .trim();
  const injected = human !== message.trim();
  return {
    human,
    injected,
    injectedBytes: injected ? Math.max(0, bytes(message) - bytes(human)) : 0,
  };
}
const subcommandBinaries = new Set([
  "adb",
  "agent-browser",
  "agent-device",
  "artisan",
  "aws",
  "brew",
  "bun",
  "bunx",
  "cargo",
  "claude",
  "codex",
  "composer",
  "ddev",
  "deno",
  "docker",
  "eas",
  "expo",
  "flutter",
  "gcloud",
  "gh",
  "git",
  "go",
  "knowledge",
  "kubectl",
  "maestro",
  "make",
  "mise",
  "my-setup",
  "node",
  "npm",
  "npx",
  "nx",
  "php",
  "pnpm",
  "python",
  "python3",
  "rtk",
  "solo",
  "supabase",
  "system-tools",
  "turbo",
  "uv",
  "xcrun",
  "yarn",
]);
const commandPrefixes = new Set(["command", "env", "exec", "nice", "nohup", "sudo", "time"]);
const navigationCommands = new Set(["cd", "pushd", "popd", "set", "true", "source", "."]);
// Inline scripts passed to a shell keep their own line structure, so reject tokens that
// are script syntax rather than a program name.
const scriptNoise = new Set([
  "EOF",
  "await",
  "catch",
  "const",
  "do",
  "done",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "import",
  "let",
  "return",
  "then",
  "try",
  "var",
  "while",
]);
function commandLabel(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  while (
    tokens.length &&
    (commandPrefixes.has(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))
  )
    tokens.shift();
  const binary = (tokens[0] || "").replace(/^['"(]+/, "").split("/").pop() || "";
  if (!binary || scriptNoise.has(binary) || !/^[A-Za-z0-9_.@+-]+$/.test(binary)) return "";
  if (!subcommandBinaries.has(binary)) return binary;
  const sub = tokens.slice(1).find((token) => !token.startsWith("-"));
  return sub && !/[/=$'"]/.test(sub) ? `${binary} ${short(sub, 24)}` : binary;
}
function commandStatements(raw: string): string[] {
  const source = raw.trim();
  if (!source) return [];
  const parts = (source.includes("<<") ? [source] : source.split(/\r?\n/))
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((part) => part.split("|")[0].trim())
    .filter(Boolean);
  const labels = parts
    .map((part) => commandLabel(part))
    .filter(Boolean)
    .slice(0, 16);
  // A leading directory change is never the command that produced the output.
  const meaningful = labels.filter((label) => !navigationCommands.has(label));
  return meaningful.length ? meaningful : labels;
}
const commandField = /(?:"cmd"|'cmd'|\bcmd)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
function wrapperCommands(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(commandField)) {
    const literal = match[1];
    let value = literal.slice(1, -1);
    try {
      value = JSON.parse(
        literal.startsWith("'") ? `"${value.replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : literal,
      ) as string;
    } catch {
      // Keep the raw literal body when the payload is not valid JSON.
    }
    found.push(...commandStatements(value));
  }
  return found;
}
function normalizeCall(payload: Obj): Call | undefined {
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
  const name = string(payload.name),
    source = string(payload.arguments) || string(payload.input);
  const leaf = name.split(/[.:/]/).pop();
  if (leaf === "exec_command") {
    try {
      const command = string(object(JSON.parse(source)).cmd);
      return {
        name,
        label: short(command || "(no command)"),
        declared: 1,
        commands: commandStatements(command),
      };
    } catch {
      return { name, label: "(unparsed command)", declared: 1, commands: [] };
    }
  }
  if (leaf === "exec") {
    const declared = [...source.matchAll(/tools\.(?:[\w_]+\.)?exec_command\s*\(/g)].length,
      commands = wrapperCommands(source);
    // The wrapper also carries non-shell tool calls, so attribute their output to the tool.
    for (const match of source.matchAll(/\btools\.([A-Za-z0-9_$]+)\s*\(/g))
      if (match[1] !== "exec_command") commands.push(`tools.${match[1]}`);
    return { name, label: "functions.exec inline script", declared, commands };
  }
  return { name, label: name || "(unnamed tool)", declared: 0, commands: [] };
}
function outputText(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => string(object(part).text))
          .filter(Boolean)
          .join("\n")
      : JSON.stringify(value ?? "");
}
function addCommand(map: Map<string, Command>, call: Call, output: unknown): void {
  const rendered = outputText(output),
    total = bytes(output),
    originalTokens = Number(
      rendered.match(/(?:Original token count|original_token_count)["':\s]+(\d+)/i)?.[1] || 0,
    ),
    truncated = /tokens truncated|\btruncated\b/i.test(rendered) ? 1 : 0;
  const labels = call.commands.length ? call.commands : [call.label],
    counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  for (const [label, count] of counts) {
    const share = count / labels.length,
      existing = map.get(label) || {
        command: label,
        outputs: 0,
        bytes: 0,
        originalTokens: 0,
        truncated: 0,
        declared: 0,
      };
    existing.outputs++;
    existing.bytes += Math.round(total * share);
    existing.originalTokens += Math.round(originalTokens * share);
    existing.truncated += truncated;
    existing.declared += call.commands.length ? count : call.declared;
    map.set(label, existing);
  }
}
function table<T>(items: T[], columns: Array<[string, (item: T) => string | number]>): void {
  const rows = items.map((item) => columns.map(([, get]) => String(get(item))));
  const widths = columns.map(([header], i) =>
    Math.max(header.length, ...rows.map((row) => row[i]?.length || 0)),
  );
  console.log(`| ${columns.map(([header], i) => header.padEnd(widths[i])).join(" | ")} |`);
  console.log(`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`);
  for (const row of rows)
    console.log(`| ${row.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`);
}
const outsideCwdFilter = (cwd: string): boolean =>
  Boolean(
    cwdFilter &&
      normalizedPath(cwd) !== normalizedPath(cwdFilter) &&
      !normalizedPath(cwd).startsWith(`${normalizedPath(cwdFilter)}/`),
  );

const sessions: Session[] = [],
  commands = new Map<string, Command>();
let candidates: string[] = [];
if (harnesses.has("codex")) {
  if (!existsSync(root)) die(`Codex sessions directory not found: ${root}`);
  candidates = walk(root, (entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"));
  for (const file of candidates) {
    const summary: Session = {
      file: relative(root, file),
      id: "",
      cwd: "",
      bytes: 0,
      lines: 0,
      parsed: 0,
      malformed: 0,
      unknown: 0,
      createdAt: 0,
      firstActivity: 0,
      lastActivity: 0,
      status: "unknown",
      usageMode: "none",
      forked: false,
      forkSource: "",
      parentId: "",
      forkBaselineInput: 0,
      tokenEvents: 0,
      firstInput: 0,
      maxInput: 0,
      totalInput: 0,
      cachedInput: 0,
      totalOutput: 0,
      compactions: 0,
      baseInstructionBytes: 0,
      turnContextInstructionBytes: 0,
      injectedUserMessages: 0,
      injectedUserBytes: 0,
      humanRequests: 0,
      firstUserMessage: "",
      imageMessages: 0,
      imageBytes: 0,
      toolOutputs: 0,
      execOutputs: 0,
      largeExecOutputs: 0,
      truncatedOutputs: 0,
      unmatchedToolOutputs: 0,
    };
    const calls = new Map<string, Call>(),
      localCommands = new Map<string, Command>();
    let active = false,
      previousCumulative: Usage | undefined,
      sawCumulative = false;
    const cumulativeDelta: Usage = { input: 0, cached: 0, output: 0 };
    const legacy: Usage = { input: 0, cached: 0, output: 0 };
    for await (const line of lines(file)) {
      if (!line) continue;
      summary.lines++;
      let event: Obj;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          summary.malformed++;
          continue;
        }
        event = parsed as Obj;
      } catch {
        summary.malformed++;
        continue;
      }
      summary.parsed++;
      const type = string(event.type),
        payload = object(event.payload),
        at = time(event.timestamp) || time(payload.timestamp);
      if (type === "session_meta") {
        summary.id = string(payload.id) || string(payload.session_id) || summary.id;
        summary.cwd = string(payload.cwd) || summary.cwd;
        summary.createdAt ||= time(payload.timestamp) || at;
        summary.baseInstructionBytes ||= bytes(string(object(payload.base_instructions).text));
        const spawn = object(object(object(payload.source).subagent).thread_spawn),
          historyBase = object(payload.history_base);
        const parentId =
          string(payload.forked_from_id) ||
          string(payload.parent_thread_id) ||
          string(spawn.parent_thread_id) ||
          string(historyBase.thread_id);
        if (parentId) {
          summary.forked = true;
          summary.parentId ||= parentId;
          summary.forkSource ||= Object.keys(object(object(payload.source).subagent)).length
            ? "subagent"
            : payload.forked_from_id
              ? "forked-thread"
              : payload.parent_thread_id
                ? "parent-thread"
                : "history-base";
        }
      }
      if (
        type === "response_item" &&
        (payload.type === "function_call" || payload.type === "custom_tool_call")
      ) {
        const call = normalizeCall(payload),
          id = string(payload.call_id) || string(payload.id);
        if (call && id) calls.set(id, call);
      }
      if (type === "event_msg" && payload.type === "token_count" && at < since) {
        const total = object(object(payload.info).total_token_usage);
        if (Object.keys(total).length) previousCumulative = getUsage(total);
      }
      if (!at || at < since) continue;
      active = true;
      summary.firstActivity ||= at;
      summary.lastActivity = Math.max(summary.lastActivity, at);
      summary.bytes += bytes(line);
      if (type === "turn_context") {
        const instructions = string(payload.user_instructions);
        if (instructions) summary.turnContextInstructionBytes += bytes(instructions);
      } else if (type === "compacted") summary.compactions++;
      else if (type === "event_msg" && payload.type === "token_count") {
        const info = object(payload.info),
          last = getUsage(info.last_token_usage),
          total = object(info.total_token_usage);
        summary.tokenEvents++;
        if (summary.createdAt >= since) summary.firstInput ||= last.input;
        summary.maxInput = Math.max(summary.maxInput, last.input);
        if (Object.keys(total).length) {
          sawCumulative = true;
          const current = getUsage(total);
          if (summary.forked && !previousCumulative) {
            // A forked session inherits the parent's cumulative totals, so its first
            // in-window snapshot is a baseline rather than usage this session caused.
            summary.forkBaselineInput = current.input;
          } else
            for (const key of ["input", "cached", "output"] as const) {
              const prior = previousCumulative?.[key] ?? 0;
              cumulativeDelta[key] += current[key] >= prior ? current[key] - prior : current[key];
            }
          previousCumulative = current;
        } else {
          summary.usageMode = "last-only";
          legacy.input += last.input;
          legacy.cached += last.cached;
          legacy.output += last.output;
        }
      } else if (type === "response_item" && payload.type === "message" && payload.role === "user") {
        const message = text(payload.content),
          result = classify(message);
        if (result.injected) {
          summary.injectedUserMessages++;
          summary.injectedUserBytes += result.injectedBytes;
        }
        if (result.human) {
          summary.humanRequests++;
          summary.firstUserMessage ||= result.human;
        }
        const imageParts = Array.isArray(payload.content)
          ? payload.content.filter((part) => {
              const item = object(part);
              return (
                item.type === "input_image" ||
                /data:image/.test(string(item.image_url) || string(item.url))
              );
            })
          : [];
        if (imageParts.length) {
          summary.imageMessages++;
          summary.imageBytes += bytes(imageParts);
        }
      } else if (
        type === "response_item" &&
        (payload.type === "function_call" || payload.type === "custom_tool_call")
      ) {
        // Calls are indexed before the window check so an in-window output can match a prewindow call.
      } else if (
        type === "response_item" &&
        (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
      ) {
        summary.toolOutputs++;
        const call = calls.get(string(payload.call_id) || string(payload.id));
        if (!call) {
          summary.unmatchedToolOutputs++;
          continue;
        }
        const leaf = call.name.split(/[.:/]/).pop();
        if (leaf === "exec" || leaf === "exec_command") {
          const rendered = outputText(payload.output);
          summary.execOutputs++;
          if (
            Number(
              rendered.match(/(?:Original token count|original_token_count)["':\s]+(\d+)/i)?.[1] ||
                0,
            ) > 1000
          )
            summary.largeExecOutputs++;
          if (/tokens truncated|\btruncated\b/i.test(rendered)) summary.truncatedOutputs++;
          addCommand(localCommands, call, payload.output);
        }
      } else if (
        !["session_meta", "turn_context", "compacted"].includes(type) &&
        !(
          (type === "event_msg" && payload.type === "token_count") ||
          (type === "response_item" &&
            [
              "message",
              "function_call",
              "custom_tool_call",
              "function_call_output",
              "custom_tool_call_output",
            ].includes(string(payload.type)))
        )
      )
        summary.unknown++;
    }
    if (!active || outsideCwdFilter(summary.cwd)) continue;
    if (sawCumulative) {
      summary.usageMode = "cumulative";
      summary.totalInput = cumulativeDelta.input;
      summary.cachedInput = cumulativeDelta.cached;
      summary.totalOutput = cumulativeDelta.output;
    } else
      Object.assign(summary, {
        totalInput: legacy.input,
        cachedInput: legacy.cached,
        totalOutput: legacy.output,
      });
    summary.status = !summary.createdAt
      ? "unknown"
      : summary.createdAt < since
        ? "resumed"
        : "created";
    sessions.push(summary);
    for (const item of localCommands.values()) {
      const aggregate = commands.get(item.command) || {
        ...item,
        outputs: 0,
        bytes: 0,
        originalTokens: 0,
        truncated: 0,
        declared: 0,
      };
      aggregate.outputs += item.outputs;
      aggregate.bytes += item.bytes;
      aggregate.originalTokens += item.originalTokens;
      aggregate.truncated += item.truncated;
      aggregate.declared += item.declared;
      commands.set(item.command, aggregate);
    }
  }
}

function taskTrees(): Tree[] {
  if (!existsSync(stateDb) || !sessions.length) return [];
  const db = new Database(stateDb, { readonly: true });
  try {
    const threads = db
      .query("SELECT id, title, cwd, first_user_message FROM threads")
      .all() as Array<{ id: string; title: string; cwd: string; first_user_message: string }>;
    const edges = db
      .query("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
      .all() as Array<{ parent_thread_id: string; child_thread_id: string }>;
    const thread = new Map(threads.map((item) => [item.id, item])),
      parent = new Map(edges.map((item) => [item.child_thread_id, item.parent_thread_id]));
    const unique = new Map<string, Session>();
    for (const session of sessions)
      if (
        session.id &&
        (!unique.has(session.id) || session.lastActivity > unique.get(session.id)!.lastActivity)
      )
        unique.set(session.id, session);
    const groups = new Map<
      string,
      Array<{ session: Session; depth: number; request: string; incomplete: boolean }>
    >();
    for (const session of unique.values()) {
      let rootId = session.id,
        depth = 0;
      const visited = new Set<string>();
      while (parent.has(rootId) && !visited.has(rootId)) {
        visited.add(rootId);
        rootId = parent.get(rootId)!;
        depth++;
      }
      const item = {
        session,
        depth,
        request: thread.get(session.id)?.first_user_message || session.firstUserMessage,
        incomplete: !unique.has(rootId),
      };
      groups.set(rootId, [...(groups.get(rootId) || []), item]);
    }
    return [...groups.entries()]
      .map(([rootId, members]) => {
        const rootThread = thread.get(rootId),
          rootRequest =
            rootThread?.first_user_message ||
            members.find((item) => item.depth === 0)?.request ||
            "";
        const descendants = members.filter((item) => item.depth > 0);
        return {
          rootId,
          title: rootThread?.title || rootRequest || rootId,
          cwd: rootThread?.cwd || members[0]?.session.cwd || "",
          sessions: members.length,
          descendants: descendants.length,
          forkedSessions: members.filter((item) => item.session.forked).length,
          maxDepth: Math.max(...members.map((item) => item.depth)),
          totalInput: members.reduce((sum, item) => sum + item.session.totalInput, 0),
          repeatedRootRequest: descendants.filter((item) => item.request === rootRequest).length,
          highStartupDescendants: descendants.filter((item) => item.session.firstInput >= 50_000)
            .length,
          incomplete: members.some((item) => item.incomplete),
        };
      })
      .filter((item) => item.descendants > 0)
      .sort((a, b) => b.totalInput - a.totalInput);
  } finally {
    db.close();
  }
}
let trees: Tree[] = [],
  treeError = "";
if (harnesses.has("codex"))
  try {
    trees = taskTrees();
  } catch (error) {
    treeError = error instanceof Error ? error.message : String(error);
  }

function claudeToolLabel(name: string, input: Obj): string {
  if (name === "Bash" || name === "BashOutput") {
    const label = commandStatements(string(input.command))[0] || "";
    return label ? `Bash ${label}` : "Bash";
  }
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
    const path = string(input.file_path) || string(input.notebook_path);
    return path ? `${name} ${short(displayPath(path), 60)}` : name;
  }
  if (name === "Grep" || name === "Glob") {
    const pattern = string(input.pattern) || string(input.glob);
    return pattern ? `${name} ${short(pattern, 40)}` : name;
  }
  if (name === "Skill") return `Skill ${short(string(input.skill), 40) || "(unnamed)"}`;
  if (name === "Agent") return `Agent ${short(string(input.subagent_type) || "default", 40)}`;
  if (name === "Task") return `Task ${short(string(input.subagent_type) || "default", 40)}`;
  return name;
}
function addTool(map: Map<string, ClaudeTool>, call: { tool: string; label: string }, output: string): void {
  const existing = map.get(call.label) || {
    tool: call.tool,
    label: call.label,
    outputs: 0,
    bytes: 0,
    maxBytes: 0,
    truncated: 0,
  };
  const size = bytes(output);
  existing.outputs++;
  existing.bytes += size;
  existing.maxBytes = Math.max(existing.maxBytes, size);
  existing.truncated += /truncated|output limit|exceeds maximum/i.test(output) ? 1 : 0;
  map.set(call.label, existing);
}

const claudeSessions: ClaudeSession[] = [],
  claudeTools = new Map<string, ClaudeTool>();
let claudeCandidates: string[] = [];
if (harnesses.has("claude")) {
  if (!existsSync(claudeRoot)) die(`Claude projects directory not found: ${claudeRoot}`);
  claudeCandidates = walk(claudeRoot, (entry) => entry.endsWith(".jsonl"));
  for (const file of claudeCandidates) {
    const relativePath = relative(claudeRoot, file);
    const summary: ClaudeSession = {
      file: relativePath,
      project: relativePath.split("/")[0] || "",
      id: "",
      agentId: "",
      cwd: "",
      sidechain: false,
      parentId: "",
      bytes: 0,
      lines: 0,
      parsed: 0,
      malformed: 0,
      createdAt: 0,
      firstActivity: 0,
      lastActivity: 0,
      status: "unknown",
      models: [],
      requests: 0,
      firstInput: 0,
      maxInput: 0,
      totalInput: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
      totalOutput: 0,
      compactions: 0,
      compactedPreTokens: 0,
      apiErrors: 0,
      humanRequests: 0,
      firstUserMessage: "",
      injectedUserMessages: 0,
      injectedUserBytes: 0,
      attachments: 0,
      attachmentBytes: 0,
      imageMessages: 0,
      imageBytes: 0,
      toolOutputs: 0,
      toolOutputBytes: 0,
      largestToolOutput: 0,
      unmatchedToolOutputs: 0,
    };
    const calls = new Map<string, { tool: string; label: string }>(),
      countedRequests = new Set<string>();
    let active = false;
    for await (const line of lines(file)) {
      if (!line) continue;
      summary.lines++;
      let event: Obj;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          summary.malformed++;
          continue;
        }
        event = parsed as Obj;
      } catch {
        summary.malformed++;
        continue;
      }
      summary.parsed++;
      const type = string(event.type),
        message = object(event.message),
        at = time(event.timestamp);
      summary.id ||= string(event.sessionId);
      summary.agentId ||= string(event.agentId);
      summary.cwd ||= string(event.cwd);
      summary.parentId ||= string(object(event.forkedFrom).sessionId);
      if (event.isSidechain === true) summary.sidechain = true;
      if (at) summary.createdAt ||= at;
      if (type === "assistant" && Array.isArray(message.content))
        for (const block of message.content) {
          const item = object(block);
          if (item.type !== "tool_use") continue;
          const id = string(item.id);
          if (!id) continue;
          const name = string(item.name) || "(unnamed tool)";
          calls.set(id, { tool: name, label: claudeToolLabel(name, object(item.input)) });
        }
      if (!at || at < since) continue;
      active = true;
      summary.firstActivity ||= at;
      summary.lastActivity = Math.max(summary.lastActivity, at);
      summary.bytes += bytes(line);
      if (type === "assistant") {
        const usage = object(message.usage),
          model = string(message.model);
        if (model && !summary.models.includes(model)) summary.models.push(model);
        const key = string(message.id) || string(event.requestId) || string(event.uuid);
        // One API response is written as one record per content block; count its usage once.
        if (Object.keys(usage).length && !countedRequests.has(key)) {
          countedRequests.add(key);
          const cached = number(usage.cache_read_input_tokens),
            written = number(usage.cache_creation_input_tokens);
          const prompt = number(usage.input_tokens) + cached + written;
          summary.requests++;
          summary.totalInput += prompt;
          summary.cachedInput += cached;
          summary.cacheWriteInput += written;
          summary.totalOutput += number(usage.output_tokens);
          summary.maxInput = Math.max(summary.maxInput, prompt);
          if (summary.createdAt >= since) summary.firstInput ||= prompt;
        }
      } else if (type === "user") {
        const content = message.content,
          results = Array.isArray(content)
            ? content.filter((block) => object(block).type === "tool_result")
            : [];
        if (results.length) {
          for (const block of results) {
            const item = object(block),
              rendered = outputText(item.content),
              size = bytes(rendered);
            summary.toolOutputs++;
            summary.toolOutputBytes += size;
            summary.largestToolOutput = Math.max(summary.largestToolOutput, size);
            const call = calls.get(string(item.tool_use_id));
            if (!call) {
              summary.unmatchedToolOutputs++;
              continue;
            }
            addTool(claudeTools, call, rendered);
          }
          continue;
        }
        if (event.isCompactSummary === true || event.isMeta === true) continue;
        const result = classify(text(content));
        if (result.injected) {
          summary.injectedUserMessages++;
          summary.injectedUserBytes += result.injectedBytes;
        }
        if (result.human) {
          summary.humanRequests++;
          summary.firstUserMessage ||= result.human;
        }
        const imageParts = Array.isArray(content)
          ? content.filter((part) => {
              const item = object(part);
              return (
                item.type === "image" ||
                /data:image/.test(string(item.image_url) || string(item.url))
              );
            })
          : [];
        if (imageParts.length) {
          summary.imageMessages++;
          summary.imageBytes += bytes(imageParts);
        }
      } else if (type === "attachment") {
        summary.attachments++;
        summary.attachmentBytes += bytes(event.attachment);
      } else if (type === "system") {
        const subtype = string(event.subtype);
        if (subtype === "compact_boundary") {
          summary.compactions++;
          summary.compactedPreTokens += number(object(event.compactMetadata).preTokens);
        } else if (subtype === "api_error" || string(event.level) === "error") summary.apiErrors++;
      }
    }
    if (!active || outsideCwdFilter(summary.cwd)) continue;
    summary.status = !summary.createdAt
      ? "unknown"
      : summary.createdAt < since
        ? "resumed"
        : "created";
    claudeSessions.push(summary);
  }
}
function claudeTrees(): ClaudeTree[] {
  const map = new Map<string, ClaudeTree>();
  for (const session of claudeSessions) {
    const key = session.id || session.file,
      tree = map.get(key) || {
        sessionId: key,
        project: session.project,
        title: "",
        mainInput: 0,
        subagentInput: 0,
        subagents: 0,
        totalInput: 0,
      };
    if (session.sidechain) {
      tree.subagents++;
      tree.subagentInput += session.totalInput;
    } else {
      tree.mainInput += session.totalInput;
      tree.title ||= session.firstUserMessage;
    }
    tree.totalInput += session.totalInput;
    map.set(key, tree);
  }
  return [...map.values()]
    .filter((item) => item.subagents > 0)
    .sort((a, b) => b.totalInput - a.totalInput);
}
const claudeTaskTrees = claudeTrees();

const totals = {
  candidateFiles: candidates.length,
  sessions: sessions.length,
  created: sessions.filter((item) => item.status === "created").length,
  resumed: sessions.filter((item) => item.status === "resumed").length,
  unknownStatus: sessions.filter((item) => item.status === "unknown").length,
  forked: sessions.filter((item) => item.forked).length,
  bytes: sessions.reduce((sum, item) => sum + item.bytes, 0),
  parsed: sessions.reduce((sum, item) => sum + item.parsed, 0),
  malformed: sessions.reduce((sum, item) => sum + item.malformed, 0),
  unknown: sessions.reduce((sum, item) => sum + item.unknown, 0),
  input: sessions.reduce((sum, item) => sum + item.totalInput, 0),
  cachedInput: sessions.reduce((sum, item) => sum + item.cachedInput, 0),
  output: sessions.reduce((sum, item) => sum + item.totalOutput, 0),
  toolOutputs: sessions.reduce((sum, item) => sum + item.toolOutputs, 0),
  unmatchedToolOutputs: sessions.reduce((sum, item) => sum + item.unmatchedToolOutputs, 0),
};
const claudeTotals = {
  candidateFiles: claudeCandidates.length,
  sessions: claudeSessions.length,
  subagents: claudeSessions.filter((item) => item.sidechain).length,
  created: claudeSessions.filter((item) => item.status === "created").length,
  resumed: claudeSessions.filter((item) => item.status === "resumed").length,
  bytes: claudeSessions.reduce((sum, item) => sum + item.bytes, 0),
  parsed: claudeSessions.reduce((sum, item) => sum + item.parsed, 0),
  malformed: claudeSessions.reduce((sum, item) => sum + item.malformed, 0),
  requests: claudeSessions.reduce((sum, item) => sum + item.requests, 0),
  input: claudeSessions.reduce((sum, item) => sum + item.totalInput, 0),
  cachedInput: claudeSessions.reduce((sum, item) => sum + item.cachedInput, 0),
  cacheWriteInput: claudeSessions.reduce((sum, item) => sum + item.cacheWriteInput, 0),
  output: claudeSessions.reduce((sum, item) => sum + item.totalOutput, 0),
  compactions: claudeSessions.reduce((sum, item) => sum + item.compactions, 0),
  toolOutputs: claudeSessions.reduce((sum, item) => sum + item.toolOutputs, 0),
  toolOutputBytes: claudeSessions.reduce((sum, item) => sum + item.toolOutputBytes, 0),
  unmatchedToolOutputs: claudeSessions.reduce((sum, item) => sum + item.unmatchedToolOutputs, 0),
};
const report = {
  window: { since, sinceMtime: sinceMtime ?? null },
  harnesses: [...harnesses],
  totals,
  sessions,
  commands: [...commands.values()],
  taskTrees: trees,
  taskTreeError: treeError,
  claude: {
    totals: claudeTotals,
    sessions: claudeSessions,
    tools: [...claudeTools.values()],
    subagentTrees: claudeTaskTrees,
  },
};
if (args.has("json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("# Agent Session Context Audit\n");
console.log(`Harnesses: ${[...harnesses].join(", ")}`);
console.log(`Activity window: since ${new Date(since).toISOString()} (event timestamps)`);
if (sinceMtime !== undefined)
  console.log(`Diagnostic file prefilter: mtime since ${new Date(sinceMtime).toISOString()}`);
if (harnesses.has("codex")) {
  console.log("\n## Codex\n");
  console.log(
    `Sessions with activity: ${totals.sessions}/${totals.candidateFiles} candidates (${totals.created} created, ${totals.resumed} resumed, ${totals.unknownStatus} unknown, ${totals.forked} forked)`,
  );
  console.log(`Serialized event bytes in window: ${totals.bytes.toLocaleString()}`);
  console.log(
    `Provider usage in window: ${totals.input.toLocaleString()} input, ${totals.cachedInput.toLocaleString()} cached input, ${totals.output.toLocaleString()} output`,
  );
  console.log(
    `Coverage: ${totals.parsed.toLocaleString()} parsed, ${totals.malformed} malformed, ${totals.unknown} unknown, ${totals.unmatchedToolOutputs} unmatched tool outputs\n`,
  );
  console.log("### Largest Task Trees\n");
  if (trees.length)
    table(trees.slice(0, limit), [
      ["input usage", (x) => x.totalInput.toLocaleString()],
      ["observed sessions", (x) => x.sessions],
      ["observed desc", (x) => x.descendants],
      ["forked", (x) => x.forkedSessions],
      ["depth", (x) => x.maxDepth],
      ["repeat request", (x) => x.repeatedRootRequest],
      ["50k+ startup", (x) => x.highStartupDescendants],
      ["root", (x) => short(x.title)],
    ]);
  else
    console.log(
      treeError
        ? `Task-tree diagnostics unavailable: ${treeError}`
        : "No multi-task trees detected in this window.",
    );
  console.log("\n### Largest Sessions\n");
  table(
    sessions
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, limit),
    [
      ["bytes", (x) => x.bytes.toLocaleString()],
      ["input usage", (x) => x.totalInput.toLocaleString()],
      ["usage", (x) => x.usageMode],
      ["status", (x) => (x.forked ? `forked:${x.forkSource}` : x.status)],
      ["first activity", (x) => new Date(x.firstActivity).toISOString()],
      ["file", (x) => x.file],
    ],
  );
  console.log("\n### Noisiest Shell Commands\n");
  table([...commands.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit), [
    ["output bytes", (x) => x.bytes.toLocaleString()],
    ["outputs", (x) => x.outputs],
    ["declared runs", (x) => x.declared],
    ["reported orig tokens", (x) => x.originalTokens.toLocaleString()],
    ["trunc", (x) => x.truncated],
    ["command", (x) => x.command],
  ]);
  console.log("\n### Highest Startup Inputs\n");
  table(
    sessions
      .filter((x) => x.firstInput)
      .sort((a, b) => b.firstInput - a.firstInput)
      .slice(0, limit),
    [
      ["first input usage", (x) => x.firstInput.toLocaleString()],
      ["base bytes", (x) => x.baseInstructionBytes.toLocaleString()],
      ["turn-context bytes", (x) => x.turnContextInstructionBytes.toLocaleString()],
      ["injected user bytes", (x) => x.injectedUserBytes.toLocaleString()],
      ["human request", (x) => short(x.firstUserMessage)],
      ["images", (x) => `${x.imageMessages}/${x.imageBytes.toLocaleString()} B`],
      ["file", (x) => x.file],
    ],
  );
}
if (harnesses.has("claude")) {
  console.log("\n## Claude Code\n");
  console.log(
    `Sessions with activity: ${claudeTotals.sessions}/${claudeTotals.candidateFiles} candidates (${claudeTotals.created} created, ${claudeTotals.resumed} resumed, ${claudeTotals.subagents} subagent transcripts)`,
  );
  console.log(`Serialized event bytes in window: ${claudeTotals.bytes.toLocaleString()}`);
  console.log(
    `Provider usage in window: ${claudeTotals.input.toLocaleString()} prompt input (${claudeTotals.cachedInput.toLocaleString()} cache read, ${claudeTotals.cacheWriteInput.toLocaleString()} cache write), ${claudeTotals.output.toLocaleString()} output across ${claudeTotals.requests.toLocaleString()} requests`,
  );
  console.log(
    `Tool output in window: ${claudeTotals.toolOutputBytes.toLocaleString()} bytes across ${claudeTotals.toolOutputs.toLocaleString()} results`,
  );
  console.log(
    `Coverage: ${claudeTotals.parsed.toLocaleString()} parsed, ${claudeTotals.malformed} malformed, ${claudeTotals.unmatchedToolOutputs} unmatched tool outputs, ${claudeTotals.compactions} compactions\n`,
  );
  console.log("### Largest Claude Sessions\n");
  table(
    claudeSessions
      .slice()
      .sort((a, b) => b.totalInput - a.totalInput)
      .slice(0, limit),
    [
      ["input usage", (x) => x.totalInput.toLocaleString()],
      ["cache read", (x) => x.cachedInput.toLocaleString()],
      ["output", (x) => x.totalOutput.toLocaleString()],
      ["requests", (x) => x.requests],
      ["peak context", (x) => x.maxInput.toLocaleString()],
      ["compactions", (x) => x.compactions],
      ["kind", (x) => (x.sidechain ? "subagent" : x.status)],
      ["file", (x) => short(x.file, 64)],
    ],
  );
  console.log("\n### Subagent Cost by Parent Session\n");
  if (claudeTaskTrees.length)
    table(claudeTaskTrees.slice(0, limit), [
      ["total input", (x) => x.totalInput.toLocaleString()],
      ["main input", (x) => x.mainInput.toLocaleString()],
      ["subagent input", (x) => x.subagentInput.toLocaleString()],
      ["subagent share", (x) =>
        `${Math.round((100 * x.subagentInput) / Math.max(1, x.totalInput))}%`],
      ["subagents", (x) => x.subagents],
      ["session", (x) => short(x.title || x.sessionId)],
    ]);
  else console.log("No subagent transcripts in this window.");
  console.log("\n### Largest Claude Tool Outputs\n");
  table([...claudeTools.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit), [
    ["output bytes", (x) => x.bytes.toLocaleString()],
    ["outputs", (x) => x.outputs],
    ["largest", (x) => x.maxBytes.toLocaleString()],
    ["trunc", (x) => x.truncated],
    ["call", (x) => x.label],
  ]);
  console.log("\n### Claude Tool Output by Tool\n");
  const byTool = new Map<string, { tool: string; outputs: number; bytes: number }>();
  for (const item of claudeTools.values()) {
    const aggregate = byTool.get(item.tool) || { tool: item.tool, outputs: 0, bytes: 0 };
    aggregate.outputs += item.outputs;
    aggregate.bytes += item.bytes;
    byTool.set(item.tool, aggregate);
  }
  table([...byTool.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit), [
    ["output bytes", (x) => x.bytes.toLocaleString()],
    ["outputs", (x) => x.outputs],
    ["tool", (x) => x.tool],
  ]);
  console.log("\n### Highest Claude Startup Inputs\n");
  table(
    claudeSessions
      .filter((x) => x.firstInput)
      .sort((a, b) => b.firstInput - a.firstInput)
      .slice(0, limit),
    [
      ["first request input", (x) => x.firstInput.toLocaleString()],
      ["attachments", (x) => `${x.attachments}/${x.attachmentBytes.toLocaleString()} B`],
      ["injected user bytes", (x) => x.injectedUserBytes.toLocaleString()],
      ["images", (x) => `${x.imageMessages}/${x.imageBytes.toLocaleString()} B`],
      ["human request", (x) => short(x.firstUserMessage)],
      ["file", (x) => short(x.file, 64)],
    ],
  );
}
console.log("\n## Limits\n");
if (harnesses.has("codex")) {
  console.log(
    "- Codex cumulative usage subtracts the last prewindow provider snapshot. Legacy last-only records are summed and may contain duplicates.",
  );
  console.log(
    "- A forked Codex session (subagent, forked thread, or paginated history base) inherits the parent's cumulative totals, so its first in-window snapshot is used as the baseline and its first turn is not counted.",
  );
  console.log(
    "- Task-tree rows include only sessions observed in the window. Known descendants without window activity are not represented.",
  );
  console.log(
    "- Session totals can include duplicate rollout files for one session; task-tree totals select the newest active copy per session ID.",
  );
  console.log(
    "- functions.exec output bytes are split evenly across the shell commands declared in the same wrapper call.",
  );
}
if (harnesses.has("claude")) {
  console.log(
    "- Claude input counts the full prompt for each API response (fresh input, cache reads, and cache writes), deduplicated by message ID.",
  );
  console.log(
    "- Claude tool output bytes measure the tool_result content returned to the model, not the on-disk record.",
  );
  console.log(
    "- Subagent transcripts are stored under the parent session directory and are grouped by the parent session ID.",
  );
}
