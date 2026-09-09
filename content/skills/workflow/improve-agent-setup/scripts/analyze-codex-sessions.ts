#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";

type Obj = Record<string, unknown>;
type Usage = { input: number; cached: number; output: number };
type Call = { name: string; label: string; declared: number };
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
  maxDepth: number;
  totalInput: number;
  repeatedRootRequest: number;
  highStartupDescendants: number;
  incomplete: boolean;
};

const home = process.env.HOME || "";
function die(message: string): never {
  console.error(message);
  process.exit(2);
}
function parseArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>(),
    flags = new Set(["help", "h", "json"]);
  const options = new Set(["root", "days", "limit", "cwd", "since", "since-mtime", "state-db"]);
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
  analyze-codex-sessions.ts [options]

Options:
  --root <path>         Session root. Default: ~/.codex/sessions.
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

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry),
      stat = statSync(path);
    if (stat.isDirectory()) found.push(...walk(path));
    else if (
      entry.startsWith("rollout-") &&
      entry.endsWith(".jsonl") &&
      (sinceMtime === undefined || stat.mtimeMs >= sinceMtime)
    )
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
  /<(recommended_plugins|app-context|environment_context|skills_instructions|permissions instructions|apps_instructions|plugins_instructions)>[\s\S]*?<\/\1>/gi;
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
function normalizeCall(payload: Obj): Call | undefined {
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
  const name = string(payload.name),
    source = string(payload.arguments) || string(payload.input);
  const leaf = name.split(/[.:/]/).pop();
  if (leaf === "exec_command") {
    try {
      return {
        name,
        label: short(string(object(JSON.parse(source)).cmd) || "(no command)"),
        declared: 1,
      };
    } catch {
      return { name, label: "(unparsed command)", declared: 1 };
    }
  }
  if (leaf === "exec") {
    const declared = [...source.matchAll(/tools\.(?:[\w_]+\.)?exec_command\s*\(/g)].length;
    return {
      name,
      label: `functions.exec wrapper (${declared || "unknown"} declared shell calls)`,
      declared,
    };
  }
  return { name, label: name || "(unnamed tool)", declared: 0 };
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
    existing = map.get(call.label) || {
      command: call.label,
      outputs: 0,
      bytes: 0,
      originalTokens: 0,
      truncated: 0,
      declared: 0,
    };
  existing.outputs++;
  existing.bytes += bytes(output);
  existing.declared += call.declared;
  existing.originalTokens += Number(
    rendered.match(/(?:Original token count|original_token_count)["':\s]+(\d+)/i)?.[1] || 0,
  );
  existing.truncated += /tokens truncated|\btruncated\b/i.test(rendered) ? 1 : 0;
  map.set(call.label, existing);
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

if (!existsSync(root)) die(`Codex sessions directory not found: ${root}`);
const candidates = walk(root),
  sessions: Session[] = [],
  commands = new Map<string, Command>();
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
            rendered.match(/(?:Original token count|original_token_count)["':\s]+(\d+)/i)?.[1] || 0,
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
  const filter =
    cwdFilter &&
    normalizedPath(summary.cwd) !== normalizedPath(cwdFilter) &&
    !normalizedPath(summary.cwd).startsWith(`${normalizedPath(cwdFilter)}/`);
  if (!active || filter) continue;
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
try {
  trees = taskTrees();
} catch (error) {
  treeError = error instanceof Error ? error.message : String(error);
}
const totals = {
  candidateFiles: candidates.length,
  sessions: sessions.length,
  created: sessions.filter((item) => item.status === "created").length,
  resumed: sessions.filter((item) => item.status === "resumed").length,
  unknownStatus: sessions.filter((item) => item.status === "unknown").length,
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
const report = {
  window: { since, sinceMtime: sinceMtime ?? null },
  totals,
  sessions,
  commands: [...commands.values()],
  taskTrees: trees,
  taskTreeError: treeError,
};
if (args.has("json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("# Codex Session Context Audit\n");
console.log(`Activity window: since ${new Date(since).toISOString()} (event timestamps)`);
if (sinceMtime !== undefined)
  console.log(`Diagnostic file prefilter: mtime since ${new Date(sinceMtime).toISOString()}`);
console.log(
  `Sessions with activity: ${totals.sessions}/${totals.candidateFiles} candidates (${totals.created} created, ${totals.resumed} resumed, ${totals.unknownStatus} unknown)`,
);
console.log(`Serialized event bytes in window: ${totals.bytes.toLocaleString()}`);
console.log(
  `Provider usage in window: ${totals.input.toLocaleString()} input, ${totals.cachedInput.toLocaleString()} cached input, ${totals.output.toLocaleString()} output`,
);
console.log(
  `Coverage: ${totals.parsed.toLocaleString()} parsed, ${totals.malformed} malformed, ${totals.unknown} unknown, ${totals.unmatchedToolOutputs} unmatched tool outputs\n`,
);
console.log("## Largest Task Trees\n");
if (trees.length)
  table(trees.slice(0, limit), [
    ["input usage", (x) => x.totalInput.toLocaleString()],
    ["observed sessions", (x) => x.sessions],
    ["observed desc", (x) => x.descendants],
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
console.log("\n## Largest Sessions\n");
table(
  sessions
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit),
  [
    ["bytes", (x) => x.bytes.toLocaleString()],
    ["input usage", (x) => x.totalInput.toLocaleString()],
    ["usage", (x) => x.usageMode],
    ["status", (x) => x.status],
    ["first activity", (x) => new Date(x.firstActivity).toISOString()],
    ["file", (x) => x.file],
  ],
);
console.log("\n## Noisiest Declared Shell Calls\n");
table([...commands.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit), [
  ["output bytes", (x) => x.bytes.toLocaleString()],
  ["outputs", (x) => x.outputs],
  ["declared calls", (x) => x.declared],
  ["reported orig tokens", (x) => x.originalTokens.toLocaleString()],
  ["trunc", (x) => x.truncated],
  ["call", (x) => x.command],
]);
console.log("\n## Highest Startup Inputs\n");
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
console.log("\n## Limits\n");
console.log(
  "- Cumulative usage subtracts the last prewindow provider snapshot. Legacy last-only records are summed and may contain duplicates.",
);
console.log(
  "- Task-tree rows include only sessions observed in the window. Known descendants without window activity are not represented.",
);
console.log(
  "- Session totals can include duplicate rollout files for one session; task-tree totals select the newest active copy per session ID.",
);
console.log(
  "- functions.exec source only reveals declared nested calls. It does not prove execution, and each wrapper output is counted once.",
);
