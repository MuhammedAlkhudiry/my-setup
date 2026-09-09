export type SystemToolLevel = "required" | "optional";

export interface SystemToolUpdatePlan {
  commands?: readonly string[];
  note?: string;
}

export type SystemToolLatestSource =
  | {
      type: "command";
      command: string;
      args: readonly string[];
    }
  | {
      type: "homebrew";
      formula: string;
    };

export interface SystemTool {
  name: string;
  level: SystemToolLevel;
  why: string;
  versionArgs?: readonly string[];
  latest?: SystemToolLatestSource;
  update: SystemToolUpdatePlan;
}

export interface SystemToolGroup {
  title: string;
  tools: readonly SystemTool[];
}

export const SYSTEM_TOOL_GROUPS = [
  {
    title: "Core repo tools",
    tools: [
      {
        name: "bun",
        level: "required",
        why: "Runtime used internally by mise run install.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "bun", "version"],
        },
        update: {
          commands: ["bun upgrade"],
        },
      },
      {
        name: "git",
        level: "required",
        why: "Needed for remote skill checkout, hooks, and shared git helpers.",
        versionArgs: ["--version"],
        update: {
          note: "This machine uses Apple Git; update it through macOS/Xcode Command Line Tools, or intentionally switch to Homebrew Git.",
        },
      },
      {
        name: "mise",
        level: "required",
        why: "Needed for the supported local task workflow and global runtime management.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "mise",
        },
        update: {
          commands: ["brew upgrade mise"],
          note: "Use mise self-update only when mise was installed by the standalone installer.",
        },
      },
      {
        name: "node",
        level: "required",
        why: "Hosts npm itself and the npm-installed agent CLIs.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "mise",
          args: ["latest", "node"],
        },
        update: {
          commands: ["mise upgrade node --bump"],
          note: "Use this when node is managed by mise.",
        },
      },
      {
        name: "zsh",
        level: "required",
        why: "Needed by all installed shared shell commands.",
        versionArgs: ["--version"],
        update: {
          note: "Usually updated by macOS or the package manager that owns the shell.",
        },
      },
      {
        name: "swift",
        level: "optional",
        why: "Builds native menu-bar widgets with mise run install -- --widgets.",
        versionArgs: ["--version"],
        update: {
          note: "Update through Xcode or Xcode Command Line Tools.",
        },
      },
    ],
  },
  {
    title: "Shell and helper integrations",
    tools: [
      {
        name: "phpstorm",
        level: "optional",
        why: "Used by the synced zsh config as the editor command.",
        update: {
          note: "Update through JetBrains Toolbox or the PhpStorm app update flow.",
        },
      },
      {
        name: "herd",
        level: "optional",
        why: "Used by Laravel aliases in the synced zsh config.",
        versionArgs: ["--version"],
        update: {
          note: "Update through the Laravel Herd app.",
        },
      },
      {
        name: "opencode",
        level: "optional",
        why: "Used by the ai/opencode launcher and OpenCode workflows.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "opencode-ai", "version"],
        },
        update: {
          commands: ["opencode upgrade"],
        },
      },
      {
        name: "claude",
        level: "optional",
        why: "Used by Claude Code workflows and as a configured agent target.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "@anthropic-ai/claude-code", "version"],
        },
        update: {
          commands: ["claude update"],
        },
      },
      {
        name: "playwright-cli",
        level: "required",
        why: "Default browser automation CLI when existing user browser state is not required.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "@playwright/cli", "version"],
        },
        update: {
          commands: ["npm install -g @playwright/cli@latest"],
        },
      },
      {
        name: "playwriter",
        level: "required",
        why: "Controls the owner's signed-in Chrome tabs through the Playwriter extension.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "playwriter", "version"],
        },
        update: {
          commands: ["npm install -g playwriter@latest"],
          note: "The Chrome extension must also be installed and enabled on each tab Playwriter should control.",
        },
      },
      {
        name: "agent-device",
        level: "required",
        why: "Default AI-agent mobile and device automation CLI.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "agent-device", "version"],
        },
        update: {
          commands: ["npm install -g agent-device"],
        },
      },
      {
        name: "maestro",
        level: "required",
        why: "Mobile E2E test execution and persistent agent control through the bundled MCP server.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "mobile-dev-inc/tap/maestro",
        },
        update: {
          commands: ["brew upgrade mobile-dev-inc/tap/maestro"],
          note: "Install with brew install mobile-dev-inc/tap/maestro. Maestro requires Java 17 or newer.",
        },
      },
      {
        name: "simslim",
        level: "required",
        why: "Applies and verifies the memory-saving service profile for persistent lane simulators.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "mobai-app/tap/simslim",
        },
        update: {
          commands: ["brew upgrade mobai-app/tap/simslim"],
          note: "Install with brew install mobai-app/tap/simslim. Persistent lanes require SimSlim 0.4.0 or newer.",
        },
      },
      {
        name: "fzf",
        level: "optional",
        why: "Used by project pickers and interactive saved-plan archiving.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "fzf",
        },
        update: {
          commands: ["brew upgrade fzf"],
        },
      },
      {
        name: "sg",
        level: "optional",
        why: "Optional AST-shaped code search through ast-grep when text search is too loose.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "ast-grep",
        },
        update: {
          commands: ["brew upgrade ast-grep"],
        },
      },
      {
        name: "magick",
        level: "optional",
        why: "Inspects and measures raster UI references for screenshot-led implementation.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "imagemagick",
        },
        update: {
          commands: ["brew upgrade imagemagick"],
        },
      },
      {
        name: "mo",
        level: "optional",
        why: "Audits and cleans macOS storage through Mole.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "mole",
        },
        update: {
          commands: ["brew upgrade mole"],
          note: "Install with brew install mole.",
        },
      },
      {
        name: "wacli",
        level: "optional",
        why: "Reads and exports WhatsApp data for authorized personal knowledge workflows.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "openclaw/tap/wacli",
        },
        update: {
          commands: ["brew upgrade openclaw/tap/wacli"],
        },
      },
      {
        name: "imsg",
        level: "optional",
        why: "Reads and exports local SMS and iMessage data for authorized personal knowledge workflows.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "steipete/tap/imsg",
        },
        update: {
          commands: ["brew upgrade steipete/tap/imsg"],
          note: "Reading Messages data requires Full Disk Access for the terminal or agent host.",
        },
      },
      {
        name: "qmd",
        level: "required",
        why: "Provides local keyword, semantic, and hybrid search for maintained personal knowledge.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "@tobilu/qmd", "version"],
        },
        update: {
          commands: ["npm install -g @tobilu/qmd@latest"],
        },
      },
      {
        name: "gcloud",
        level: "optional",
        why: "Supports Google Cloud project, API, service account, and IAM workflows.",
        versionArgs: ["version"],
        latest: {
          type: "command",
          command: "brew",
          args: ["info", "--cask", "gcloud-cli"],
        },
        update: {
          commands: ["brew upgrade --cask gcloud-cli"],
        },
      },
    ],
  },
  {
    title: "Observability CLIs",
    tools: [
      {
        name: "posthog-cli",
        level: "required",
        why: "Primary PostHog analytics and API access for agents without MCP.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "@posthog/cli", "version"],
        },
        update: {
          commands: ["npm install -g @posthog/cli@latest"],
        },
      },
      {
        name: "sentry",
        level: "required",
        why: "Primary Sentry issue, event, trace, log, and API access for agents without MCP.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "sentry", "version"],
        },
        update: {
          commands: ["sentry cli upgrade"],
        },
      },
      {
        name: "sentry-cli",
        level: "optional",
        why: "Legacy Sentry release and build-artifact integrations that invoke this exact command.",
        versionArgs: ["--version"],
        latest: {
          type: "command",
          command: "npm",
          args: ["view", "@sentry/cli", "version"],
        },
        update: {
          commands: ["npm install -g @sentry/cli@latest"],
          note: "Keep this npm-owned command separate from the agent-oriented sentry command because SDK and CI integrations may invoke sentry-cli directly.",
        },
      },
    ],
  },
  {
    title: "Git workflow helpers",
    tools: [
      {
        name: "gh",
        level: "optional",
        why: "Used to open GitHub pull requests from the command line.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "gh",
        },
        update: {
          commands: ["brew upgrade gh"],
        },
      },
      {
        name: "glab",
        level: "optional",
        why: "Used to open GitLab merge requests from the command line.",
        versionArgs: ["--version"],
        latest: {
          type: "homebrew",
          formula: "glab",
        },
        update: {
          commands: ["brew install glab"],
        },
      },
    ],
  },
] as const satisfies readonly SystemToolGroup[];
