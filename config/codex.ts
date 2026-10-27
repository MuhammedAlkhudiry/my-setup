/**
 * Codex config values managed by my-setup.
 */

export const CODEX_CONFIG = {
  // Default for runs that request no effort; delegations ask for more when a task needs it.
  model_reasoning_effort: "medium",
  agents: {
    max_threads: 15,
  },
  features: {
    default_mode_request_user_input: true,
    // Agents run no hooks, so Codex never runs one or asks to trust one, including hooks a repo ships.
    hooks: false,
  },
} as const;

/**
 * Top-level keys my-setup used to manage; install deletes them from existing Codex configs.
 */
export const CODEX_RETIRED_TOP_LEVEL_KEYS = ["model_verbosity"] as const;
