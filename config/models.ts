/**
 * Managed model identifiers and names. Change selections here, then run mise run install.
 * Markdown uses {{models.<path>}} references, resolved during installation.
 */

export const MODELS = {
  opencode: {
    smart: "opencode-go/glm-5.3-flash",
    fast: "opencode-go/deepseek-v4.1-flash",
  },
  // Claude subagent models that skills name, such as $improve-agent-setup's episode readers.
  claudeSubagents: {
    reader: "claude-haiku-5-5",
  },
  // Models Raycast AI lists under its "Claude pool" provider, in picker order.
  raycast: {
    sonnet: { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    opus: { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    haiku: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  },
} as const;
