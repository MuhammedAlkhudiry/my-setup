import type { DeviceProfile } from "./devices";
import { createClaudePermissionAllowList } from "./permissions";

/**
 * Claude Code settings managed by my-setup. Only the keys returned here are overwritten in the
 * profile's Claude settings file (the Claude Pool config or `~/.claude`); every other key stays user-owned.
 * `env` and `permissions` merge key by key, so unmanaged entries inside them survive.
 */
export function createClaudeManagedSettings(profile: DeviceProfile): {
  permissions: { allow: string[] };
  env: Record<string, string>;
  crossSessionInbound: "accept";
} {
  return {
    permissions: { allow: createClaudePermissionAllowList(profile) },
    // Subagents default to Sonnet; a caller can still pass `model: "opus"` for hard work.
    env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5-5" },
    // Deliver messages from my other sessions even when their permission modes differ.
    crossSessionInbound: "accept",
  };
}
