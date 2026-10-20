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

test("deduplicates inherited Codex turns before a child sorted ahead of its parent", () => {
  const started = (id: string, timestamp: string) =>
    at(timestamp, "event_msg", { type: "task_started", turn_id: id });
  const inherited = [
    started("parent-turn", "2026-09-01T00:00:01Z"),
    at("2026-09-01T00:00:02Z", "turn_context", {
      turn_id: "parent-turn",
      user_instructions: "rules",
    }),
    usage("2026-09-01T00:00:03Z", 100, 100),
    at("2026-09-01T00:00:04Z", "event_msg", { type: "task_complete", turn_id: "parent-turn" }),
  ];
  const { root, stateDb } = fixture([]);
  writeFileSync(
    join(root, "rollout-z-parent.jsonl"),
    [meta("parent", "2026-09-01T00:00:00Z"), ...inherited]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  writeFileSync(
    join(root, "rollout-a-child.jsonl"),
    [
      at("2026-09-01T00:01:00Z", "session_meta", {
        id: "child",
        cwd: "/projects/example",
        timestamp: "2026-09-01T00:01:00Z",
        parent_thread_id: "parent",
      }),
      ...inherited,
      started("child-turn", "2026-09-01T00:01:01Z"),
      usage("2026-09-01T00:01:02Z", 50, 150),
      usage("2026-09-01T00:01:03Z", 50, 150),
      at("2026-09-01T00:01:04Z", "event_msg", { type: "task_complete", turn_id: "child-turn" }),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );

  const report = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString());
  expect(report.totals).toMatchObject({
    turns: 2,
    inheritedTurnCopies: 1,
    input: 150,
    cachedInput: 75,
    output: 15,
  });
  expect(report.sessions.find((item: any) => item.id === "child")).toMatchObject({
    turns: 1,
    totalInput: 50,
    turnContextInstructionBytes: 0,
  });
  expect(report.sessions.find((item: any) => item.id === "parent")).toMatchObject({
    turns: 1,
    totalInput: 100,
  });
  expect(report.time.main).toMatchObject({ active: 6000, tasks: 2 });
  expect(report.time.tasks.map((task: any) => task.activeMs)).toEqual([3000, 3000]);
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
            {
              type: "text",
              text: "<system-reminder>injected</system-reminder>Repair the analyzer",
            },
          ],
        },
      },
      assistant("2026-09-01T00:00:01Z", "msg-1", usageBlock, [{ type: "thinking", thinking: "" }]),
      assistant(
        "2026-09-01T00:00:02Z",
        "msg-1",
        { ...usageBlock, output_tokens: 1000 },
        [toolCall],
        { apiBlockIndex: 1 },
      ),
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
    output: 1005,
    input: 1660,
    cachedInput: 1500,
    compactions: 1,
  });
  const main = report.claude.sessions.find((item: any) => !item.sidechain);
  expect(main).toMatchObject({
    requests: 1,
    totalInput: 1150,
    totalOutput: 1000,
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

test("splits Claude task time by what the agent waited on", () => {
  const ts = (seconds: number) =>
    new Date(Date.parse("2026-09-01T00:00:00Z") + seconds * 1000).toISOString();
  const base = { sessionId: "main", cwd: "/projects/example", isSidechain: false };
  const user = (seconds: number, content: unknown, extra: Record<string, unknown> = {}) => ({
    ...base,
    type: "user",
    timestamp: ts(seconds),
    uuid: `u${seconds}`,
    message: { role: "user", content },
    ...extra,
  });
  const reply = (
    seconds: number,
    id: string,
    content: unknown[],
    stop: string,
    model = "claude-opus-5",
  ) => ({
    ...base,
    type: "assistant",
    timestamp: ts(seconds),
    uuid: `a${seconds}`,
    message: {
      id,
      model,
      role: "assistant",
      content,
      stop_reason: stop,
      usage: { input_tokens: 1 },
    },
  });
  const notification = (status: string, summary: string) => ({
    ...user(0, `<task-notification>\n<status>${status}</status>\n<summary>${summary}</summary>`),
    origin: { kind: "task-notification" },
  });
  const { root } = claudeFixture({
    "example/main.jsonl": [
      user(0, "Fix the build"),
      reply(
        10,
        "msg-1",
        [
          { type: "tool_use", id: "test", name: "Bash", input: { command: "bun test" } },
          {
            type: "tool_use",
            id: "ci",
            name: "Bash",
            input: { command: "sleep 30; gh pr checks" },
          },
        ],
        "tool_use",
      ),
      user(30, [{ type: "tool_result", tool_use_id: "test", content: "pass" }]),
      user(50, [{ type: "tool_result", tool_use_id: "ci", content: "green" }]),
      reply(60, "msg-2", [{ type: "text", text: "Started the audit" }], "end_turn"),
      { ...base, type: "system", subtype: "stop_hook_summary", timestamp: ts(60.5), uuid: "s1" },
      { ...notification("completed", 'Agent "Audit" finished'), timestamp: ts(360) },
      reply(370, "msg-3", [{ type: "text", text: "Done" }], "end_turn"),
      user(1000, "Next"),
      reply(1010, "failed", [{ type: "text", text: "API Error: 429" }], "stop", "<synthetic>"),
      { ...notification("stopped", "Background agent did not finish"), timestamp: ts(2000) },
    ],
  });
  const time = JSON.parse(runClaude(root, "--since", "2026-09-01").stdout.toString()).claude.time;
  expect(time.main).toMatchObject({
    model: 30_000,
    tool: 40_000,
    hook: 500,
    subagent: 299_500,
    retry: 10_000,
    idle: 1_620_000,
    active: 380_000,
    tasks: 2,
  });
  expect(time.tasks.filter((task: any) => task.trigger === "human")).toMatchObject([
    { prompt: "Fix the build", activeMs: 370_000, topTool: "Bash wait loop" },
    { prompt: "Next", activeMs: 10_000 },
  ]);
  expect(time.tools.find((tool: any) => tool.label === "Bash wait loop")).toMatchObject({
    calls: 1,
    wallMs: 30_000,
    p50: 40_000,
  });
  expect(time.tools.find((tool: any) => tool.label === "Bash bun test")).toMatchObject({
    wallMs: 10_000,
    p50: 20_000,
  });
  expect(time.models).toMatchObject([{ group: "claude-opus-5", requests: 3, p50: 10_000 }]);
});

test("an unknown harness fails clearly", () => {
  const { root } = claudeFixture({ "example/main.jsonl": [] });
  const result = runClaude(root, "--harness", "wat");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--harness must be codex, claude, or all");
});

test("filters Claude tool totals with their sessions, including descendant directories", () => {
  const files = Object.fromEntries(
    ["/projects/example", "/projects/example/child", "/projects/example-other"].map((cwd, i) => [
      `project-${i}/main.jsonl`,
      [
        assistant(
          "2026-09-01T00:00:01Z",
          `msg-${i}`,
          {},
          [{ type: "tool_use", id: "call", name: "Bash", input: { command: `command-${i}` } }],
          { cwd },
        ),
        {
          type: "user",
          timestamp: "2026-09-01T00:00:02Z",
          cwd,
          message: { content: [{ type: "tool_result", tool_use_id: "call", content: "result" }] },
        },
      ],
    ]),
  );
  const { root } = claudeFixture(files);
  const report = JSON.parse(
    runClaude(root, "--since", "2026-09-01", "--cwd", "/projects/example/").stdout.toString(),
  );
  expect(report.claude.totals).toMatchObject({ sessions: 2, toolOutputs: 2, toolOutputBytes: 12 });
  expect(report.claude.tools.map((tool: any) => tool.label).sort()).toEqual([
    "Bash command-0",
    "Bash command-1",
  ]);
  expect(report.claude.tools.reduce((sum: number, tool: any) => sum + tool.bytes, 0)).toBe(12);
});

test("counts affirmative truncation markers without matching false flags or ordinary prose", () => {
  const outputs = [
    '{"textTruncated":false,"truncated":false}',
    '"textTruncated": false',
    "The truncated detection needs a fix",
    "output limit is configured; value exceeds maximum in a test",
    '{"textTruncated":true}',
    '{"truncated":true}',
    "Warning: truncated output (original token count: 2000)",
    "…123 tokens truncated…",
    "<truncated>remaining output omitted</truncated>",
    "Error: result (96,709 characters) exceeds maximum allowed tokens. Output has been saved to /tmp/result.txt",
  ];
  const codex = fixture([
    meta(),
    ...outputs.flatMap((output, i) => [
      at("2026-09-01T00:00:01Z", "response_item", {
        type: "function_call",
        call_id: `${i}`,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: `case-${i}` }),
      }),
      at("2026-09-01T00:00:02Z", "response_item", {
        type: "function_call_output",
        call_id: `${i}`,
        output,
      }),
    ]),
  ]);
  const report = JSON.parse(
    run(codex.root, codex.stateDb, "--since", "2026-09-01").stdout.toString(),
  );
  expect(report.sessions[0].truncatedOutputs).toBe(6);
  expect(report.commands.map((command: any) => command.truncated)).toEqual([
    0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
  ]);

  const claude = claudeFixture({
    "example/main.jsonl": [
      assistant(
        "2026-09-01T00:00:01Z",
        "msg",
        {},
        outputs.map((_, i) => ({
          type: "tool_use",
          id: `${i}`,
          name: "Bash",
          input: { command: `case-${i}` },
        })),
      ),
      {
        type: "user",
        timestamp: "2026-09-01T00:00:02Z",
        message: {
          content: outputs.map((content, i) => ({
            type: "tool_result",
            tool_use_id: `${i}`,
            content,
          })),
        },
      },
    ],
  });
  expect(
    JSON.parse(runClaude(claude.root, "--since", "2026-09-01").stdout.toString()).claude.tools.map(
      (tool: any) => tool.truncated,
    ),
  ).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
});

