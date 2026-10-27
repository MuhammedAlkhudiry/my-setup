import { expect, test } from "bun:test";

import { blockedSetupWrite } from "./setup-readonly-guard";

const home = "/Users/me";
const root = "/Users/me/PhpstormProjects/my-setup";
const bash = (command: string, cwd = home) =>
  blockedSetupWrite({ tool_name: "Bash", tool_input: { command }, cwd }, root, home);

test("file tools writing into the setup copy are blocked, anywhere else passes", () => {
  const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = home) =>
    blockedSetupWrite({ tool_name, tool_input, cwd }, root, home);

  expect(call("Edit", { file_path: `${root}/config/device-pool.ts` })).toBe(
    `${root}/config/device-pool.ts`,
  );
  expect(call("Write", { file_path: "config/new.ts" }, root)).toBe(`${root}/config/new.ts`);
  expect(call("NotebookEdit", { notebook_path: "~/PhpstormProjects/my-setup/x.ipynb" })).toBe(
    `${root}/x.ipynb`,
  );
  expect(
    call("Edit", { file_path: "/Users/me/PhpstormProjects/my-setup-notes/a.md" }),
  ).toBeUndefined();
  expect(call("Write", { file_path: "/tmp/a.ts" }, root)).toBeUndefined();
});

test("shell commands that write into the setup copy are blocked", () => {
  for (const [command, cwd] of [
    ["echo x > ~/PhpstormProjects/my-setup/README.md", home],
    ["cd ~/PhpstormProjects/my-setup && printf x >> config/devices.ts", home],
    ["sed -i '' s/a/b/ config/hooks.ts", root],
    ["chmod -R u+w ~/PhpstormProjects/my-setup", home],
    ["cp /tmp/a.ts $HOME/PhpstormProjects/my-setup/src/a.ts", home],
    ["git checkout -- .", root],
    ["git -C ~/PhpstormProjects/my-setup apply /tmp/x.patch", home],
    ["bash -c 'rm -rf ~/PhpstormProjects/my-setup/shell'", home],
    ["cat <<EOF | tee src/x.ts\nhello\nEOF", root],
  ]) {
    expect(bash(command!, cwd)).toStartWith(root);
  }
});

test("reads, and writes elsewhere from inside the setup copy, pass", () => {
  for (const [command, cwd] of [
    ["cat README.md && grep -rn '=> x' src > /tmp/out.txt 2>&1", root],
    ["bun test src/lib 2>/dev/null", root],
    ["cp ~/PhpstormProjects/my-setup/README.md /tmp/readme.md", home],
    ["sed -i '' s/a/b/ /tmp/notes.md", root],
    ["chmod +x /tmp/run.zsh", root],
    ["git status && git log -3 && git diff", root],
    ["echo '> ~/PhpstormProjects/my-setup/x'", home],
    ["cd /tmp && touch a", root],
  ]) {
    expect(bash(command!, cwd)).toBeUndefined();
  }
});
