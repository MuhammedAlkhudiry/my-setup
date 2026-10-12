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
  keybinds: Record<string, string>;
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
    keybinds: {
      model_cycle_favorite: "ctrl+a",
      model_cycle_favorite_reverse: "ctrl+shift+a",
    },
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
