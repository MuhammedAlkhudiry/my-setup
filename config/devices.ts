/**
 * Device profiles. Each machine picks one in the untracked `~/.config/my-setup/device.json`
 * (see src/lib/device.ts); the installer installs only what that profile enables.
 */

export const DEVICE_PROFILE_NAMES = ["personal", "work"] as const;

export type DeviceProfileName = (typeof DEVICE_PROFILE_NAMES)[number];

export interface DeviceProfile {
  name: DeviceProfileName;
  // `pool` installs Claude Code into the Claude Pool config dir; `direct` uses the default `~/.claude`.
  claude: "pool" | "direct";
  opencode: boolean;
  // Mac-only zsh layer: .zshrc/.zshenv, local secrets, shared bin commands, and `doctor`.
  shell: boolean;
  macWatcher: boolean;
  mcpServers: boolean;
  // PhpStorm shortcuts in VS Code: the IntelliJ keymap extension plus `config/vscode.ts` (Windows keys).
  vscodeKeymap: boolean;
  // RTK hooks are installed whenever RTK is present; `required` fails the install without it.
  rtk: "required" | "optional";
  requiredSecrets: readonly string[];
  // Local and remote skill names that this device never installs.
  excludedSkills: readonly string[];
  // Commands agents may run without approval. Each entry is a command prefix.
  allowedCommands: readonly string[];
  // Directories agents may read and edit outside the current project. `~` is expanded per agent.
  allowedDirectories: readonly string[];
}

const BASE_COMMANDS = ["git", "grep", "rg", "find", "ls", "cat", "head", "tail", "wc"] as const;
const SHARED_DIRECTORIES = ["~/.config/*", "~/.agents/*"] as const;

export const DEVICE_PROFILES: Record<DeviceProfileName, DeviceProfile> = {
  personal: {
    name: "personal",
    claude: "pool",
    opencode: true,
    shell: true,
    macWatcher: true,
    mcpServers: true,
    vscodeKeymap: false,
    rtk: "required",
    requiredSecrets: ["POSTHOG_CLI_API_KEY", "HUGEICONS_TOKEN"],
    excludedSkills: [],
    allowedCommands: [
      ...BASE_COMMANDS,
      "herd",
      "mise",
      "bun",
      "composer",
      "pk",
      "share-html",
      "doctor",
      "system-tools",
    ],
    allowedDirectories: ["~/PhpstormProjects/*", "/tmp/*", "/private/tmp/*", ...SHARED_DIRECTORIES],
  },
  work: {
    name: "work",
    claude: "direct",
    opencode: false,
    shell: false,
    macWatcher: false,
    mcpServers: false,
    vscodeKeymap: true,
    rtk: "optional",
    requiredSecrets: [],
    excludedSkills: [
      "personal-knowledge",
      "manage-ad-accounts",
      "promo-video",
      "service-access",
      "cli-tools",
      "mobile-app-infra",
      "agent-device",
      "upgrading-expo",
      "asc-cli-usage",
      "asc-metadata-sync",
      "asc-release-flow",
      "asc-submission-health",
      "asc-testflight-orchestration",
      "laravel",
      "improve-agent-setup",
      "tool-updates",
      "sentry-cli",
      "querying-posthog-data",
      "investigate-metric",
    ],
    allowedCommands: [...BASE_COMMANDS, "mise", "bun", "dotnet"],
    allowedDirectories: ["~/dev/*", "~/AppData/Local/Temp/*", ...SHARED_DIRECTORIES],
  },
};
