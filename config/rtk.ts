import { z } from "zod";

export const RTK_HOOK_COMMANDS = {
  claude: "rtk hook claude",
  codex: "rtk hook codex",
} as const;

const hookGroup = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(z.looseObject({ command: z.string().optional() })),
});
const hooksSchema = z.record(z.string(), z.array(hookGroup));

/** Replace only our native RTK hook, preserving unrelated handlers and events. */
export function mergeRtkHooks(existing: unknown, agent: keyof typeof RTK_HOOK_COMMANDS) {
  const hooks = hooksSchema.parse(existing ?? {});
  const command = RTK_HOOK_COMMANDS[agent];
  const groups = (hooks.PreToolUse ?? []).flatMap((group) => {
    if (!group.hooks.some((hook) => hook.command === command)) return [group];
    const remaining = group.hooks.filter((hook) => hook.command !== command);
    return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
  });

  return {
    ...hooks,
    PreToolUse: [
      ...groups,
      { matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] },
    ],
  };
}
