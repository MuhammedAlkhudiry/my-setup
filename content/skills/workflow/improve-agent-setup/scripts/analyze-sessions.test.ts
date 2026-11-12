import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const base = Date.parse("2026-09-01T00:00:00Z");
const t = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const cwd = "/projects/example";
let messageCounter = 0;

// One assistant request that calls one tool, then its result.
function call(
  start: number,
  end: number,
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
) {
  const id = `tool-${++messageCounter}`;
  return [
    {
      type: "assistant",
      timestamp: t(start),
      cwd,
      message: {
        id: `msg-${++messageCounter}`,
        model: "claude-test",
        usage: { input_tokens: 40_000 },
        content: [{ type: "tool_use", id, name, input }],
      },
    },
    {
      type: "user",
      timestamp: t(end),
      cwd,
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
      },
    },
  ];
}
const bash = (start: number, end: number, command: string, output: string, isError = false) =>
  call(start, end, "Bash", { command }, output, isError);
const read = (start: number, path: string, output = "contents") =>
  call(start, start + 1, "Read", { file_path: path }, output);

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "analyze-sessions-"));
  directories.push(directory);
  return {
    directory,
    claude: join(directory, "claude"),
    codex: join(directory, "codex"),
    write(path: string, events: unknown[]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        events
          .flat()
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
    },
  };
}
function claudeSession(events: unknown[], name = "session") {
  const space = workspace();
  space.write(join(space.claude, "project", `${name}.jsonl`), events);
  return space;
}
function run(space: ReturnType<typeof workspace>, ...args: string[]) {
  const result = Bun.spawnSync([
    "bun",
    join(import.meta.dir, "analyze-sessions.ts"),
    "--claude-root",
    space.claude,
    "--root",
    space.codex,
    "--since",
    "2026-08-31",
    ...args,
  ]);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
function causes(space: ReturnType<typeof workspace>, ...args: string[]) {
  const result = run(space, "--harness", "claude", "--json", "--limit", "50", ...args);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout).causes as Array<Record<string, any>>;
}
const find = (list: Array<Record<string, any>>, cause: string) =>
  list.find((item) => item.cause === cause);

const ok = (start: number) => bash(start, start + 1, "echo done", "done");

test("errors: an episode runs from the failure through retries and lookups, and messages group across sessions", () => {
  const space = workspace();
  space.write(join(space.claude, "project", "one.jsonl"), [
    bash(0, 2, "bun test", "Exit code 1\nerror: 3 tests failed in /x/a.test.ts", true),
    bash(10, 12, "bun test", "Exit code 1\nerror: 4 tests failed in /y/b.test.ts", true),
    bash(20, 21, "grep -rn needle src", "src/a:1"),
    ok(30),
  ]);
  space.write(join(space.claude, "project", "two.jsonl"), [
    bash(0, 2, "bun test", "error: 7 tests failed in src/c.test.ts", true),
    ok(5),
  ]);
  const list = causes(space);
  const cause = find(list, "bun test failed: error: N tests failed in <path>");

  expect(cause).toMatchObject({
    category: "errors",
    count: 2,
    sessions: 2,
    retries: 1,
    turns: 4,
    tokens: 160_000,
    lostMs: 35_000,
  });
  // One per session first, costliest first; the ref spans the failure through the recovery call.
  expect(cause!.episodes.map((episode: any) => episode.turns)).toEqual([3, 1]);
  expect(cause!.episodes[0].ref).toEndWith("one.jsonl:1-8");
});

test("errors: hook refusals and tool error codes are named", () => {
  const space = claudeSession([
    bash(
      0,
      1,
      "rm -rf $DIR",
      "PreToolUse:Bash hook error: [/setup/shell/device-pool-guard.zsh]: Blocked. Lease a device instead.",
      true,
    ),
    ok(5),
    call(
      10,
      11,
      "mcp__t3__thread_send",
      {},
      '{"_tag":"OrchestratorMcpFailure","code":"thread_not_found"}',
      true,
    ),
    ok(15),
  ]);
  const list = causes(space);

  expect(find(list, "hook refusal: device-pool-guard.zsh")).toMatchObject({
    category: "errors",
    count: 1,
    turns: 1,
  });
  expect(find(list, "mcp__t3__thread_send failed: thread_not_found")).toMatchObject({ count: 1 });
});