test("times Codex turns, parallel tools, and model responses without idle or repeated usage", () => {
  const ts = (seconds: number) => new Date(Date.parse("2026-09-01") + seconds * 1000).toISOString();
  const event = (seconds: number, type: string, payload: unknown) => at(ts(seconds), type, payload);
  const call = (id: string) => ({
    type: "function_call",
    call_id: id,
    name: "exec_command",
    arguments: JSON.stringify({ cmd: id }),
  });
  const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "done" });
  const { root, stateDb } = fixture([
    meta(),
    event(0, "event_msg", { type: "task_started", turn_id: "first" }),
    event(0, "turn_context", { turn_id: "first", model: "gpt-6.1-sol" }),
    event(0, "response_item", { type: "message", role: "user", content: "Fix the build" }),
    event(10, "response_item", call("test")),
    event(10, "response_item", call("check")),
    event(10, "token_usage_record", {
      response_id: "r1",
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    event(30, "response_item", output("test")),
    usage(ts(30), 100, 100),
    event(50, "response_item", output("check")),
    usage(ts(50), 100, 100),
    event(60, "response_item", {
      type: "message",
      role: "assistant",
      phase: "final",
      content: [{ type: "output_text", text: "Done" }],
    }),
    event(60, "token_usage_record", {
      response_id: "r2",
      usage: { input_tokens: 200, output_tokens: 20 },
    }),
    usage(ts(60), 200, 300),
    event(60, "event_msg", { type: "task_complete", turn_id: "first" }),
    event(1000, "event_msg", { type: "task_started", turn_id: "second" }),
    event(1000, "turn_context", { turn_id: "second", model: "gpt-6.1-sol" }),
    event(1000, "response_item", { type: "message", role: "user", content: "Next" }),
    event(1005, "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Working" }],
    }),
    usage(ts(1005), 200, 300),
    event(1010, "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Stopped" }],
    }),
    usage(ts(1010), 300, 600),
    usage(ts(1010), 300, 600),
    event(1015, "response_item", {
      type: "message",
      role: "assistant",
      phase: "final",
      content: [{ type: "output_text", text: "Done" }],
    }),
    usage(ts(1015), 400, 1000),
    event(1015, "event_msg", { type: "turn_aborted", turn_id: "second" }),
  ]);
  const report = JSON.parse(run(root, stateDb, "--since", "2026-09-01").stdout.toString());
  expect(report.sessions[0].time).toMatchObject({
    model: 35_000,
    tool: 40_000,
    idle: 940_000,
    active: 75_000,
    tasks: 2,
  });
  expect(report.time.tasks).toMatchObject([
    { prompt: "Fix the build", activeMs: 60_000, toolCalls: 2 },
    { prompt: "Next", activeMs: 15_000 },
  ]);
  expect(report.time.tools.find((tool: any) => tool.label === "test")).toMatchObject({
    calls: 1,
    wallMs: 10_000,
    p50: 20_000,
  });
  expect(report.time.tools.find((tool: any) => tool.label === "check")).toMatchObject({
    calls: 1,
    wallMs: 30_000,
    p50: 40_000,
  });
  expect(report.time.models).toMatchObject([
    { group: "gpt-6.1-sol", requests: 4, totalMs: 35_000, p50: 10_000 },
  ]);
  expect(report.time.contexts).toMatchObject([{ group: "under 50k", requests: 4 }]);

  const window = JSON.parse(run(root, stateDb, "--since", ts(20)).stdout.toString());
  expect(window.time.main).toMatchObject({ model: 25_000, tool: 30_000, active: 55_000 });
  expect(window.time.models[0]).toMatchObject({ requests: 3, totalMs: 25_000 });
});
