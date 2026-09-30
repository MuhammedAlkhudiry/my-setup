/**
 * Mac resource watcher managed by my-setup.
 *
 * memcap does the minute-by-minute memory cleanup with fixed rules, and the CPU guard does the same for leftover agent
 * tooling that burns CPU. The watcher is a scheduled review: it collects a snapshot without AI, and only asks Codex to
 * judge it when something looks wrong. Codex never kills processes; it records patterns and alerts that `doctor` shows
 * until they stop recurring.
 */
export const MAC_WATCHER = {
  label: "com.muhammed.mac-watcher",
  guardLabel: "com.muhammed.mac-watcher-guard",
  /** Local times the watcher wakes every day; quiet hours keep one overnight run for agents working at night. */
  schedule: [
    { hour: 3, minute: 7 },
    { hour: 9, minute: 7 },
    { hour: 12, minute: 7 },
    { hour: 15, minute: 7 },
    { hour: 18, minute: 7 },
    { hour: 21, minute: 7 },
  ],
  codex: {
    model: "gpt-6.1-sol",
    reasoningEffort: "low",
    timeoutMs: 5 * 60 * 1000,
  },
  /** Any of these makes a run worth a Codex review. */
  gate: {
    minFreePercent: 25,
    /** macOS keeps swap long after pressure passes, so only heavy swap counts on its own. */
    maxSwapUsedGib: 12,
    minDiskFreeGib: 20,
    /** Processes whose parent died, matching agent tooling, older than this, count as leaks; only new ones trigger a review. */
    orphanMinAgeMinutes: 60,
    /** Refresh Codex's memory and recheck open alerts at least this often, even on quiet days. */
    maxHoursWithoutReview: 24,
  },
  cpu: {
    /** Leftover agent tooling (parent exited) is stopped after staying at this CPU for this long. Nothing else is. */
    guard: { intervalSeconds: 60, hotPercent: 80, stopAfterMinutes: 10 },
    /** Any process averaging this CPU over its life for this long is reported to the watcher, never stopped. */
    sustainedPercent: 80,
    sustainedMinMinutes: 30,
    /** A 15-minute load average above cores times this triggers a review. */
    maxLoadPerCore: 1,
  },
  /** Consecutive Codex reviews without seeing an alert before it closes on its own. */
  autoResolveAfterClearReviews: 3,
  /** Runs kept in the watcher's history. */
  historyLimit: 60,
  /** Learned patterns kept between runs. */
  patternLimit: 15,
} as const;

/**
 * memcap settings for this machine: 48 GB RAM, no Docker. Keys match `memcap init`; my-setup owns the file.
 * The per-job limit is doubled from memcap's 4 GB so large builds are not killed.
 */
export const MEMCAP_CONFIG: Record<string, string | number> = {
  TOTAL_BUDGET_GB: 32,
  BUDGET_MODE: "shared",
  QUEUE_POLICY: "adaptive",
  QUEUE_MAX_PRESSURE: "yellow",
  QUEUE_MAX_JOBS: 12,
  QUEUE_WORKERS: 8,
  QUEUE_JOB_GB: 1,
  QUEUE_HEADROOM_GB: 2,
  DOCKER_BUDGET_GB: 0,
  DOCKER_CPUS: 7,
  SOFT_TRIGGER: "0.80",
  MIN_FREE_PCT: 15,
  TIER2_MIN_AGE_SEC: 300,
  SIM_IDLE_GRACE_SEC: 600,
  GC_MODE: "observe",
  GC_IDLE_SEC: 600,
  SIM_ACTIVE_CPU_SEC: 2,
  MOBILE_TOOLING_IDLE_SEC: 300,
  TIER3_REQUIRE_NO_SESSION: 0,
  STALE_PASS_SEC: 300,
  LOG_THROTTLE_SEC: 1800,
  TIER1_MIN_AGE_SEC: 300,
  TIER1_MAX_CWD_LOOKUPS: 64,
  TIER2_ENABLED: 1,
  LIVENESS_SEC: 3600,
  TIER3_AGENT_TREE_GRACE_SEC: 1800,
  ROOT_TTL_DAYS: 14,
  ROOT_MAX: 64,
  MEASURE_MISSING_PCT_MAX: 10,
  HOST_MIN_DISK_GB: 10,
  HOST_MAX_SWAP_GB: 8,
  PRESSURE_SNAPSHOT_SEC: 300,
  AGENT_JOB_MAX_GB: 8,
  EXTRA_AGENTS: "",
  NOTIFY_ICON: "🧠",
};

export const MEMCAP_LAUNCH_AGENT_LABEL = "com.alextitov19.memcap";
