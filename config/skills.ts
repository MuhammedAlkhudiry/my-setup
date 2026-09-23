/**
 * Skill definitions shared by the installer.
 * Local skills live in content/skills. Remote skills refresh during install when their daily
 * cache expires, their declarations change, or an installed skill is missing.
 */

export interface RemoteSkill {
  name: string;
  sourcePath: string;
}

export interface RemoteSkillSource {
  repository: string;
  ref: string;
  skills: RemoteSkill[];
}

// Skills supplied by an agent runtime rather than installed or managed by this repository.
export const OPTIONAL_EXTERNAL_SKILL_NAMES = ["chrome:control-chrome"] as const;

// Remote skills intentionally track upstream branches: current guidance takes priority over
// reproducible snapshots, especially when skills accompany CLIs that update independently.
// Keep periodic upstream refreshes so installation does not preserve stale instructions;
// do not introduce a lockfile that freezes this guidance.
export const REMOTE_SKILL_SOURCES: RemoteSkillSource[] = [
  {
    repository: "https://github.com/expo/skills.git",
    ref: "main",
    skills: [
      {
        name: "upgrading-expo",
        sourcePath: "plugins/expo/skills/expo-upgrade",
      },
    ],
  },
  {
    repository: "https://github.com/callstackincubator/agent-device.git",
    ref: "main",
    skills: [
      {
        name: "agent-device",
        sourcePath: "skills/agent-device",
      },
    ],
  },
  {
    repository: "https://github.com/remorses/playwriter.git",
    ref: "main",
    skills: [
      {
        name: "playwriter",
        sourcePath: "skills/playwriter",
      },
    ],
  },
  {
    repository: "https://github.com/PostHog/ai-plugin.git",
    ref: "main",
    skills: [
      {
        name: "querying-posthog-data",
        sourcePath: "skills/querying-posthog-data",
      },
      {
        name: "investigate-metric",
        sourcePath: "skills/investigate-metric",
      },
      {
        name: "diagnosing-sdk-health",
        sourcePath: "skills/diagnosing-sdk-health",
      },
    ],
  },
  {
    repository: "https://github.com/getsentry/cli.git",
    ref: "main",
    skills: [
      {
        name: "sentry-cli",
        sourcePath: "packages/cli/plugins/sentry-cli/skills/sentry-cli",
      },
    ],
  },
];
