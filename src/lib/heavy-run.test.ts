import { expect, test, spyOn } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyQueueState } from "./device-queue";
import { claimHostCapacity, reapHostCapacity, type HostJob } from "./host-capacity";
import {
  heavyHistoryPath,
  withProcessState,
  type HeavyHistoryEntry,
  type HeavyReceipt,
} from "./heavy-run";
import { withQueueState } from "./queue-store";
import { heavyRequester } from "./heavy-requester";
import type { ProcessRow } from "./process-identity";

const modulePath = fileURLToPath(new URL("./heavy-run.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../commands/heavy-run-cli.ts", import.meta.url));

// Filesystem events synchronize real competing processes, with a timeout only
// as a failure guard. No timing sleeps or network calls in these tests.
function until(directory: string, condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, check);
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error("Process fixture did not reach its checkpoint"));
    }, 5000);

    function check() {
      if (!condition()) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    }

    check();
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "heavy-run-test-"));
  const directory = join(root, "queue");
  const legacyLockPath = join(root, "legacy-lock");
  mkdirSync(directory);
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const logDirectories = new Set<string>();
  const state = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  const start = (owner: string, gated = true, waitSeconds = 5, exitCode = 0) => {
    const command = `import {writeFileSync, existsSync, watch} from "node:fs";
      const root = ${JSON.stringify(root)};
      ${gated ? `const wait = new Promise(resolve => { const w=watch(root,()=> { if(existsSync(root+"/${owner}-release")) { w.close(); resolve(); } }); });` : ""}
      writeFileSync(root+"/${owner}-started", "started");
      ${gated ? "await wait;" : ""}
      process.exit(${exitCode});`;
    const script = `import { runHeavyCommand } from ${JSON.stringify(modulePath)};
      const abort = new AbortController();
      process.on("SIGTERM", ()=>abort.abort());
      const receipt = await runHeavyCommand(${JSON.stringify({ argv: [process.execPath, "-e", command], class: "checks", waitSeconds, owner, requester: owner, directory, legacyLockPath }).slice(0, -1)}, signal: abort.signal });
      console.log(JSON.stringify(receipt)); process.exitCode = receipt.exitCode;`;
    const processHandle = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(processHandle);
    let output = "";
    let errors = "";
    processHandle.stdout!.on("data", (data) => {
      output += data;
    });
    processHandle.stderr!.on("data", (data) => {
      errors += data;
    });
    const result = new Promise<HeavyReceipt>((resolve, reject) => {
      processHandle.on("close", () => {
        try {
          const receipt = JSON.parse(output);
          if (receipt.log) logs.push(receipt.log);
          resolve(receipt);
        } catch {
          reject(new Error(`No receipt: ${errors}`));
        }
      });
    });
    // Crashed-holder tests intentionally terminate a process without a receipt.
    result.catch(() => {});

    return { processHandle, result };
  };

  return {
    root,
    directory,
    legacyLockPath,
    state,
    start,
    async started(owner: string) {
      await until(root, () => existsSync(join(root, `${owner}-started`)));
      if (existsSync(legacyLockPath)) logDirectories.add(join(readlinkSync(legacyLockPath), ".."));
    },
    release: (owner: string) => writeFileSync(join(root, `${owner}-release`), "release"),
    queued: (count: number) =>
      until(
        directory,
        () => existsSync(join(directory, "state.json")) && state().host.waiting.length === count,
      ),
    async clean() {
      if (existsSync(join(directory, "state.json"))) {
        const active = state().host?.active;
        if (active?.processGroup) {
          try {
            process.kill(-active.processGroup.pid, "SIGKILL");
          } catch {}
        }
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGKILL");
          await closed;
        }
      }
      for (const log of logs) rmSync(join(log, ".."), { recursive: true, force: true });
      for (const logDirectory of logDirectories)
        rmSync(logDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("24 contenders survive a slow/crashed writer beyond the old lock deadline without losing tickets", async () => {
  const f = fixture();
  const original = { leases: {}, tickets: {}, unleasedSince: { device: 456 } };
  writeFileSync(join(f.directory, "state.json"), JSON.stringify(original));
  const child = spawn(
    process.execPath,
    [
      "-e",
      `import {dlopen} from "bun:ffi"; import {openSync,writeFileSync} from "node:fs";
      const {symbols:{flock}}=dlopen(${JSON.stringify(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6")}, {flock:{args:["i32","i32"],returns:"i32"}});
      flock(openSync(${JSON.stringify(join(f.directory, "state.lock"))},"a"),2);
      writeFileSync(${JSON.stringify(join(f.root, "writer-started"))},"ready");
      await new Promise(()=>{});`,
    ],
    { stdio: "ignore" },
  );
  try {
    await f.started("writer");
    // Advance the clock past the former 30s deadline while the real flock is
    // held. No thirty-second sleep, and an old implementation fails immediately.
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 31_000));
    const pending = Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        withQueueState((state) => {
          claimHostCapacity(state, ticket(`waiter-${index}`, `requester-${index % 4}`), 0, true);
          expect(state.unleasedSince.device).toBe(456);
        }, f.directory),
      ),
    );
    pending.catch(() => {});
    clock.mockRestore();

    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
    expect(child.signalCode).toBe("SIGKILL");
    await pending;
    await withQueueState((state) => {
      expect(state.unleasedSince.device).toBe(456);
      expect(state.host.capacity).toBe(1);
      expect(state.host.waiting).toHaveLength(24);
      expect(new Set(state.host.waiting.map((job) => job.reservationId)).size).toBe(24);
      expect(state.host.waiting.map((job) => job.sequence)).toEqual(
        Array.from({ length: 24 }, (_, i) => i),
      );
    }, f.directory);
  } finally {
    child.kill("SIGKILL");
    await f.clean();
  }
});

