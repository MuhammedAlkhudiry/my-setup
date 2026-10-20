import type { DeviceProfile } from "./devices";
import { MODELS } from "./models";
import { createOpencodeMcpConfig } from "./mcp";
import { createOpencodePermission } from "./permissions";

export interface OpencodeConfig {
  $schema: string;
  instructions: string[];
  plugin: string[];
  mcp: ReturnType<typeof createOpencodeMcpConfig>;
  tools: Record<string, boolean>;
  model: string;
  small_model: string;
  permission: ReturnType<typeof createOpencodePermission>;
  agent: {
    plan: {
      disable: boolean;
    };
    explore: {
      model: string;
    };
    general: {
      model: string;
    };
  };
}

export function createOpencodeConfig(profile: DeviceProfile, homeDir: string): OpencodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    instructions: [],
    plugin: [],
    mcp: createOpencodeMcpConfig(),
    tools: {},
    model: MODELS.opencode.smart,
    small_model: MODELS.opencode.fast,
    permission: createOpencodePermission(profile, homeDir),
    agent: {
      plan: {
        disable: true,
      },
      explore: {
        model: MODELS.opencode.fast,
      },
      general: {
        model: MODELS.opencode.smart,
      },
    },
  };
}

export function createOpencodeCliConfig() {
  return {
    $schema: "https://opencode.ai/v2/cli.json",
    keybinds: {
      "model.cycle_favorite": "ctrl+a",
      "model.cycle_favorite_reverse": "ctrl+shift+a",
    },
  };
}

// V2 still supports the server's V1 configuration format. Keep provider/model
// definitions intact; only terminal settings must move to cli.json.
export function mergeOpencodeConfig(
  existing: Record<string, unknown>,
  profile: DeviceProfile,
  homeDir: string,
): Record<string, unknown> {
  const settings = createOpencodeConfig(profile, homeDir);
  const { keybinds: _keybinds, ...server } = existing;

  return {
    ...server,
    model: settings.model,
    small_model: settings.small_model,
    permission: { ...(existing.permission as object), ...settings.permission },
    agent: { ...(existing.agent as object), ...settings.agent },
    plugin: settings.plugin,
    mcp: { ...(existing.mcp as object), ...settings.mcp },
    tools: { ...(existing.tools as object), ...settings.tools },
  };
}
