import { z } from "zod";

const hookGroup = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.looseObject({ command: z.string().optional() })),
});
const hooksSchema = z.record(z.string(), z.array(hookGroup));

/** Agent hooks my-setup used to install. Codex runs none, so it never asks to trust one. */
const RETIRED_HOOK_COMMANDS = [/^rtk hook (claude|codex)$/, /\/device-queue-hook$/];

/** The first device pool guard matched commands too loosely and blocked read-only pipelines. */
const RETIRED_GUARD_MARKER = "# my-setup:device-pool";
const MANAGED_GUARD = /\/(device-pool|rm-target|telegram-me|sleep-poll|setup-readonly)-guard\.zsh$/;

/** Removes the retired my-setup hooks, keeping unrelated handlers and dropping events left empty. */
export function removeRetiredHooks(existing: unknown): z.infer<typeof hooksSchema> {
  const hooks = hooksSchema.parse(existing ?? {});
  const isRetired = (command: string | undefined) =>
    command !== undefined &&
    (RETIRED_HOOK_COMMANDS.some((pattern) => pattern.test(command)) ||
      command.endsWith(RETIRED_GUARD_MARKER) ||
      MANAGED_GUARD.test(command));

  return Object.fromEntries(
    Object.entries(hooks).flatMap(([event, groups]) => {
      const kept = groups.flatMap((group) => {
        const remaining = group.hooks.filter((hook) => !isRetired(hook.command));
        return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
      });
      return kept.length > 0 ? [[event, kept]] : [];
    }),
  );
}

/**
 * Removes retired and earlier managed hooks, then adds the current managed Claude hooks. Agents lease simulators and
 * emulators from the device pool, so a Bash command that creates or clones one is blocked with the command to run instead.
 * Claude Code asks a person to approve rm on a variable or command-output target even in bypass mode, so that is blocked
 * with the literal-path form to run instead. Sending a Telegram draft as the owner before they approve it, or reading their
 * Telegram session from the Keychain, is blocked too, and so is waiting by sleep-and-check polling, with ending the turn or
 * one wait-for as the alternative. On spare Macs, Edit, Write and shell writes into the read-only setup copy are blocked with
 * the inbox command that sends the change to the Housekeeper instead.
 */
export function mergeClaudeHooks(
  existing: unknown,
  setupRoot: string,
): z.infer<typeof hooksSchema> {
  const hooks = removeRetiredHooks(existing);
  const guards = [
    "device-pool-guard.zsh",
    "rm-target-guard.zsh",
    "telegram-me-guard.zsh",
    "sleep-poll-guard.zsh",
  ].map((script) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command: `${setupRoot}/shell/${script}` }],
  }));
  const setupReadonly = {
    matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
    hooks: [{ type: "command", command: `${setupRoot}/shell/setup-readonly-guard.zsh` }],
  };
  return { ...hooks, PreToolUse: [...(hooks.PreToolUse ?? []), ...guards, setupReadonly] };
}