test("a stalled process listing holds no lock and a changed queue invalidates its stale snapshot", async () => {
  const f = fixture();
  const deferred = Promise.withResolvers<ProcessRow[]>();
  const newer = ticket("new-worker", "session");
  const row = { ...newer.holder, pgid: newer.holder.pid, state: "S" };
  let snapshots = 0;
  try {
    const status = withProcessState(
      (state, rows) => {
        reapHostCapacity(state, rows);
        return state.host.active?.reservationId;
      },
      f.directory,
      f.legacyLockPath,
      () => (++snapshots === 1 ? deferred.promise : Promise.resolve([row])),
    );

    // This transaction must complete even while the process listing is stalled.
    await withQueueState((state) => {
      claimHostCapacity(state, newer, 0, false);
    }, f.directory);
    deferred.resolve([]);
    expect(await status).toBe("new-worker");
    expect(snapshots).toBe(2);
  } finally {
    deferred.resolve([]);
    await f.clean();
  }
});

test("asynchronous transactions are rejected without persisting partial state", async () => {
  const f = fixture();
  try {
    await expect(
      withQueueState(
        // @ts-expect-error Queue callbacks must stay synchronous, including at compile time.
        async (state) => {
          state.unleasedSince.device = 456;
        },
        f.directory,
      ),
    ).rejects.toThrow("Queue transactions must be synchronous");
    expect(existsSync(join(f.directory, "state.json"))).toBe(false);
  } finally {
    await f.clean();
  }
});

test("waiters arriving during a process listing keep their tickets until a fresh observation", async () => {
  const f = fixture();
  const deferred = Promise.withResolvers<ProcessRow[]>();
  const newer = ticket("new-waiter", "session");
  try {
    const reap = (
      state: ReturnType<typeof emptyQueueState>,
      rows: ProcessRow[],
      observed: HostJob[],
    ) => {
      reapHostCapacity(state, rows, observed);
      return state.host.waiting.map((job) => job.reservationId);
    };
    const status = withProcessState(reap, f.directory, f.legacyLockPath, () => deferred.promise);
    await withQueueState((state) => {
      claimHostCapacity(state, newer, 0, true);
    }, f.directory);
    deferred.resolve([]);

    expect(await status).toEqual(["new-waiter"]);
    expect(
      await withProcessState(reap, f.directory, f.legacyLockPath, () => Promise.resolve([])),
    ).toEqual([]);
  } finally {
    deferred.resolve([]);
    await f.clean();
  }
});

