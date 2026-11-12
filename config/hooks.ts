import { z } from "zod";

const hookGroup = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.looseObject({ command: z.string().optional() })),
});
const hooksSchema = z.record(z.string(), z.array(hookGroup));

/** The guards install manages, so each install replaces its earlier copy. */
const MANAGED_GUARD = /\/(device-pool|telegram-me|setup-readonly)-guard\.zsh$/;

/** Removes the managed guards, keeping unrelated handlers and dropping events left empty. */
function removeManagedHooks(existing: unknown): z.infer<typeof hooksSchema> {
  const hooks = hooksSchema.parse(existing ?? {});
  const isManaged = (command: string | undefined) =>
    command !== undefined && MANAGED_GUARD.test(command);

  return Object.fromEntries(
    Object.entries(hooks).flatMap(([event, groups]) => {
      const kept = groups.flatMap((group) => {
        const remaining = group.hooks.filter((hook) => !isManaged(hook.command));
        return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
      });
      return kept.length > 0 ? [[event, kept]] : [];
    }),
  );
}

/**
 * Removes earlier managed hooks, then adds the current managed Claude hooks. Agents lease simulators and
 * emulators from the device pool, so a Bash command that creates or clones one is blocked with the command to run instead.
 * Sending a Telegram draft as the owner before they approve it, or reading their Telegram session from the Keychain, is
 * blocked too. On spare Macs, Edit, Write and shell writes into the read-only setup copy are blocked with
 * the inbox command that sends the change to the Housekeeper instead.
 */
export function mergeClaudeHooks(
  existing: unknown,
  setupRoot: string,
): z.infer<typeof hooksSchema> {
  const hooks = removeManagedHooks(existing);
  const guards = ["device-pool-guard.zsh", "telegram-me-guard.zsh"].map((script) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command: `${setupRoot}/shell/${script}` }],
  }));
  const setupReadonly = {
    matcher: "Edit|MultiEdit|Write|NotebookEdit|Bash",
    hooks: [{ type: "command", command: `${setupRoot}/shell/setup-readonly-guard.zsh` }],
  };
  return { ...hooks, PreToolUse: [...(hooks.PreToolUse ?? []), ...guards, setupReadonly] };
}
