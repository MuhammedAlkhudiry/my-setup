import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Draft } from "./telegram-me";
import { blockedTelegramCommand } from "./telegram-me-guard";

const guard = new URL("../../shell/telegram-me-guard.zsh", import.meta.url).pathname;
const base = {
  chat: { id: 200, title: "Sara", type: "user" as const },
  text: "hi",
  createdAt: "2026-10-22T00:00:00Z",
};
const DRAFTS: Record<string, Draft> = {
  pend01: { ...base, id: "pend01" },
  okay02: { ...base, id: "okay02", approvedAt: "2026-10-22T00:01:00Z" },
  self03: { ...base, id: "self03", chat: { id: 100, title: "Owner", type: "self" } },
  done04: { ...base, id: "done04", approvedAt: "x", sent: { messageId: 5, at: "y" } },
};
const read = (id: string) => DRAFTS[id];

test("approved, Saved Messages, and read-only telegram-me commands pass", () => {
  for (const command of [
    "telegram-me send okay02",
    "telegram-me send self03 --json",
    "telegram-me chats --search sara && telegram-me read Sara --limit 5",
    "printf 'hi' | telegram-me draft Sara",
    "telegram-me approve pend01",
    "grep -n 'telegram-me send' README.md",
    "echo telegram-me send pend01",
  ])
    expect(blockedTelegramCommand(command, read)).toBeUndefined();
});

test("unapproved, unknown, or already-sent drafts and Keychain session reads are blocked", () => {
  const cases: Array<[string, string]> = [
    ["telegram-me send pend01", "not approved"],
    ["~/bin/telegram-me send --json pend01", "not approved"],
    ["telegram-me approve pend01 && telegram-me send pend01", "not approved"],
    ["zsh -c 'telegram-me send pend01'", "not approved"],
    ["telegram-me send nope99", "existing draft"],
    ["telegram-me send", "existing draft"],
    ["telegram-me send done04", "already sent"],
    ["security find-generic-password -s telegram-me -w", "Keychain"],
    [
      `bun -e 'console.log(await Bun.secrets.get({service:"telegram-me",name:"session"}))'`,
      "Keychain",
    ],
  ];
  for (const [command, reason] of cases)
    expect(blockedTelegramCommand(command, read)).toContain(reason);
});

test("the installed hook blocks with exit 2 and skips Bun for unrelated commands", () => {
  const state = mkdtempSync(join(tmpdir(), "telegram-me-guard-"));
  mkdirSync(join(state, "telegram-me/drafts"), { recursive: true });
  writeFileSync(join(state, "telegram-me/drafts/pend01.json"), JSON.stringify(DRAFTS.pend01));
  const run = (command: string) =>
    Bun.spawnSync([guard], {
      stdin: Buffer.from(JSON.stringify({ tool_input: { command } })),
      env: { ...process.env, XDG_STATE_HOME: state },
    });

  try {
    const blocked = run("telegram-me send pend01");
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr.toString()).toContain("telegram-me approve pend01");
    expect(run("ls -la").exitCode).toBe(0);
    expect(run("telegram-me chats").exitCode).toBe(0);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
