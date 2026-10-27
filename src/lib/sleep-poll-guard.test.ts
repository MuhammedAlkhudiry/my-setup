import { expect, test } from "bun:test";

import { sleepPoll, sleepSeconds } from "./sleep-poll-guard";

const guard = new URL("../../shell/sleep-poll-guard.zsh", import.meta.url).pathname;

const allowed = [
  "bun test src/lib/sleep.test.ts",
  'grep -rn "sleep 30" src | head',
  "echo 'while true; do sleep 1; done'",
  'git commit -m "replace the sleep 30 loop with wait-for"',
  "sed -i '' 's/sleep 5/sleep 1/' scripts/run.sh",
  "cat > /tmp/poll.sh <<'EOF'\nwhile true; do sleep 5; check; done\nEOF\nchmod +x /tmp/poll.sh",
  "python3 -c 'import time; time.sleep(30)'",
  "sleep 1 && agent-device screenshot /tmp/shot.png",
  "xcrun simctl io booted screenshot a.png; sleep 2; xcrun simctl io booted screenshot b.png",
  "for repo in a b c; do gh api repos/me/$repo; sleep 1; done",
  "while read -r line; do echo $line; sleep 0.2; done < urls.txt",
  "sleep 30",
  "pkill -f sleep",
  "wait-for --timeout 300 cmd 'gh run view 123 --exit-status'",
];

// Each shape agents used to poll, including ones hidden behind bash -c and timeout.
const blocked: Array<[string, string]> = [
  ["while true; do gh pr checks 12 | grep -q pending || break; sleep 30; done", "while loop with sleep"],
  ["until curl -sf localhost:3000/health; do sleep 1; done", "until loop with sleep"],
  ["for i in $(seq 1 30); do [ -f /tmp/done ] && break; sleep 10; done", "for loop with sleep"],
  ["for i in {1..20}; do\n  if gh run view 9 --json status -q .status | grep -q completed; then break; fi\n  sleep 15\ndone", "for loop with sleep"],
  ["while sleep 30; do gh pr checks 1 && break; done", "while loop with sleep"],
  ["sleep 60 && gh run view 123", "sleep 60 then a check"],
  ["sleep 120; tail -5 /tmp/build.log", "sleep 120 then a check"],
  ["sleep 2m; gh pr view 5", "sleep 2m then a check"],
  ["npm run dev & sleep 8 && curl -s localhost:3000", "sleep 8 then a check"],
  ["sleep $DELAY && cat out.json", "sleep $DELAY then a check"],
  ["bash -c 'while ! nc -z localhost 5432; do sleep 1; done'", "while loop with sleep"],
  ["timeout 300 bash -c 'until test -f out.json; do sleep 2; done'", "until loop with sleep"],
];

test("sleep durations add up their units, and unreadable ones count as long", () => {
  expect(sleepSeconds(["1.5"])).toBe(1.5);
  expect(sleepSeconds(["2m", "10"])).toBe(130);
  expect(sleepSeconds(["$N"])).toBe(Number.POSITIVE_INFINITY);
});

test("commands that only mention sleep, settle briefly, or throttle a loop pass", () => {
  for (const command of allowed) expect([command, sleepPoll(command)]).toEqual([command, undefined]);
});

test("sleep loops and long sleeps followed by a check are blocked", () => {
  for (const [command, poll] of blocked) expect([command, sleepPoll(command)]).toEqual([command, poll]);
});

test("the hook script exits 2 with the wait-for alternative only for a poll", async () => {
  const run = async (command: string) => {
    const child = Bun.spawn([guard], {
      stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command } })]),
      stderr: "pipe",
    });
    return { code: await child.exited, errors: await new Response(child.stderr).text() };
  };

  expect(await run("ls -la && git status")).toEqual({ code: 0, errors: "" });
  for (const command of allowed.slice(0, 4)) expect(await run(command)).toEqual({ code: 0, errors: "" });
  const denied = await run(blocked[0]![0]);
  expect(denied.code).toBe(2);
  expect(denied.errors).toContain("end the turn");
  expect(denied.errors).toContain("wait-for port 3000");
});
