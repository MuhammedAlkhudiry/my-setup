/**
 * Shared command and path allowlist rendered into every agent's permission surface:
 * OpenCode `permission`, Claude Code `permissions.allow`, and Codex execpolicy rules.
 */

// Commands agents may run without approval. Each entry is a command prefix.
export const ALLOWED_COMMAND_PREFIXES = [
  "git",
  "grep",
  "rg",
  "find",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "herd",
  "mise",
  "bun",
  "composer",
  "knowledge",
  "pk",
  "share-html",
  "doctor",
  "system-tools",
] as const;

// Directories agents may read and edit outside the current project. `~` is expanded per agent.
export const ALLOWED_DIRECTORIES = [
  "~/PhpstormProjects/*",
  "/tmp/*",
  "/private/tmp/*",
  "~/.config/*",
  "~/.agents/*",
] as const;

// File patterns that are readable even when an agent would otherwise ask.
export const ALLOWED_READ_PATTERNS = ["**/.env*"] as const;

export function expandHome(pattern: string, homeDir: string): string {
  return pattern.startsWith("~/") ? `${homeDir}/${pattern.slice(2)}` : pattern;
}

export function createOpencodePermission(homeDir: string): {
  external_directory: Record<string, string>;
  read: Record<string, string>;
  bash: Record<string, string>;
} {
  return {
    external_directory: {
      "*": "ask",
      ...Object.fromEntries(
        ALLOWED_DIRECTORIES.map((directory) => [
          directory.startsWith("~/") ? expandHome(directory, homeDir) : directory,
          "allow",
        ]),
      ),
    },
    read: Object.fromEntries(ALLOWED_READ_PATTERNS.map((pattern) => [pattern, "allow"])),
    bash: Object.fromEntries(ALLOWED_COMMAND_PREFIXES.map((command) => [`${command} *`, "allow"])),
  };
}

export function createClaudePermissionAllowList(): string[] {
  return [
    ...ALLOWED_DIRECTORIES.flatMap((directory) => [`Edit(${directory})`, `Read(${directory})`]),
    ...ALLOWED_READ_PATTERNS.map((pattern) => `Read(${pattern})`),
    ...ALLOWED_COMMAND_PREFIXES.map((command) => `Bash(${command} *)`),
  ];
}

export function renderCodexRules(): string {
  return [
    "# Managed by my-setup. Do not edit by hand.",
    "# Source of truth: config/permissions.ts",
    "",
    ...ALLOWED_COMMAND_PREFIXES.map(
      (command) => `prefix_rule(pattern=[${JSON.stringify(command)}], decision="allow")`,
    ),
    "",
  ].join("\n");
}
