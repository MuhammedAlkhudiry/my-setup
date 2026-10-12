import { z } from "zod";

const hookGroup = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.looseObject({ command: z.string().optional() })),
});
const hooksSchema = z.record(z.string(), z.array(hookGroup));

/** Agent hooks my-setup used to install. Agents run none now, so Codex never asks to trust one. */
const RETIRED_HOOK_COMMANDS = [/^rtk hook (claude|codex)$/, /\/device-queue-hook$/];

/** Removes the retired my-setup hooks, keeping unrelated handlers and dropping events left empty. */
export function removeRetiredHooks(existing: unknown): z.infer<typeof hooksSchema> {
  const hooks = hooksSchema.parse(existing ?? {});
  const isRetired = (command: string | undefined) =>
    command !== undefined && RETIRED_HOOK_COMMANDS.some((pattern) => pattern.test(command));

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