test("competing callers run in FIFO order and preserve device leases in the shared store", async () => {
  const f = fixture();
  try {
    const first = f.start("first");
    await f.started("first");
    await withQueueState((state) => {
      state.unleasedSince.device = 123;
    }, f.directory);
    const second = f.start("second");
    await f.queued(1);
    const third = f.start("third", false);
    await f.queued(2);
    expect(existsSync(join(f.root, "second-started"))).toBe(false);
    expect(f.state().host.waiting.map((job: HostJob) => job.owner)).toEqual(["second", "third"]);

    f.release("first");
    await f.started("second");
    expect(existsSync(join(f.root, "third-started"))).toBe(false);
    f.release("second");
    const receipts = await Promise.all([first.result, second.result, third.result]);
    expect(receipts.map((receipt) => receipt.exitCode)).toEqual([0, 0, 0]);
    expect(f.state().unleasedSince.device).toBe(123);
    expect(f.state().host.active).toBeNull();
    expect(f.state().host.waiting).toEqual([]);
    expect(existsSync(f.legacyLockPath)).toBe(false);

    const history: HeavyHistoryEntry[] = readFileSync(heavyHistoryPath(f.directory), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(history.map((run) => run.owner)).toEqual(["first", "second", "third"]);
    expect(history.every((run) => run.status === "succeeded" && run.acquiredAt !== null)).toBe(
      true,
    );
  } finally {
    await f.clean();
  }
});

test("a crashed holder keeps its slot while its group lives, then is recovered", async () => {
  const f = fixture();
  try {
    const first = f.start("crashed");
    await f.started("crashed");
    const closed = new Promise<void>((resolve) =>
      first.processHandle.once("close", () => resolve()),
    );
    first.processHandle.kill("SIGKILL");
    await closed;
    const second = f.start("next", false);
    await f.queued(1);
    expect(f.state().host.active.owner).toBe("crashed");
    expect(existsSync(join(f.root, "next-started"))).toBe(false);

    f.release("crashed");
    expect((await second.result).exitCode).toBe(0);
    expect(f.state().host.active).toBeNull();
  } finally {
    await f.clean();
  }
});

test("a timeout never starts the child and removes its waiting ticket", async () => {
  const f = fixture();
  try {
    const first = f.start("held");
    await f.started("held");
    const timeout = await f.start("timeout", false, 0).result;
    expect(timeout).toMatchObject({
      schemaVersion: 1,
      status: "timed-out",
      exitCode: 75,
      childExitCode: null,
      acquiredAt: null,
      resourceBudget: { resource: "host-capacity", capacity: 1 },
    });
    expect(existsSync(join(f.root, "timeout-started"))).toBe(false);
    expect(f.state().host.waiting).toEqual([]);
    expect(f.state().host.active.owner).toBe("held");
    f.release("held");
    await first.result;
  } finally {
    await f.clean();
  }
});

test("legacy mkdir callers block heavy-run and their lock is never removed", async () => {
  const f = fixture();
  try {
    mkdirSync(f.legacyLockPath);
    expect((await f.start("blocked", false, 0).result).exitCode).toBe(75);
    expect(existsSync(f.legacyLockPath)).toBe(true);
    expect(existsSync(join(f.root, "blocked-started"))).toBe(false);
    rmSync(f.legacyLockPath, { recursive: true });
    expect((await f.start("unblocked", false).result).exitCode).toBe(0);
  } finally {
    await f.clean();
  }
});

test("child failures retain the original exit code and cancellation frees the group", async () => {
  const f = fixture();
  try {
    expect(await f.start("failure", false, 5, 42).result).toMatchObject({
      status: "failed",
      exitCode: 1,
      childExitCode: 42,
    });
    const active = f.start("signal");
    await f.started("signal");
    active.processHandle.kill("SIGTERM");
    expect(await active.result).toMatchObject({ status: "cancelled", exitCode: 1 });
    expect((await f.start("after-signal", false).result).exitCode).toBe(0);
  } finally {
    await f.clean();
  }
});

test("a reserved command never inherits the caller's .env", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".env"), "HEAVY_RUN_ENV_PROBE=leaked\n");
    const probe = join(f.root, "probe");
    const argv = [
      "/bin/sh",
      "-c",
      `printf %s "\${HEAVY_RUN_ENV_PROBE:-unset}" > ${JSON.stringify(probe)}`,
    ];
    const script = `import { runHeavyCommand } from ${JSON.stringify(modulePath)};
      const receipt = await runHeavyCommand(${JSON.stringify({ argv, class: "checks", waitSeconds: 5, owner: "env", directory: f.directory, legacyLockPath: f.legacyLockPath })});
      console.log(JSON.stringify(receipt)); process.exitCode = receipt.exitCode;`;

    // The launcher runs the CLI with --no-env-file from the caller's directory, so the fixture does the same.
    const run = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
      cwd: f.root,
      encoding: "utf8",
    });
    const receipt = JSON.parse(run.stdout);
    if (receipt.log) rmSync(join(receipt.log, ".."), { recursive: true, force: true });

    expect(receipt.exitCode).toBe(0);
    expect(readFileSync(probe, "utf8")).toBe("unset");
  } finally {
    await f.clean();
  }
});

test("stale recovery validates PID identity and keeps descendants after their leader exits", () => {
  const state = emptyQueueState();
  const identity = {
    pid: 100,
    startedAt: "Mon Oct 12 12:00:00 2026",
    command: "worker unique-reservation",
  };
  const job: HostJob = {
    reservationId: "id",
    sequence: 0,
    owner: "one",
    class: "build",
    argv: ["build"],
    queuedAt: 0,
    acquiredAt: null,
    holder: identity,
    processGroup: identity,
  };
  claimHostCapacity(state, job, 1, false);
  const descendant: ProcessRow = {
    pid: 101,
    pgid: 100,
    state: "S",
    startedAt: "Mon Oct 12 12:00:01 2026",
    command: "compiler",
  };
  reapHostCapacity(state, [descendant]);
  expect(state.host.active).not.toBeNull();
  reapHostCapacity(state, [
    { ...identity, pgid: 100, state: "S", startedAt: "Tue Oct 13 12:00:00 2026" },
  ]);
  expect(state.host.active).toBeNull();
});

