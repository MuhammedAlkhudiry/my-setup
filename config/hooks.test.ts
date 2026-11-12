import { expect, test } from "bun:test";

import { mergeClaudeHooks } from "./hooks";

test("installs the guard scripts once, replacing earlier copies", () => {
  const retired = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ command: "keep" }] },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/old/shell/device-pool-guard.zsh" }],
      },
    ],
  };
  const once = mergeClaudeHooks(retired, "/setup");

  expect(mergeClaudeHooks(once, "/setup")).toEqual(once);
  expect(once.PreToolUse).toEqual([
    { matcher: "Bash", hooks: [{ command: "keep" }] },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/setup/shell/device-pool-guard.zsh" }],
    },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/setup/shell/telegram-me-guard.zsh" }],
    },
    {
      matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
      hooks: [{ type: "command", command: "/setup/shell/setup-readonly-guard.zsh" }],
    },
  ]);
});
