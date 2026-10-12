import type { DeviceProfile } from "./devices";
import { createClaudePermissionAllowList } from "./permissions";

/**
 * Claude Code settings managed by my-setup. Only the keys returned here are overwritten in the
 * profile's Claude settings file (the Claude Pool config or `~/.claude`); every other key stays user-owned.
 * `permissions` merges key by key, so unmanaged entries inside it survive.
 */
export function createClaudeManagedSettings(profile: DeviceProfile): {
  permissions: { allow: string[] };
  crossSessionInbound: "accept";
  cleanupPeriodDays: number;
} {
  return {
    permissions: { allow: createClaudePermissionAllowList(profile) },
    // Deliver messages from my other sessions even when their permission modes differ.
    crossSessionInbound: "accept",
    // Transcripts take about 0.6 GB a day; Claude deletes older ones at startup instead of after 30 days.
    cleanupPeriodDays: 14,
  };
}
