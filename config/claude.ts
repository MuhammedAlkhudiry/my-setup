import { createClaudePermissionAllowList } from "./permissions";

/**
 * Claude Code settings managed by my-setup. Only the keys returned here are overwritten in
 * `~/.claude/settings.json`; every other key stays user-owned.
 */
export function createClaudeManagedSettings(): {
  permissions: { allow: string[] };
  crossSessionInbound: "accept";
} {
  return {
    permissions: { allow: createClaudePermissionAllowList() },
    // Deliver messages from my other sessions even when their permission modes differ.
    crossSessionInbound: "accept",
  };
}
