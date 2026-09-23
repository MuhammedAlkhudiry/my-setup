import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const at = (timestamp: string, type: string, payload: unknown) => ({ timestamp, type, payload });
function fixture(events: unknown[]): {
  directory: string;
  root: string;
  file: string;
  stateDb: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "codex-context-audit-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "sessions");
  mkdirSync(root, { recursive: true });
  const file = join(root, "rollout-fixture.jsonl");
  writeFileSync(
    file,
    events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n"),
  );
  return { directory, root, file, stateDb: join(directory, "missing.sqlite") };
}
function run(root: string, stateDb: string, ...args: string[]) {
  return Bun.spawnSync([
    "bun",
    join(import.meta.dir, "analyze-sessions.ts"),
    "--root",
    root,
    "--state-db",
    stateDb,
    "--json",
    ...args,
  ]);
}
function meta(id = "session", timestamp = "2026-08-01T00:00:00Z") {
  return at(timestamp, "session_meta", {
    id,
    cwd: "/projects/example",
    timestamp,
    base_instructions: { text: "base" },
  });
}
function usage(timestamp: string, lastInput: number, totalInput?: number) {
  return at(timestamp, "event_msg", {
    type: "token_count",
    info: {
      last_token_usage: { input_tokens: lastInput, cached_input_tokens: 3, output_tokens: 2 },
      ...(totalInput === undefined
        ? {}
        : {
            total_token_usage: {
              input_tokens: totalInput,
              cached_input_tokens: totalInput / 2,
              output_tokens: totalInput / 10,
            },
          }),
    },
  });
}

test("normalizes legacy and modern exec outputs without duplicating wrapper bytes", () => {
  const modernOutput = [
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ];
  const { root, stateDb } = fixture([
    meta(),
    usage("2026-09-01T00:00:00Z", 10, 10),
    at("2026-09-01T00:00:01Z", "response_item", {
      type: "function_call",
      call_id: "legacy",
      name: "functions.exec_command",
      arguments: JSON.stringify({ cmd: "git status --short" }),
    }),
    at("2026-09-01T00:00:02Z", "response_item", {
      type: "function_call_output",
      call_id: "legacy",
      output: "legacy output",
    }),
    at("2026-09-01T00:00:03Z", "response_item", {
      type: "custom_tool_call",
      call_id: "modern",
      name: "exec",
      input:
        'const a = await tools.exec_command({cmd: "one"}); const b = await tools.exec_command({cmd: "two"});',
    }),
    at("2026-09-01T00:00:04Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "modern",
      output: modernOutput,
    }),
    at("2026-09-01T00:00:05Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "missing",
      output: "orphan",
    }),
  ]);
  const result = run(root, stateDb, "--since", "2026-09-01");
  const report = JSON.parse(result.stdout.toString());
  expect(result.exitCode).toBe(0);
  expect(report.sessions[0]).toMatchObject({
    toolOutputs: 3,
    execOutputs: 2,
    unmatchedToolOutputs: 1,
  });
  expect(report.commands.map((item: any) => item.command).sort()).toEqual([
    "git status",
    "one",
    "two",
  ]);
  expect(report.commands.find((item: any) => item.command === "one")).toMatchObject({
    declared: 1,
    outputs: 1,
    bytes: Math.round(Buffer.byteLength(JSON.stringify(modernOutput)) / 2),
  });
});

test("matches an in-window output to a prewindow call", () => {
  const { root, stateDb } = fixture([
    meta(),
    at("2026-08-31T23:59:59Z", "response_item", {
      type: "function_call",
      call_id: "old",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    }),
    at("2026-09-01T00:00:01Z", "response_item", {
      type: "function_call_output",
      call_id: "old",
      output: "/projects/example",
    }),
  ]);
  const session = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString())
    .sessions[0];
  expect(session).toMatchObject({ execOutputs: 1, unmatchedToolOutputs: 0 });
});

