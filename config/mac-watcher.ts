import { MODELS } from "./models";

/**
 * Mac resource watcher managed by my-setup.
 *
 * memcap does the minute-by-minute memory cleanup with fixed rules, and the CPU guard does the same for leftover agent
 * tooling that burns CPU or sits idle for a day. The watcher runs on a schedule with fixed rules and no AI: it prunes disk, takes a snapshot, and
 * raises threshold alerts that `doctor` shows until the numbers recover. `mac-watcher review` asks Codex to diagnose the
 * current snapshot on demand; it never kills processes or changes stored state.
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
  /** Used only by the manual `review` command. */
  codex: {
    model: MODELS.codex.review.id,
    reasoningEffort: "low",
    timeoutMs: 5 * 60 * 1000,
  },
  /** Crossing any of these opens an alert. */
  thresholds: {
    /** macOS keeps swap long after pressure passes, so only heavy swap counts. */
    maxSwapUsedGib: 12,
    minDiskFreeGib: 20,
    criticalDiskFreeGib: 10,
    /** Processes whose parent died, matching agent tooling, older than this, count as leaks. */
    orphanMinAgeMinutes: 60,
  },
  cpu: {
    /**
     * Leftover agent tooling (parent exited) is stopped after staying at `hotPercent` CPU for `stopAfterMinutes`, or
     * below `idlePercent` for `stopIdleAfterHours`, since nothing uses a leftover that idle. Nothing else is stopped.
     */
    guard: { intervalSeconds: 60, hotPercent: 80, stopAfterMinutes: 10, idlePercent: 1, stopIdleAfterHours: 24 },
    /** Any process averaging this CPU over its life for this long is reported to the watcher, never stopped. */
    sustainedPercent: 80,
    sustainedMinMinutes: 30,
    /** A 15-minute load average above cores times this opens an alert. */
    maxLoadPerCore: 1,
  },
  /**
   * Disk cleanup that runs before every snapshot with fixed rules and no AI. Paths are relative to home. Archived files
   * move to the external SSD and are skipped while it is unmounted; nothing a running process holds open is touched.
   */
  storage: {
    archiveVolume: "/Volumes/DevSSD",
    archiveRoot: "/Volumes/DevSSD/archive",
    /** Each direct child older than `days` is deleted; `match` limits which children count. */
    deleteChildren: [
      { path: ".maestro/tests", days: 3 },
      { path: "Library/Developer/Xcode/DerivedData", days: 14, match: /-[a-z]{28}$/ },
    ],
    /**
     * Leftovers that agent runs drop in `/private/tmp` and the per-user temp folder, such as demo renders, QA copies, and
     * package-install scratch folders. A direct child this user owns goes once it and its direct entries are untouched for
     * `days`. Live services keep sockets and locks there, so sockets, folders holding one, folders macOS protects, and `skip`
     * names always stay.
     */
    temp: { days: 2, skip: /^(com\.apple\.|tmux-|boost_interprocess$|TemporaryItems$)|\.(sock|lock|pid)$/ },
    /**
     * iOS simulators and Android emulators. Agents create one for most device tasks, and each keeps its installed apps and
     * data, 1 to 4 GB. One that is not running and was unused for `days` is deleted; agents create a fresh one when they
     * need it. Names matching `keep`, such as each project's main device, always stay.
     */
    devices: { days: 1, keep: /(^|[\s_-])main$/i },
    /** Files older than `days` move to the same relative path under `archiveRoot/to`. */
    archiveFiles: [
      { path: ".codex/sessions", days: 14, to: "codex/sessions" },
      { path: ".codex/generated_images", days: 14, to: "codex/generated_images" },
    ],
    /**
     * Codex keeps a second copy of every thread, screenshots included, in a history database that never shrinks. A
     * thread idle for `threadIdleDays` whose session file the archive already took is deleted through Codex, which
     * removes its rows, and the freed space is then returned. Codex installs each update next to the old versions, about
     * 300 MB each; all but the current one and the newest `keepReleases - 1` others go unless a running process uses one.
     */
    codex: { threadIdleDays: 14, keepReleases: 2 },
    /**
     * Linked worktrees of active projects are removed once clean, unlocked, unused, and idle; their branches stay, so no
     * commit is lost. A landed worktree, whose commits are on the base branch or in a finished PR, goes after `landed`
     * idle days, so 0 removes it at the next run; T3 recreates a thread's checkout from its branch if the thread resumes.
     * Any other branch without an open PR counts as abandoned after `abandoned` idle days. Agents open several
     * worktrees a day, each holding gigabytes of dependencies and native builds, so a long wait fills the disk. Only
     * worktrees under these agent-managed folders count; worktrees a person placed elsewhere are never touched.
     */
    worktreeIdleDays: { landed: 0, abandoned: 7 },
    agentWorktreeDirs: ["/.claude/worktrees/", "/.codex/worktrees/", "/.t3/worktrees/"],
    /**
     * Native build output in agent worktrees that stay, such as for an open PR or uncommitted work: 2 to 12 GB each,
     * written fresh per worktree because the builds record the worktree's own path. It goes once nothing runs in the
     * worktree, git saw no activity there, and no file in the output changed for `idleHours`; the next device build
     * regenerates it. Only folders git ignores count, so no source file is touched. `ignored` matches what git lists,
     * relative to the worktree: generated native projects, such as Expo's `ios/` and `android/`, and native build
     * folders. Git lists an ignored dependency folder as a whole, so each one matching `dependencies.dir` is searched for
     * native modules' build folders matching `dependencies.builds`.
     */
    nativeBuilds: {
      idleHours: 6,
      ignored: /(^|\/)(android|ios)\/$|\/(android|ios)\/(build|\.cxx|\.gradle|Pods)\/$/,
      dependencies: { dir: /(^|\/)node_modules\/$/, builds: ["*/android/build", "*/android/.cxx"] },
    },
    /**
     * Local MySQL test databases go once the checkout that built them is gone. Each active project's suite records its
     * checkout's path in a `testing_checkout` table. An active project's database without one goes once untouched this
     * long, because the suite rebuilds a missing database. Parallel workers' copies (`<name>_test_<n>`) follow theirs.
     */
    testDatabases: {
      match: /(^|_)testing(_|$)/,
      markerTable: "testing_checkout",
      unmarkedDays: 14,
      mysqlArgs: ["-h", "127.0.0.1", "-u", "root"],
    },
  },
  /** Consecutive runs without seeing an alert before it closes on its own. */
  autoResolveAfterClearRuns: 2,
  /** Runs kept in the watcher's history. */
  historyLimit: 60,
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
