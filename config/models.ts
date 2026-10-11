/**
 * Managed model identifiers and names. Change selections here, then run mise run install.
 * Markdown uses {{models.<path>}} references, resolved during installation.
 */

export const MODELS = {
  opencode: {
    smart: "opencode-go/glm-5.3-flash",
    fast: "opencode-go/deepseek-v4.1-flash",
  },
  codex: {
    review: {
      id: "gpt-6.1-sol",
      displayName: "GPT Sol",
      shortName: "Sol",
    },
  },
  claudePool: {
    haiku: {
      id: "claude-haiku-4-5-20251001",
      alias: "claude-haiku-4-5",
    },
    opus: {
      id: "claude-opus-4-5-20251101",
      alias: "claude-opus-4-5",
    },
  },
} as const;
