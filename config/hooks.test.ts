import { expect, test } from "bun:test";

import { removeRetiredHooks } from "./hooks";

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