test("not-finding: missing paths, unknown commands, and empty searches", () => {
  const space = claudeSession([
    call(
      0,
      1,
      "Read",
      { file_path: "/projects/example/docs/guide.md" },
      "File does not exist.",
      true,
    ),
    ok(10),
    bash(20, 21, "foo --version", "(eval):1: command not found: foo", true),
    ok(30),
    call(40, 41, "Grep", { pattern: "nothing" }, "No matches found"),
    ok(50),
    bash(60, 61, "rg nothing src", "Exit code 1", true),
    ok(70),
  ]);
  const list = causes(space);

  expect(find(list, "missing path: Read in /projects/example/docs")).toMatchObject({
    category: "not-finding",
    lostMs: 10_000,
  });
  expect(find(list, "command not found: foo")).toMatchObject({ category: "not-finding" });
  expect(find(list, "Grep empty result (example)")).toMatchObject({ category: "not-finding" });
  expect(find(list, "rg empty result (example)")).toMatchObject({ category: "not-finding" });
});

test("searching: search chains, help lookups, and re-reads", () => {
  const space = claudeSession([
    bash(0, 1, "ls src", "a b"),
    bash(5, 6, "grep -rn needle src", "src/a:1"),
    call(10, 11, "Glob", { pattern: "**/*.ts" }, "src/a.ts"),
    read(20, "/projects/example/src/a.ts"),
    bash(30, 31, "mytool --help", "Usage: mytool"),
    read(40, "/projects/example/src/a.ts"),
    ok(50),
  ]);
  const list = causes(space);
  const chain = find(list, "search chain before first read (example)");

  // The first search is fair; the next two are the turns and time lost before the first read.
  expect(chain).toMatchObject({ category: "searching", count: 1, turns: 2, lostMs: 15_000 });
  expect(chain!.episodes[0].detail).toBe("ls src | grep -rn needle src | Glob");
  expect(find(list, "help lookup: mytool")).toMatchObject({
    category: "searching",
    lostMs: 10_000,
  });
  expect(find(list, "re-read same file (example)")).toMatchObject({
    category: "searching",
    count: 1,
  });
});

test("slowness: checks, builds, and model responses are waiting, not friction", () => {
  const space = claudeSession([
    { type: "user", timestamp: t(0), cwd, message: { content: "please check" } },
    bash(200, 290, "mise run check", "ok"),
    bash(300, 380, "curl -s https://slow.example", "ok"),
    bash(400, 460, "until [ -f done ]; do sleep 5; done", ""),
    call(500, 900, "Agent", { subagent_type: "Explore" }, "found it"),
  ]);
  const result = run(space, "--harness", "claude", "--json");
  const report = JSON.parse(result.stdout);

  expect(find(report.causes, "slow tool: curl")).toMatchObject({
    category: "slowness",
    turns: 0,
    lostMs: 80_000,
  });
  expect(report.causes.find((item: any) => item.cause.startsWith("polling:"))).toMatchObject({
    lostMs: 60_000,
  });
  expect(report.causes.find((item: any) => /check|Agent|model/.test(item.cause))).toBeUndefined();
  expect(report.waiting).toEqual([
    { label: "model response: claude-test", count: 1, lostMs: 200_000 },
    { label: "mise run check", count: 1, lostMs: 90_000 },
  ]);
});

