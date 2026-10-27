import { expect, test } from "bun:test";

import { mergeClaudeHooks, removeRetiredHooks } from "./hooks";

test("removes only the retired my-setup hooks and drops events left empty", () => {
  const existing = {
    Notification: [{ hooks: [{ command: "status" }] }],
    PreToolUse: [
      { hooks: [{ command: "status" }] },
      {
        matcher: "Bash",
        hooks: [{ command: "/Users/me/bin/device-queue-hook" }, { command: "other" }],
      },
      { matcher: "mcp__x", hooks: [{ command: "/Users/me/bin/device-queue-hook" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude", timeout: 10 }] },
    ],
    PostToolUse: [{ matcher: "Bash", hooks: [{ command: "rtk hook codex" }] }],
  };

  expect(removeRetiredHooks(existing)).toEqual({
    Notification: [{ hooks: [{ command: "status" }] }],
    PreToolUse: [
      { hooks: [{ command: "status" }] },
      { matcher: "Bash", hooks: [{ command: "other" }] },
    ],
  });
  expect(removeRetiredHooks(undefined)).toEqual({});
});

test("installs the guard scripts once, replacing earlier copies and the retired rules", () => {
  const retired = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ command: "keep" }] },
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            if: "Bash(xcrun simctl create *)",
            command: "echo blocked >&2; exit 2 # my-setup:device-pool",
          },
        ],
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
    { matcher: "Bash", hooks: [{ type: "command", command: "/setup/shell/rm-target-guard.zsh" }] },
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/setup/shell/telegram-me-guard.zsh" }],
    },
    { matcher: "Bash", hooks: [{ type: "command", command: "/setup/shell/sleep-poll-guard.zsh" }] },
    {
      matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
      hooks: [{ type: "command", command: "/setup/shell/setup-readonly-guard.zsh" }],
    },
  ]);
});
