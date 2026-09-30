/**
 * Renders a device profile's command and path allowlist into every agent's permission surface:
 * OpenCode `permission`, Claude Code `permissions.allow`, and Codex execpolicy rules.
 * The allowlists themselves live in config/devices.ts.
 */

import type { DeviceProfile } from "./devices";

type Allowlist = Pick<DeviceProfile, "allowedCommands" | "allowedDirectories">;

// File patterns that are readable even when an agent would otherwise ask.
export const ALLOWED_READ_PATTERNS = ["**/.env*"] as const;

export function expandHome(pattern: string, homeDir: string): string {
  return pattern.startsWith("~/") ? `${homeDir}/${pattern.slice(2)}` : pattern;
}

export function createOpencodePermission(
  profile: Allowlist,
  homeDir: string,
): {
  external_directory: Record<string, string>;
  read: Record<string, string>;
  bash: Record<string, string>;
} {
  return {
    external_directory: {
      "*": "ask",
      ...Object.fromEntries(
        profile.allowedDirectories.map((directory) => [expandHome(directory, homeDir), "allow"]),
      ),
    },
    read: Object.fromEntries(ALLOWED_READ_PATTERNS.map((pattern) => [pattern, "allow"])),
    bash: Object.fromEntries(profile.allowedCommands.map((command) => [`${command} *`, "allow"])),
  };
}

export function createClaudePermissionAllowList(profile: Allowlist): string[] {
  return [
    ...profile.allowedDirectories.flatMap((directory) => [`Edit(${directory})`, `Read(${directory})`]),
    ...ALLOWED_READ_PATTERNS.map((pattern) => `Read(${pattern})`),
    ...profile.allowedCommands.map((command) => `Bash(${command} *)`),
  ];
}

export function renderCodexRules(profile: Allowlist): string {
  return [
    "# Managed by my-setup. Do not edit by hand.",
    "# Source of truth: config/devices.ts",
    "",
    ...profile.allowedCommands.map(
      (command) => `prefix_rule(pattern=[${JSON.stringify(command)}], decision="allow")`,
    ),
    "",
  ].join("\n");
}