function ticket(id: string, requester?: string): HostJob {
  return {
    reservationId: id,
    sequence: 0,
    owner: id,
    requester,
    class: "benchmark",
    argv: [id],
    queuedAt: 0,
    acquiredAt: null,
    holder: { pid: 100, startedAt: "start", command: "holder" },
    processGroup: null,
  };
}

test("requesters rotate while each requester keeps FIFO, regardless of class or polling order", () => {
  const state = emptyQueueState();
  const active = ticket("a0", "A");
  expect(claimHostCapacity(state, active, 0, false)).toBe(true);
  const jobs = [
    ticket("a1", "A"),
    ticket("a2", "A"),
    ticket("b1", "B"),
    ticket("b2", "B"),
    ticket("c1", "C"),
  ];
  jobs[1].class = "checks";
  jobs[3].class = "checks";
  for (const job of jobs) expect(claimHostCapacity(state, job, 1, false)).toBe(false);

  const sequence = jobs.map((job) => job.sequence);
  const order: string[] = [];
  while (jobs.length) {
    state.host.active = null;
    const granted = [...jobs].reverse().find((job) => claimHostCapacity(state, job, 2, false));
    expect(granted).toBeDefined();
    order.push(granted!.reservationId);
    jobs.splice(jobs.indexOf(granted!), 1);
  }
  expect(order).toEqual(["b1", "c1", "a1", "b2", "a2"]);
  expect(sequence).toEqual([1, 2, 3, 4, 5]);
});

test("a vanished requester leaves no turn blocking surviving requesters", () => {
  const state = emptyQueueState();
  const a = ticket("a", "A");
  const dead = ticket("dead", "gone");
  dead.holder.pid = 101;
  const b = ticket("b", "B");
  for (const job of [a, dead, b]) claimHostCapacity(state, job, 0, true);
  reapHostCapacity(state, [{ ...a.holder, pgid: 100, state: "S" }]);

  expect(claimHostCapacity(state, a, 1, false)).toBe(true);
  state.host.active = null;
  expect(claimHostCapacity(state, b, 2, false)).toBe(true);
  expect(state.host.waiting).toEqual([]);
  expect(state.host.requesters).not.toContain("gone");
});

test("old tickets drain with the existing selector and keep IDs and sequences across new transactions", async () => {
  const f = fixture();
  try {
    const state = emptyQueueState();
    const old = ticket("old");
    const newer = ticket("new", "session");
    claimHostCapacity(state, old, 0, true);
    writeFileSync(join(f.directory, "state.json"), JSON.stringify(state));
    await withQueueState((state) => {
      expect(claimHostCapacity(state, newer, 1_000_000, false)).toBe(false);
      expect(state.host.waiting[0]).toEqual(old);
      // This is the loaded old caller's FIFO claim, preserving unknown fields.
      state.host.active = state.host.waiting.shift()!;
    }, f.directory);
    await withQueueState((state) => {
      state.host.active = null;
      expect(claimHostCapacity(state, newer, 1_000_001, false)).toBe(true);
      expect(state.host.active!.sequence).toBe(1);
    }, f.directory);
  } finally {
    await f.clean();
  }
});

test("requester identity prefers the session and otherwise uses the worktree root", () => {
  const root = mkdtempSync(join(tmpdir(), "heavy-requester-test-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, ".git"), "gitdir: /not/the/requester");
    expect(heavyRequester({ T3_THREAD_ID: "t3", CODEX_THREAD_ID: "codex" }, root)).toBe(
      "T3_THREAD_ID:t3",
    );
    expect(heavyRequester({ CODEX_THREAD_ID: "codex" }, root)).toBe("CODEX_THREAD_ID:codex");
    expect(heavyRequester({}, join(root, "nested"))).toBe(heavyRequester({}, root));
    expect(heavyRequester({}, root)).toBe(`worktree:${realpathSync(root)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects bad input and status has one line or a versioned JSON receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "heavy-cli-test-"));
  try {
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cliPath, ...args], {
        env: { ...process.env, XDG_STATE_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: await child.exited,
        output: await new Response(child.stdout).text(),
        errors: await new Response(child.stderr).text(),
      };
    };
    const invalid = await run(["--class", "invalid", "--json", "--", "true"]);
    const receipt = JSON.parse(invalid.output);
    expect(invalid.code).toBe(2);
    expect(receipt.status).toBe("invalid-input");
    rmSync(join(receipt.log, ".."), { recursive: true });
    expect((await run(["status"])).output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse((await run(["status", "--json"])).output)).toMatchObject({
      schemaVersion: 1,
      active: null,
      waiting: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