test("uses event time for normal windows and reports an old session as resumed", () => {
  const { root, file, stateDb } = fixture([
    meta("resumed", "2026-01-01T00:00:00Z"),
    usage("2026-09-02T00:00:00Z", 7, 7),
  ]);
  utimesSync(file, new Date("2026-01-02"), new Date("2026-01-02"));
  const report = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString());
  expect(report.totals.sessions).toBe(1);
  expect(report.sessions[0].status).toBe("resumed");
  const diagnostic = JSON.parse(
    run(
      root,
      stateDb,
      "--since",
      "2026-09-01",
      "--since-mtime",
      String(Date.parse("2026-09-01")),
    ).stdout.toString(),
  );
  expect(diagnostic.totals).toMatchObject({ candidateFiles: 0, sessions: 0 });
});

test("subtracts a prewindow cumulative baseline and does not sum repeated snapshots", () => {
  const { root, stateDb } = fixture([
    meta(),
    usage("2026-08-31T23:00:00Z", 30, 100),
    usage("2026-09-01T01:00:00Z", 40, 160),
    usage("2026-09-01T02:00:00Z", 40, 160),
    usage("2026-09-01T03:00:00Z", 20, 20),
  ]);
  const session = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString())
    .sessions[0];
  expect(session).toMatchObject({
    usageMode: "cumulative",
    totalInput: 80,
    cachedInput: 40,
    totalOutput: 8,
  });
});

test("separates injected context, human requests, image bytes, and malformed coverage", () => {
  const content = [
    { type: "input_text", text: "<recommended_plugins>catalog</recommended_plugins>" },
    { type: "input_text", text: "<environment_context>runtime</environment_context>" },
    { type: "input_text", text: "Repair the analyzer" },
    { type: "input_image", image_url: "data:image/png;base64,aaaa" },
  ];
  const { root, stateDb } = fixture([
    meta(),
    usage("2026-09-01T00:00:00Z", 1, 1),
    at("2026-09-01T00:00:01Z", "turn_context", { user_instructions: "project rules" }),
    at("2026-09-01T00:00:02Z", "response_item", { type: "message", role: "user", content }),
    at("2026-09-01T00:00:03Z", "future_record", {}),
    "{malformed",
    "null",
  ]);
  const session = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString())
    .sessions[0];
  expect(session).toMatchObject({
    injectedUserMessages: 1,
    humanRequests: 1,
    firstUserMessage: "Repair the analyzer",
    imageMessages: 1,
    imageBytes: Buffer.byteLength(JSON.stringify([content[3]])),
    turnContextInstructionBytes: Buffer.byteLength("project rules"),
    malformed: 2,
    unknown: 1,
  });
});

test("removes a complete injected AGENTS block while preserving the human suffix", () => {
  const message =
    "# AGENTS.md instructions for /project\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>\nRepair the analyzer";
  const { root, stateDb } = fixture([
    meta("created", "2026-09-01T00:00:00Z"),
    at("2026-09-01T00:00:01Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message }],
    }),
  ]);
  const session = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString())
    .sessions[0];
  expect(session).toMatchObject({
    injectedUserMessages: 1,
    humanRequests: 1,
    firstUserMessage: "Repair the analyzer",
  });
  expect(session.injectedUserBytes).toBeGreaterThan(0);
});

test("labels legacy last-only usage explicitly", () => {
  const { root, stateDb } = fixture([
    meta(),
    usage("2026-09-01T00:00:00Z", 12),
    usage("2026-09-01T01:00:00Z", 12),
  ]);
  const session = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString())
    .sessions[0];
  expect(session).toMatchObject({ usageMode: "last-only", totalInput: 24 });
});

