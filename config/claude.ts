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
  effortLevel: "high";
  modelSettings: Record<string, never>;
  autoCompactWindow: number;
} {
  return {
    permissions: { allow: createClaudePermissionAllowList(profile) },
    // Deliver messages from my other sessions even when their permission modes differ.
    crossSessionInbound: "accept",
    // Transcripts take about 0.6 GB a day; Claude deletes older ones at startup instead of after 30 days.
    cleanupPeriodDays: 14,
    // Every model runs at high by default; per-model overrides (such as Opus at xhigh) are cleared.
    effortLevel: "high",
    modelSettings: {},
    // Compact at 500K of the 1M window: each turn re-reads the whole context, so a 1M thread burns about twice
    // the weekly allowance, and a 500K summary keeps more detail. Never CLAUDE_CODE_MAX_CONTEXT_TOKENS: on known
    // Claude models it only applies with compaction disabled.
    autoCompactWindow: 500000,
  };
}
