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
  /**
   * launchd skips a scheduled run while the last one is still going, so one stuck run cancels every cleanup after it.
   * The guard stops a run still going after this long and raises an alert naming the step it was stuck in.
   */
  runTimeoutMinutes: 60,
  /** Used only by the manual `review` command. */
  codex: {
    model: MODELS.codex.review.id,
    reasoningEffort: "low",
    timeoutMs: 5 * 60 * 1000,
  },
  /** Crossing any of these opens an alert. */
  thresholds: {
    /** Allocated swap near full matters only alongside elevated memory pressure. */
    maxSwapUsedRatio: 0.9,
    /** Physical footprint including compressed memory when available; otherwise ps RSS. */
    maxFseventsdMemoryGib: 2,
    maxSystemDaemonMemoryGib: 4,
    /** Pruning/diagnostic floor; alerts use criticalDiskFreeGib. */
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
    guard: {
      intervalSeconds: 60,
      hotPercent: 80,
      stopAfterMinutes: 10,
      idlePercent: 1,
      stopIdleAfterHours: 24,
    },
    /** Any process averaging this CPU over its life for this long is reported to the watcher, never stopped. */
    sustainedPercent: 80,
    sustainedMinMinutes: 30,
  },
  /**
   * Disk cleanup that runs before every snapshot with fixed rules and no AI. Paths are relative to home. Archived files
   * move to the external SSD and are skipped while it is unmounted; nothing a running process holds open is touched.
   */
  storage: {
    archiveVolume: "/Volumes/DevSSD",
    archiveRoot: "/Volumes/DevSSD/archive",
    /** Below this internal free space, closed sessions and browser cache files expire sooner. */
    lowSpace: {
      freeGiB: 30,
      archiveFiles: [{ path: ".codex/sessions", days: 1, to: "codex-sessions" }],
      /** Only cache folders, never whole browser profiles, cookies, or login data. Paths may contain globs. */
      browserCaches: {
        days: 3,
        paths: [
          "Library/Caches/Google/Chrome/*/{Cache,Code Cache,GPUCache}",
          "Library/Application Support/Google/Chrome/{Default,Profile *}/{Cache,Code Cache,GPUCache,DawnGraphiteCache,DawnWebGPUCache}",
          "Library/Application Support/Google/Chrome/GPUPersistentCache/GPUCache",
          "Library/Application Support/{t3code,t3code-v2}/Partitions/t3code-preview-*/{Cache,Code Cache,GPUCache,DawnGraphiteCache,DawnWebGPUCache}",
          ".t3/userdata/server-browser/profiles/*/{Default,Profile *}/{Cache,Code Cache,GPUCache,DawnGraphiteCache,DawnWebGPUCache}",
        ],
      },
    },
    /**
     * Each direct child older than `days` is deleted; `match` limits which children count. Xcode records the project
     * each DerivedData folder builds; a folder whose project is gone, such as a removed worktree's or a cleared native
     * build's, goes once untouched for `projectGoneHours`, because agents leave 3 to 4 GB behind per worktree build.
     */
    deleteChildren: [
      {
        path: "Library/Developer/Xcode/DerivedData",
        days: 14,
        match: /-[a-z]{28}$/,
        projectGoneHours: 1,
      },
    ],
    /**
     * Leftovers that agent runs drop in `/private/tmp` and the per-user temp folder, such as demo renders, QA copies, and
     * package-install scratch folders. A direct child this user owns goes once it and its direct entries are untouched for
     * `days`. Live services keep sockets and locks there, so sockets, folders holding one, folders macOS protects, and `skip`
     * names always stay.
     */
    temp: {
      days: 2,
      skip: /^(com\.apple\.|tmux-|boost_interprocess$|TemporaryItems$)|\.(sock|lock|pid)$/,
      /** Named disposable tool output expires sooner, but activity anywhere inside it restarts the clock. */
      toolCaches: {
        days: 1,
        match:
          /^(jest[_-]|mago(?:[-_.]|$)|instruments(?:[-_.]|$)|metro-cache(?:[-_.]|$)|node-compile-cache(?:[-_.]|$)|playwright-transform-cache(?:[-_.]|$)|react-doctor-cache(?:[-_.]|$)|rector_cached_files(?:[-_.]|$)|bunx-\d+-jest@)|\.trace$/i,
      },
    },
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
     * Linked worktrees of active projects and my-setup are removed once unlocked, unused, and idle. Finished PR branches
     * go after `landed` idle days and the four-hour PR/commit/file grace period, even with unpublished changes, only after
     * a verified patch, untracked-file copy, and self-contained commit bundle reach the mounted archive SSD. Branches stay.
     * Clean detached heads go after 24 hours without git or file activity; ancestry alone never proves branch work finished.
     * Unlanded branches without an open PR expire after `thread` idle days when bound to a settled or idle T3 thread,
     * or `abandoned` idle days without a bound thread. Git activity or a changed file restarts the idle window. A running
     * T3 thread protects its checkout; T3 recreates a removed checkout from its kept branch if the thread resumes.
     * A worktree under four hours old stays while any thread in its project is busy,
     * since it may not be bound to its thread yet. Only agent-managed folders under ~/.t3/worktrees or a project root count. Registered worktrees also protect their parent temporary directory from ordinary temp pruning.
     */
    worktreeIdleDays: { landed: 0, abandoned: 7, thread: 3 },
    agentWorktreeDirs: ["/.claude/worktrees/", "/.codex/worktrees/", "/.t3/worktrees/"],
    /**
     * Installed packages and build output in every kept agent worktree, including open PRs and uncommitted work, go after
     * `idleHours` without an open file, a running bound T3 thread, git activity, or any changed file in the checkout.
     * Resuming work reinstalls dependencies and regenerates builds. Only git-ignored folders matching `ignored` or
     * `dependencies.dir` count; any tracked descendant protects its whole folder. Generated native projects, build output,
     * node_modules, and vendor are cleared together. Tracked files are never deleted.
     */
    nativeBuilds: {
      idleHours: 24,
      ignored:
        /(^|\/)(android|ios|build|dist|\.next|\.nuxt|\.output|\.turbo|\.expo)\/$|\/(android|ios)\/(\.cxx|\.gradle|Pods)\/$/,
      dependencies: { dir: /(^|\/)(node_modules|vendor)\/$/ },
    },
    /**
     * Local MySQL test databases go once their recorded checkout is gone. Active projects' families also go once idle
     * this long, even while the checkout exists: their suites rebuild missing databases. Parallel copies follow theirs.
     * File mtimes survive server restarts; live connections and test runners protect databases from being dropped in use.
     */
    testDatabases: {
      match: /(^|_)testing(_|$)/,
      markerTable: "testing_checkout",
      idleDays: 3,
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
