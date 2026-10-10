/**
 * T3 Code settings managed by my-setup, applied on every device where T3 Code is installed. Install
 * merges only these keys into T3's settings files; every other key, such as providers, the default
 * model, and favorites, stays per device. Keep only values that differ from T3's defaults.
 */

// Server settings (`settings.json`). T3 reloads this file while it runs.
export const T3_SERVER_SETTINGS = {
  sourceControlWritingStyle: {
    mode: "custom",
    customInstructions: [
      "Commits: one plain sentence naming what changed for the user, in the product's words, with no type prefix, label, or trailing period.",
      'Pull request titles: start with one best-fit label, [✨ FEAT], [🐛 FIX], [♻️ REFACTOR], [⚡ PERF], [🔒 SECURITY], [🧪 TEST], [📝 DOCS], or [🔧 TOOLING], then name what the user notices in the product\'s words, such as "[✨ FEAT] Rate finished sessions".',
    ].join("\n"),
  },
  storageCleanup: {
    worktreeOnMerge: true,
    browserArtifactsAfterDays: 8,
    logsAfterDays: 8,
  },
  continueThreadsAfterServerUpdate: true,
  autoResumeLimitedThreads: true,
  sidebarAutoSettleAfterDays: 20,
  sidebarAutoSettleOnMerge: false,
} as const;

// App settings (`client-settings.json`). T3 reads this file only when the app starts.
export const T3_CLIENT_SETTINGS = {
  notificationMode: "notifications",
  inAppNotificationsEnabled: true,
  browserLinkTarget: "app",
  diffFilesCollapsed: false,
  glassOpacity: 100,
  sidebarWorkingShelfEnabled: true,
  wordWrap: false,
} as const;

// `config/t3-theme.json` is published under this id and set as each device's theme.
export const T3_THEME_ID = "codex";