test("aggregates descendant context by root task tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-context-audit-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "sessions");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "rollout-root.jsonl"),
    [meta("root", "2026-09-01T00:00:00Z"), usage("2026-09-01T00:00:01Z", 30_000, 30_000)]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  writeFileSync(
    join(root, "rollout-child.jsonl"),
    [meta("child", "2026-09-01T00:00:00Z"), usage("2026-09-01T00:00:01Z", 60_000, 60_000)]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  const stateDb = join(directory, "state.sqlite"),
    database = new Database(stateDb);
  database.run(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, first_user_message TEXT)",
  );
  database.run(
    "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY)",
  );
  database.run(
    "INSERT INTO threads VALUES ('root', 'Build example tree', '/projects/example', 'Build the example')",
  );
  database.run(
    "INSERT INTO threads VALUES ('child', 'Child task', '/projects/example', 'Build the example')",
  );
  database.run("INSERT INTO thread_spawn_edges VALUES ('root', 'child')");
  database.close();
  const report = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString());
  expect(report.taskTrees[0]).toMatchObject({
    title: "Build example tree",
    totalInput: 90_000,
    sessions: 2,
    descendants: 1,
    maxDepth: 1,
    repeatedRootRequest: 1,
    highStartupDescendants: 1,
    incomplete: false,
  });
});

test("invalid dates fail clearly", () => {
  const { root, stateDb } = fixture([]);
  const result = run(root, stateDb, "--since", "not-a-date");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--since must be a valid date");
});

test("unknown options fail clearly", () => {
  const { root, stateDb } = fixture([]);
  const result = run(root, stateDb, "--wat", "value");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Unknown option: --wat");
});

test("uses the first in-window snapshot as the baseline for a forked session", () => {
  const events = (extra: Record<string, unknown>) => [
    at("2026-09-01T00:00:00Z", "session_meta", {
      id: "child",
      cwd: "/projects/example",
      timestamp: "2026-09-01T00:00:00Z",
      base_instructions: { text: "base" },
      ...extra,
    }),
    usage("2026-09-01T00:10:00Z", 40, 5_000_000),
    usage("2026-09-01T00:20:00Z", 60, 5_000_400),
    usage("2026-09-01T00:30:00Z", 80, 5_001_000),
  ];
  const forked = fixture(
    events({
      parent_thread_id: "parent",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } },
    }),
  );
  const session = JSON.parse(
    run(forked.root, forked.stateDb, "--since", "2026-09-01").stdout.toString(),
  ).sessions[0];
  expect(session).toMatchObject({
    forked: true,
    forkSource: "subagent",
    parentId: "parent",
    forkBaselineInput: 5_000_000,
    usageMode: "cumulative",
    totalInput: 1000,
    cachedInput: 500,
    totalOutput: 100,
  });
  const plain = fixture(events({}));
  const plainSession = JSON.parse(
    run(plain.root, plain.stateDb, "--since", "2026-09-01").stdout.toString(),
  ).sessions[0];
  expect(plainSession).toMatchObject({ forked: false, totalInput: 5_001_000 });
});

test("attributes wrapper output to the shell commands it declares", () => {
  const output = "x".repeat(400);
  const { root, stateDb } = fixture([
    meta("commands", "2026-09-01T00:00:00Z"),
    at("2026-09-01T00:00:01Z", "response_item", {
      type: "custom_tool_call",
      call_id: "wrapper",
      name: "exec",
      input: `const r = await tools.exec_command({"cmd":"git status --short && rg -n pattern src | head -40","workdir":"/projects/example"}); text(r.output);`,
    }),
    at("2026-09-01T00:00:02Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "wrapper",
      output,
    }),
  ]);
  const report = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString());
  expect(report.commands.map((item: any) => item.command).sort()).toEqual(["git status", "rg"]);
  expect(report.commands.find((item: any) => item.command === "rg")).toMatchObject({
    outputs: 1,
    declared: 1,
    bytes: Math.round(Buffer.byteLength(output) / 2),
  });
});

