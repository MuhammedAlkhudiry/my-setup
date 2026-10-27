import { expect, test } from "bun:test";

import { unresolvedRemoval } from "./rm-target-guard";

const guard = new URL("../../shell/rm-target-guard.zsh", import.meta.url).pathname;

const allowed = [
  "rm -rf /tmp/harium-house-demo.Ab12 && echo cleaned",
  "rm -f /tmp/shots/android-*.png",
  'echo "rm -rf $dir"',
  "grep -rn 'rm -rf $(' src | head",
  "D=$(mktemp -d) && echo $D",
  "cat > notes.md <<'EOF'\nrm -rf \"$(dirname $d)\"\nEOF\nwc -l notes.md",
  "git rm --cached $file",
  "ls $HOME && trash /tmp/x",
];

// Each removal Claude Code held for approval on 2026-10-21, plus the forms it shares a check with.
const blocked: Array<[string, string]> = [
  ['d=$(mktemp -d)/fox && share-html $d; rm -rf "$(dirname $d)"', "rm $(dirname $d)"],
  ["share-html $P --name x 2>&1 | tail -1; rm -rf $(dirname $P)", "rm $(dirname $P)"],
  ['rm -rf "$(cat /tmp/harium-777-avoid-dir)" /tmp/harium-777-avoid-dir', "rm $(cat /tmp/harium-777-avoid-dir)"],
  ['for f in a b; do magick "$f.png" "$D/$f.webp" && rm "$D/$f.png"; done', "rm $D/$f.png"],
  ["S=/tmp/round-3; rm -f $S/android-*.png", "rm $S/android-*.png"],
  ["sudo rm -rf $TARGET", "rm $TARGET"],
  ["rmdir ${dir}", "rmdir ${dir}"],
  ["bash -c 'rm -rf $1' _ /tmp/x", "rm $1"],
];

test("removals of literal paths and commands that only mention rm pass", () => {
  for (const command of allowed) expect([command, unresolvedRemoval(command)]).toEqual([command, undefined]);
});

test("removals of variable or command-output targets are blocked", () => {
  for (const [command, removal] of blocked) expect([command, unresolvedRemoval(command)]).toEqual([command, removal]);
});

test("the hook script exits 2 with the literal-path fix only for a blocked removal", async () => {
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
  expect(denied.errors).toContain("literal path");
});