test("wasted work: compaction, re-reads after it, and subagents re-reading parent files", () => {
  const space = workspace();
  space.write(join(space.claude, "project", "parent.jsonl"), [
    read(0, "/projects/example/src/a.ts"),
    { type: "system", subtype: "compact_boundary", timestamp: t(60), cwd },
    read(70, "/projects/example/src/a.ts"),
    ok(80),
  ]);
  space.write(join(space.claude, "project", "parent", "subagents", "agent-1.jsonl"), [
    read(100, "/projects/example/src/a.ts"),
    ok(110),
  ]);
  const list = causes(space);

  expect(find(list, "compaction (claude)")).toMatchObject({
    category: "wasted-work",
    turns: 1,
    tokens: 40_000,
    lostMs: 59_000,
  });
  expect(find(list, "re-read after compaction (example)")).toMatchObject({
    category: "wasted-work",
    count: 1,
  });
  expect(find(list, "subagent re-read parent's files (example)")).toMatchObject({
    category: "wasted-work",
    count: 1,
  });
});

test("codex: blames the failing command inside an exec wrapper", () => {
  const space = workspace();
  const item = (seconds: number, payload: Record<string, unknown>) => ({
    timestamp: t(seconds),
    type: "response_item",
    payload,
  });
  space.write(join(space.codex, "2026", "09", "01", "rollout-a.jsonl"), [
    { timestamp: t(0), type: "session_meta", payload: { id: "a", cwd } },
    item(1, {
      type: "custom_tool_call",
      call_id: "c1",
      name: "exec",
      input:
        'await tools.exec_command({cmd: "git status"}); await tools.exec_command({cmd: "bun test"});',
    }),
    {
      timestamp: t(2),
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 30_000 } } },
    },
    item(5, {
      type: "custom_tool_call_output",
      call_id: "c1",
      output: [
        {
          type: "input_text",
          text: '{"chunk_id":"1","exit_code":0,"output":"clean"}\n{"chunk_id":"2","exit_code":1,"output":"1 fail"}',
        },
      ],
    }),
    item(8, {
      type: "function_call",
      call_id: "c3",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo ok" }),
    }),
    item(9, {
      type: "function_call_output",
      call_id: "c3",
      output: "Process exited with code 0\nok",
    }),
    item(10, {
      type: "function_call",
      call_id: "c2",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "nope" }),
    }),
    item(11, {
      type: "function_call_output",
      call_id: "c2",
      output: "Process exited with code 127\nzsh: command not found: nope",
    }),
    item(20, { type: "message", role: "assistant", content: [] }),
  ]);
  const list = JSON.parse(run(space, "--harness", "codex", "--json").stdout).causes;

  expect(find(list, "bun test failed: N fail")).toMatchObject({
    category: "errors",
    turns: 1,
    tokens: 30_000,
    lostMs: 7_000,
  });
  expect(find(list, "command not found: nope")).toMatchObject({ category: "not-finding" });
});

test("ranks causes by turns wasted and prints each cause with its episode refs", () => {
  const space = workspace();
  space.write(join(space.claude, "project", "one.jsonl"), [
    bash(0, 1, "bun x", "Exit code 1\nerror: boom", true),
    bash(5, 6, "bun x", "Exit code 1\nerror: boom", true),
    ok(10),
    bash(20, 110, "curl -s https://slow.example", "ok"),
    ok(115),
  ]);
  const list = causes(space);
  expect(list.map((item) => item.cause)).toEqual(["bun x failed: error: boom", "slow tool: curl"]);

  const lines = run(space, "--harness", "claude", "--limit", "1").stdout.trim().split("\n");
  expect(lines[0]).toStartWith("analyze-sessions: 1 sessions");
  expect(lines[1]).toStartWith("by category: errors 2 turns 80k tok 10s");
  expect(lines[2]).toBe(
    "1. 2 turns 80k tok 10s 1x 1 sessions 1 retries [errors] bun x failed: error: boom",
  );
  expect(lines[3]).toMatch(/^ {3}\S+one\.jsonl:1-6 2t bun x -> /);
  expect(lines).toHaveLength(4);
});