function claudeFixture(files: Record<string, unknown[]>): { directory: string; root: string } {
  const directory = mkdtempSync(join(tmpdir(), "claude-context-audit-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "projects");
  for (const [path, events] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n"),
    );
  }
  return { directory, root };
}
function runClaude(root: string, ...args: string[]) {
  return Bun.spawnSync([
    "bun",
    join(import.meta.dir, "analyze-sessions.ts"),
    "--claude-root",
    root,
    "--json",
    ...args,
  ]);
}
const assistant = (
  timestamp: string,
  id: string,
  usage: Record<string, number>,
  content: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  timestamp,
  sessionId: "main",
  cwd: "/projects/example",
  isSidechain: false,
  uuid: `${id}-${timestamp}`,
  message: { id, model: "claude-opus-5", role: "assistant", content, usage },
  ...extra,
});

test("counts each Claude API response once and attributes tool output to the call", () => {
  const usageBlock = {
    input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 50,
    output_tokens: 10,
  };
  const toolCall = {
    type: "tool_use",
    id: "tool-1",
    name: "Bash",
    input: { command: "git status --short" },
  };
  const { root } = claudeFixture({
    "example/main.jsonl": [
      {
        type: "user",
        timestamp: "2026-09-01T00:00:00Z",
        sessionId: "main",
        cwd: "/projects/example",
        isSidechain: false,
        uuid: "u1",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>injected</system-reminder>Repair the analyzer" },
          ],
        },
      },
      assistant("2026-09-01T00:00:01Z", "msg-1", usageBlock, [{ type: "thinking", thinking: "" }]),
      assistant("2026-09-01T00:00:02Z", "msg-1", usageBlock, [toolCall], { apiBlockIndex: 1 }),
      {
        type: "user",
        timestamp: "2026-09-01T00:00:03Z",
        sessionId: "main",
        isSidechain: false,
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "M file.ts" }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2026-09-01T00:00:04Z",
        sessionId: "main",
        uuid: "s1",
        compactMetadata: { trigger: "auto", preTokens: 170_000 },
      },
    ],
    "example/main/subagents/agent-a1.jsonl": [
      {
        type: "user",
        timestamp: "2026-09-01T00:01:00Z",
        sessionId: "main",
        agentId: "a1",
        cwd: "/projects/example",
        isSidechain: true,
        uuid: "su1",
        message: { role: "user", content: [{ type: "text", text: "Audit the skills" }] },
      },
      {
        ...assistant(
          "2026-09-01T00:01:01Z",
          "msg-2",
          {
            input_tokens: 10,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
          },
          [{ type: "text", text: "done" }],
        ),
        agentId: "a1",
        isSidechain: true,
      },
    ],
  });
  const report = JSON.parse(runClaude(root, "--since", "2026-09-01").stdout.toString());
  expect(report.harnesses).toEqual(["claude"]);
  expect(report.claude.totals).toMatchObject({
    sessions: 2,
    subagents: 1,
    requests: 2,
    input: 1660,
    cachedInput: 1500,
    compactions: 1,
  });
  const main = report.claude.sessions.find((item: any) => !item.sidechain);
  expect(main).toMatchObject({
    requests: 1,
    totalInput: 1150,
    firstInput: 1150,
    humanRequests: 1,
    firstUserMessage: "Repair the analyzer",
    injectedUserMessages: 1,
    compactions: 1,
    toolOutputs: 1,
    unmatchedToolOutputs: 0,
  });
  expect(report.claude.tools).toEqual([
    {
      tool: "Bash",
      label: "Bash git status",
      outputs: 1,
      bytes: Buffer.byteLength("M file.ts"),
      maxBytes: Buffer.byteLength("M file.ts"),
      truncated: 0,
    },
  ]);
  expect(report.claude.subagentTrees[0]).toMatchObject({
    sessionId: "main",
    subagents: 1,
    mainInput: 1150,
    subagentInput: 510,
    totalInput: 1660,
  });
  expect(report.totals.sessions).toBe(0);
});

test("an unknown harness fails clearly", () => {
  const { root } = claudeFixture({ "example/main.jsonl": [] });
  const result = runClaude(root, "--harness", "wat");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--harness must be codex, claude, or all");
});
