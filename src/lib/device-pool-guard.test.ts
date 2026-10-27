import { expect, test } from "bun:test";

import { blockedInvocation } from "./device-pool-guard";

const guard = new URL("../../shell/device-pool-guard.zsh", import.meta.url).pathname;

const allowed = [
  "cd /tmp/x && jq '.leases' state.json > tmp && mv tmp state.json",
  "xcrun simctl list devices booted | grep -c Booted",
  "xcrun simctl list devices -j | jq -r '.devices[][] | select(.state==\"Booted\") | .udid'",
  "ps -axo pid,command | awk '/qemu-system/ {print $1}' | grep 4E57AF0F-F0FB-4143-9692-D882E3D8F445",
  'echo "xcrun simctl create foo bar"',
  "grep -rn 'simctl create' src | head",
  "git log --grep 'avdmanager create avd'",
  "xcrun simctl help create",
  "avdmanager list avd 2>&1 | head",
  "avdslim on emulator-5554 --skip=location",
  "rg 'avdslim create' docs # avdslim create in a comment",
  'printf \'%s\' "$(xcrun simctl list devices)" > /tmp/devices.txt',
  "cat > notes.md <<'EOF'\nxcrun simctl create Probe iPhone\navdslim create Probe\nEOF\nwc -l notes.md",
  "python3 - <<EOF\nprint('xcrun simctl clone a b')\nEOF",
  "cat <<-EOF > x\n\tavdmanager create avd -n X\n\tEOF",
];

const blocked: Array<[string, string]> = [
  ["xcrun simctl create Probe com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "simctl create"],
  ["cd /tmp && FOO=1 /usr/bin/xcrun simctl clone A B", "simctl clone"],
  ["xcrun --sdk iphonesimulator simctl create a b", "simctl create"],
  ["sudo xcrun simctl create a b", "simctl create"],
  ["heavy-run --class build -- xcrun simctl create a b", "simctl create"],
  ["bash -c 'xcrun simctl create a b'", "simctl create"],
  ["udid=$(xcrun simctl create a b)", "simctl create"],
  ['echo "made $(xcrun simctl clone a b)"', "simctl clone"],
  ["xcrun simctl list > /dev/null 2>&1 && xcrun simctl create a b", "simctl create"],
  ["cat <<EOF > x\nhello\nEOF\nxcrun simctl create a b", "simctl create"],
  ["avdmanager --verbose create avd -n Probe -k image", "avdmanager create avd"],
  ["true; avdslim create Probe --api=35", "avdslim create"],
];

test("read-only commands that mention device tools pass", () => {
  for (const command of allowed) expect([command, blockedInvocation(command)]).toEqual([command, undefined]);
});

test("real create and clone invocations are blocked wherever they run", () => {
  for (const [command, invocation] of blocked)
    expect([command, blockedInvocation(command)]).toEqual([command, invocation]);
});

test("the hook script exits 2 with the acquire command only for a blocked invocation", async () => {
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
  expect(denied.errors).toContain("device-queue acquire <project>");
});