test("--episode prints a compact transcript slice", () => {
  const space = claudeSession([
    {
      type: "assistant",
      timestamp: t(0),
      cwd,
      message: { id: "intent", content: [{ type: "text", text: "Run the tests." }] },
    },
    bash(1, 2, "bun test", "Exit code 1\nerror: boom", true),
    ok(5),
  ]);
  const file = join(space.claude, "project", "session.jsonl");
  const result = run(space, "--episode", `${file}:1-3`);

  expect(result.stdout.trim().split("\n").slice(1)).toEqual([
    "L1 assistant: Run the tests.",
    "L2 call Bash: bun test",
    "L3 result (error): Exit code 1 error: boom",
  ]);
  expect(run(space, "--episode", "nope").code).toBe(2);
});

test("baseline adds before -> after per cause and lists causes that are gone", () => {
  const space = claudeSession([bash(0, 1, "bun x", "error: boom", true), ok(5)]);
  const saved = join(space.directory, "state", "last.json");
  writeFileSync(
    join(space.directory, "old.json"),
    JSON.stringify({
      causes: [
        { key: "errors|bun x failed: error: boom", count: 5, turns: 9, lostMs: 600_000 },
        { key: "errors|bun y failed", count: 3, turns: 4, lostMs: 60_000 },
        { key: "slowness|slow tool: old", count: 1, lostMs: 1 },
      ],
    }),
  );

  const text = run(
    space,
    "--harness",
    "claude",
    "--baseline",
    join(space.directory, "old.json"),
    "--save",
    saved,
  ).stdout;
  expect(text).toContain("bun x failed: error: boom (before 9 turns 5x 10m)");
  expect(text).toContain("gone: errors|bun y failed (before 4 turns 3x 1m)");
  // Causes saved before turn counting are ignored rather than reported as gone.
  expect(text).not.toContain("slow tool: old");
  expect(JSON.parse(require("node:fs").readFileSync(saved, "utf8")).causes[0].before).toEqual({
    count: 5,
    turns: 9,
    lostMs: 600_000,
  });
});

test("filters by working directory and rejects bad options", () => {
  const space = claudeSession([bash(0, 1, "bun x", "error: boom", true), ok(5)]);

  expect(causes(space, "--cwd", "/projects/example")).toHaveLength(1);
  expect(causes(space, "--cwd", "/projects/other")).toHaveLength(0);
  expect(run(space, "--harness", "nope").code).toBe(2);
  expect(run(space, "--bogus").stderr).toContain("Unknown option: --bogus");
});

test("errors: zsh refusals group by message whatever the command", () => {
  const space = claudeSession([
    bash(0, 1, "grep -rn x --include=*.ts src", "(eval):1: no matches found: --include=*.ts", true),
    ok(5),
    bash(10, 11, "ls *.md", "(eval):3: no matches found: *.md", true),
    ok(15),
    bash(20, 21, "cat a && echo ===", "(eval):1: ===== not found", true),
    ok(25),
  ]);
  const list = causes(space);

  expect(find(list, "shell error: zsh: no matches found")).toMatchObject({ count: 2 });
  expect(find(list, "shell error: zsh: unquoted = word not found")).toMatchObject({ count: 1 });
});

test("searching: screenshots and logs are not re-reads, and subagent search chains are their work", () => {
  const space = workspace();
  space.write(join(space.claude, "project", "parent.jsonl"), [
    read(0, "/tmp/shot.png"),
    read(10, "/tmp/shot.png"),
    read(20, "/tmp/run.log"),
    read(30, "/tmp/run.log"),
    ok(40),
  ]);
  space.write(join(space.claude, "project", "parent", "subagents", "agent-1.jsonl"), [
    bash(100, 101, "ls src", "a b"),
    bash(105, 106, "grep -rn needle src", "src/a:1"),
    call(110, 111, "Glob", { pattern: "**/*.ts" }, "src/a.ts"),
    read(120, "/projects/example/src/b.ts"),
  ]);

  expect(causes(space)).toEqual([]);
});
