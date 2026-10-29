import { expect, test as bunTest, spyOn } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyQueueState } from "./device-queue";
import {
  claimHostCapacity,
  parseCpuIdle,
  reapHostCapacity,
  type HostJob,
  type MemoryPressure,
  type HeavyClass,
} from "./host-capacity";
import {
  heavyHistoryPath,
  describeLoadHold,
  heavyLoadAdmission,
  HEAVY_LOAD_POLICY,
  runHeavyCommand,
  deferredHeavyCommand,
  uncappedHeavyCommand,
  withProcessState,
  type HeavyHistoryEntry,
  type HeavyReceipt,
} from "./heavy-run";
import {
  heavyStatus as concurrentStatus,
  withConcurrentProcessState,
  readConcurrentCapacity,
  startCompatibilityDispatcher,
} from "./heavy-run-concurrent";
import {
  claimConcurrentCapacity,
  reapConcurrentCapacity,
  releaseConcurrentCapacity,
  emptyConcurrentCapacity,
  HEAVY_CAPACITY,
} from "./concurrent-capacity";
import { recoverLegacyLock, releaseLegacyLock } from "./heavy-legacy-lock";
import { parseMemoryPressure, releaseHostCapacity } from "./host-capacity";
import { withQueueState } from "./queue-store";
import { prepareConcurrentTurns, CURRENT_HEAVY_CLIENT } from "./concurrent-turns";
import { expressHeavyCommand, heavyProject, readHeavyHistory } from "./heavy-express";
import { heavyRequester } from "./heavy-requester";
import type { ProcessRow } from "./process-identity";

const modulePath = fileURLToPath(new URL("./heavy-run.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../commands/heavy-run-cli.ts", import.meta.url));
// Watchdogs allow OS scheduling under load; IPC still advances every checkpoint immediately.
const PROCESS_TIMEOUT = 15_000;
const test = (name: string, run: () => void | Promise<void>) => bunTest(name, run, PROCESS_TIMEOUT);

function testEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(([key]) => !key.startsWith("HEAVY_RUN_")),
    ),
    ...overrides,
  };
}

// Explicit IPC checkpoints synchronize processes; the timeout is only a failure guard.
function until(events: EventEmitter, condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    events.on("checkpoint", check);
    const timer = setTimeout(() => {
      events.off("checkpoint", check);
      reject(new Error("Process fixture did not reach its checkpoint"));
    }, PROCESS_TIMEOUT - 1000);

    function check() {
      if (!condition()) return;
      clearTimeout(timer);
      events.off("checkpoint", check);
      resolve();
    }

    check();
  });
}

function fixture(concurrent = false, load = 0) {
  const selectedModule = concurrent
    ? fileURLToPath(new URL("./heavy-run-concurrent.ts", import.meta.url))
    : modulePath;
  const root = mkdtempSync(join(tmpdir(), "heavy-run-test-"));
  const directory = join(root, "queue");
  const legacyLockPath = join(root, "legacy-lock");
  mkdirSync(directory);
  writeFileSync(join(root, "load"), String(load));
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const logDirectories = new Set<string>();
  const events = new EventEmitter();
  const sockets = new Map<string, Socket>();
  const queued = new Set<string>();
  const socketPath = join(root, "ready.sock");
  const server = createServer((socket) => {
    let message = "";
    socket.on("data", (data) => {
      message += data;
      if (!message.endsWith("\n")) return;
      sockets.set(message.trim(), socket);
      events.emit("checkpoint");
    });
  }).listen(socketPath);
  const state = () => {
    const legacy = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    return concurrent ? { ...legacy, host: readConcurrentCapacity(directory) } : legacy;
  };
  const command = (owner: string, gated = true, exitCode = 0) =>
    `import {writeFileSync} from "node:fs"; import {connect} from "node:net";
      const root = ${JSON.stringify(root)};
      const socket = connect(${JSON.stringify(socketPath)});
      const released = new Promise(resolve => socket.on("end", resolve));
      socket.resume();
      writeFileSync(root+"/${owner}-started", "started");
      await new Promise((resolve, reject) => socket.write(${JSON.stringify(`${owner}\n`)}, error => error ? reject(error) : resolve()));
      ${gated ? "await released;" : ""}
      socket.destroy();
      process.exit(${exitCode});`;
  const start = (
    owner: string,
    gated = true,
    waitSeconds = 30,
    exitCode = 0,
    deferred = false,
    source = command(owner, gated, exitCode),
    className: HeavyClass = "checks",
    implementation = selectedModule,
    deadline = false,
    cwd = process.cwd(),
    runtimeLimitSeconds?: number,
  ) => {
    const script = `import { runHeavyCommand } from ${JSON.stringify(implementation)};
      import { readFileSync } from "node:fs";
      const abort = new AbortController();
      process.on("SIGTERM", ()=>abort.abort());
      const receipt = await runHeavyCommand(${JSON.stringify({ argv: [process.execPath, "-e", source], class: className, waitSeconds, owner, requester: owner, directory, legacyLockPath, deferred, ...(runtimeLimitSeconds === undefined ? {} : { runtimeLimitSeconds }) }).slice(0, -1)}, waitForCapacityRetry: async (_timeout, _signal, onWaiting) => { onWaiting?.(); await Bun.sleep(10); }, readPressure: () => "normal", readCpuIdle: () => 0, readLoad: () => Number(readFileSync(${JSON.stringify(join(root, "load"))}, "utf8")), signal: abort.signal, ${deadline ? `scheduleRuntimeDeadline: (expire, milliseconds) => { if(milliseconds !== ${(runtimeLimitSeconds ?? 90) * 1000}) throw new Error("Wrong deadline"); process.stdin.once("data", expire); return () => { process.stdin.removeListener("data", expire); process.stdin.pause(); }; },` : ""} onQueued: () => console.log(JSON.stringify({queued: true})) });
      console.log(JSON.stringify(receipt)); process.exitCode = receipt.exitCode;`;
    const processHandle = spawn(process.execPath, ["--no-env-file", "-e", script], {
      cwd,
      env: testEnvironment({ TMPDIR: root }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(processHandle);
    let output = "";
    let errors = "";
    processHandle.stdout!.on("data", (data) => {
      output += data;
      let index: number;
      while ((index = output.indexOf("\n")) >= 0 && JSON.parse(output.slice(0, index)).queued) {
        output = output.slice(index + 1);
        queued.add(owner);
        events.emit("checkpoint");
      }
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
    command,
    socketPath,
    // Admission tests need occupied slots, not ten copies of the same OS job.
    // Keep a real group's identity so recovery still validates the live anchor.
    async occupySlots(anchor: string, owners: string[]) {
      await withConcurrentProcessState(
        (state) => {
          const job = state.host.active.find((job) => job.owner === anchor)!;
          for (const owner of owners)
            state.host.active.push({
              ...structuredClone(job),
              owner,
              requester: owner,
              reservationId: crypto.randomUUID(),
              sequence: state.host.nextSequence++,
            });
        },
        directory,
        legacyLockPath,
      );

      return () =>
        withConcurrentProcessState(
          (state) => {
            state.host.active = state.host.active.filter((job) => !owners.includes(job.owner));
          },
          directory,
          legacyLockPath,
        );
    },
    async started(owner: string) {
      await until(events, () => sockets.has(owner));
      if (!concurrent && existsSync(legacyLockPath))
        logDirectories.add(join(readlinkSync(legacyLockPath), ".."));
    },
    release: (owner: string) => {
      sockets.get(owner)!.end();
      sockets.delete(owner);
    },
    queued: (count: number) => until(events, () => queued.size === count),
    queuedOwner: (owner: string) => until(events, () => queued.has(owner)),
    async clean() {
      if (existsSync(join(directory, "state.json"))) {
        const activeJobs = state().host?.active;
        for (const active of Array.isArray(activeJobs) ? activeJobs : [activeJobs]) {
          if (active?.processGroup) {
            try {
              process.kill(-active.processGroup.pid, "SIGKILL");
            } catch {}
          }
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
      for (const socket of sockets.values()) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      "--no-env-file",
      "-e",
      `import {dlopen} from "bun:ffi"; import {openSync,writeFileSync} from "node:fs";
      const {symbols:{flock}}=dlopen(${JSON.stringify(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6")}, {flock:{args:["i32","i32"],returns:"i32"}});
      flock(openSync(${JSON.stringify(join(f.directory, "state.lock"))},"a"),2);
      console.log("ready");
      await new Promise(()=>{});`,
    ],
    { env: testEnvironment(), stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Writer exited before readiness")));
    });
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
    // Receipts append after release, so completion order can differ from FIFO admission.
    expect(
      history
        .toSorted((a, b) => a.acquiredAt!.localeCompare(b.acquiredAt!))
        .map((run) => run.owner),
    ).toEqual(["first", "second", "third"]);
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

test("a deferred cache hit completes while another command owns the slot", async () => {
  const f = fixture();
  try {
    const held = f.start("held");
    await f.started("held");
    const cached = await f.start("cached", false, 0, 0, true).result;
    expect(cached).toMatchObject({
      status: "succeeded",
      acquiredAt: null,
      reservationMode: "deferred",
    });
    expect(f.state().host.active.owner).toBe("held");
    expect(f.state().host.waiting).toEqual([]);
    f.release("held");
    await held.result;
  } finally {
    await f.clean();
  }
});

test("a deferred runner releases between heavy steps and preserves the nested reservation guard", async () => {
  const f = fixture();
  try {
    const source = [
      "import {runHeavyCommand} from " + JSON.stringify(modulePath) + ";",
      'import {connect} from "node:net";',
      'if (process.env.HEAVY_RUN_DEFERRED !== "1" || process.env.HEAVY_RUN_RESERVATION_ID || !process.env.HEAVY_RUN_CLI) throw new Error("Missing deferred contract");',
      "const options = " +
        JSON.stringify({
          class: "checks",
          waitSeconds: 5,
          owner: "step",
          directory: f.directory,
          legacyLockPath: f.legacyLockPath,
        }) +
        ";",
      'const run = async (source) => { const result = await runHeavyCommand({...options, readPressure: () => "normal", readLoad: () => 0, argv:[process.execPath,"-e",source]}); if (result.exitCode !== 0) throw new Error(JSON.stringify(result)); };',
      "await run(" +
        JSON.stringify(
          'if (process.env.HEAVY_RUN_DEFERRED || !process.env.HEAVY_RUN_RESERVATION_ID) throw new Error("Missing eager contract");',
        ) +
        ");",
      "const socket = connect(" + JSON.stringify(f.socketPath) + ");",
      'const release = new Promise(resolve => socket.on("end",resolve)); socket.resume();',
      'socket.write("between-steps\\n"); await release; socket.destroy();',
      "await run(" + JSON.stringify(f.command("last-step", false)) + ");",
    ].join("\n");
    const composite = f.start("composite", false, 5, 0, true, source);
    await f.started("between-steps");
    expect(f.state().host.active).toBeNull();
    // The competitor finishes while the composite is paused in cheap work.
    expect((await f.start("other", false).result).exitCode).toBe(0);
    f.release("between-steps");
    expect((await composite.result).exitCode).toBe(0);
    expect(f.state().host.active).toBeNull();
  } finally {
    await f.clean();
  }
});

test("deferred declarations validate the whole shape and require an explicit argv prefix", async () => {
  const f = fixture();
  try {
    const path = join(f.root, "package.json");
    expect(deferredHeavyCommand(["mise", "run", "check"], f.root)).toBe(false);
    for (const config of [{}, { heavyRun: {} }, { heavyRun: { deferredCommands: [] } }]) {
      writeFileSync(path, JSON.stringify(config));
      expect(deferredHeavyCommand(["mise", "run", "check"], f.root)).toBe(false);
    }
    writeFileSync(
      path,
      JSON.stringify({ heavyRun: { deferredCommands: [["mise", "run", "check"]] } }),
    );
    expect(deferredHeavyCommand(["mise", "run", "check", "--json"], f.root)).toBe(true);
    expect(deferredHeavyCommand(["mise", "run", "signoff"], f.root)).toBe(false);
    for (const invalid of [
      null,
      "check",
      {},
      [[]],
      [["mise", 1]],
      [["mise", ""]],
      [["mise", "x\0"]],
    ]) {
      writeFileSync(path, JSON.stringify({ heavyRun: { deferredCommands: invalid } }));
      expect(() => deferredHeavyCommand(["true"], f.root)).toThrow(
        "Invalid heavy-run configuration",
      );
    }
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
      const receipt = await runHeavyCommand(${JSON.stringify({ argv, class: "checks", waitSeconds: 5, owner: "env", directory: f.directory, legacyLockPath: f.legacyLockPath }).slice(0, -1)}, readPressure: () => "normal", readLoad: () => 0});
      console.log(JSON.stringify(receipt)); process.exitCode = receipt.exitCode;`;

    // The launcher runs the CLI with --no-env-file from the caller's directory, so the fixture does the same.
    const run = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
      cwd: f.root,
      env: testEnvironment(),
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

test("responsiveness admits busy hosts, holds critical pressure, and preserves the starvation escape", () => {
  const job = { ...ticket("pressure"), class: "checks" as const };
  const admit = (
    now: number,
    active: HostJob[],
    pressure: "normal" | "warning" | "critical" | "unknown",
  ) =>
    heavyLoadAdmission(
      job,
      active,
      now,
      () => HEAVY_LOAD_POLICY.threshold,
      () => pressure,
    );

  for (const pressure of ["normal", "warning", "unknown"] as const)
    expect(admit(1, [], pressure).held).toBe(false);
  expect(admit(1, [], "critical").held).toBe(true);
  expect(admit(HEAVY_LOAD_POLICY.maxWaitMs, [], "critical").held).toBe(false);
  expect(admit(HEAVY_LOAD_POLICY.maxWaitMs, [ticket("active")], "critical").held).toBe(true);
  expect(parseMemoryPressure("4")).toBe("critical");
  expect(parseMemoryPressure("", "System-wide memory pressure: critical")).toBe("critical");
  expect(parseMemoryPressure("", "System-wide memory free percentage: 1%")).toBe("unknown");
});

test("high load holds only while CPU idle is under the floor, and the hold names the idle reading", () => {
  const job = { ...ticket("idle"), class: "checks" as const };
  const load = HEAVY_LOAD_POLICY.threshold + 1;
  const admit = (cpuIdle: number | undefined, pressure: MemoryPressure = "normal") =>
    heavyLoadAdmission(
      job,
      [],
      1,
      () => load,
      () => pressure,
      () => cpuIdle,
    );

  expect(admit(HEAVY_LOAD_POLICY.minCpuIdle).held).toBe(false);
  expect(admit(undefined).held).toBe(false);
  expect(admit(HEAVY_LOAD_POLICY.minCpuIdle - 1).held).toBe(true);
  expect(describeLoadHold(admit(4.4))).toBe(
    `load ${load.toFixed(1)} > ${HEAVY_LOAD_POLICY.threshold} with 4% CPU idle`,
  );
  expect(admit(80, "critical").held).toBe(true);
  expect(describeLoadHold(admit(80, "critical"))).toBe("critical memory pressure");
  let sampled = false;
  heavyLoadAdmission(
    job,
    [],
    1,
    () => HEAVY_LOAD_POLICY.threshold,
    () => "normal",
    () => ((sampled = true), 0),
  );
  expect(sampled).toBe(false);
  expect(parseCpuIdle("  150.0\n 50.0\n\n", 4)).toBe(50);
  expect(parseCpuIdle("900", 4)).toBe(0);
});

test("load admission preserves FIFO, recovers at the threshold, and admits overdue work singly", () => {
  const host = emptyConcurrentCapacity();
  const first = { ...ticket("first", "session"), class: "checks" as const };
  const second = { ...ticket("second", "session"), class: "build" as const };
  let load = HEAVY_LOAD_POLICY.threshold + 0.01;
  let now = 1;
  const claim = (job: HostJob) =>
    claimConcurrentCapacity(
      host,
      job,
      now,
      false,
      [],
      [],
      (next, active) =>
        !heavyLoadAdmission(
          next,
          active,
          now,
          () => load,
          () => "normal",
          () => 0,
        ).held,
    );

  expect(claim(first)).toBe(false);
  expect(claim(second)).toBe(false);
  expect(host.waiting.map((job) => job.reservationId)).toEqual(["first", "second"]);
  now = HEAVY_LOAD_POLICY.maxWaitMs;
  expect(claim(second)).toBe(false);
  expect(claim(first)).toBe(true);
  expect(claim(second)).toBe(false);
  expect(host.active.map((job) => job.reservationId)).toEqual(["first"]);
  releaseConcurrentCapacity(host, "first");
  expect(claim(second)).toBe(true);
  const third = { ...ticket("third", "session"), class: "checks" as const, queuedAt: now };
  expect(claim(third)).toBe(false);
  load = HEAVY_LOAD_POLICY.threshold;
  expect(claim(third)).toBe(true);
});

test("load admission includes express, legacy activity, and benchmarks", () => {
  const host = emptyConcurrentCapacity();
  const express = {
    ...ticket("express", "session"),
    class: "checks" as const,
    reservationMode: "express" as const,
  };
  const now = HEAVY_LOAD_POLICY.maxWaitMs;
  const admit = (job: HostJob, active: HostJob[]) =>
    !heavyLoadAdmission(
      job,
      active,
      now,
      () => HEAVY_LOAD_POLICY.threshold + 100,
      () => "normal",
      () => 0,
    ).held;
  const legacy = { ...ticket("legacy"), class: "build" as const };

  expect(claimConcurrentCapacity(host, express, now, false, [legacy], [], admit)).toBe(false);
  expect(claimConcurrentCapacity(host, express, now, false, [], [], admit)).toBe(true);
  const benchmark = ticket("benchmark", "other");
  expect(claimConcurrentCapacity(host, benchmark, now, false, [], [], admit)).toBe(false);
  releaseConcurrentCapacity(host, "express");
  expect(claimConcurrentCapacity(host, benchmark, now, false, [], [], admit)).toBe(true);
});

test("queued jobs report load holds and start in order when the injected load falls", async () => {
  const f = fixture(true, HEAVY_LOAD_POLICY.threshold + 1);
  try {
    const first = f.start("first");
    await f.queuedOwner("first");
    const second = f.start("second");
    await f.queuedOwner("second");
    const status = await concurrentStatus(
      f.directory,
      f.legacyLockPath,
      () => HEAVY_LOAD_POLICY.threshold + 1,
      () => "normal",
      () => 0,
    );
    expect(status.active).toEqual([]);
    expect(status.waiting.map((job) => "loadAdmission" in job && job.loadAdmission.held)).toEqual([
      true,
      true,
    ]);
    const sequences = f.state().host.waiting.map((job: HostJob) => job.sequence);
    writeFileSync(join(f.root, "load"), "0");
    await Promise.all([f.started("first"), f.started("second")]);
    expect(f.state().host.active.map((job: HostJob) => job.owner)).toEqual(["first", "second"]);
    expect(f.state().host.active.map((job: HostJob) => job.sequence)).toEqual(sequences);
    f.release("first");
    f.release("second");
    expect((await first.result).status).toBe("succeeded");
    expect((await second.result).status).toBe("succeeded");
  } finally {
    await f.clean();
  }
});

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
    const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", cliPath, ...args], {
        env: testEnvironment(
          { XDG_STATE_HOME: root, ...env },
          {
            ...process.env,
            HEAVY_RUN_RESERVATION_ID: "unrelated outer reservation",
            HEAVY_RUN_DEFERRED: "1",
            HEAVY_RUN_OWNER: "unrelated owner",
            HEAVY_RUN_WAIT_SECONDS: "invalid inherited wait",
            HEAVY_RUN_FUTURE_SETTING: "must not leak",
          },
        ),
        cwd: root,
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
      schemaVersion: 2,
      active: [],
      waiting: [],
    });
    const packagePath = join(root, "package.json");
    const argv = [
      process.execPath,
      "-e",
      "process.exit(process.env.HEAVY_RUN_DEFERRED === '1' && !process.env.HEAVY_RUN_RESERVATION_ID && !process.env.HEAVY_RUN_FUTURE_SETTING ? 0 : 42)",
    ];
    writeFileSync(
      packagePath,
      JSON.stringify({ heavyRun: { deferredCommands: [argv.slice(0, 2)] } }),
    );
    const deferred = await run(["--json", "--", ...argv]);
    expect(deferred.code).toBe(0);
    expect(JSON.parse(deferred.output)).toMatchObject({
      reservationMode: "deferred",
      acquiredAt: null,
    });

    // A declared self-queuing runner can itself be launched by a deferred runner.
    // Its leaf steps still reserve normally, since their argv are not declared.
    const inherited = await run(["--json", "--", ...argv], { HEAVY_RUN_DEFERRED: "1" });
    expect(inherited.code).toBe(0);
    expect(JSON.parse(inherited.output)).toMatchObject({
      reservationMode: "deferred",
      acquiredAt: null,
    });

    const nested = await run(["--json", "--", ...argv], { HEAVY_RUN_RESERVATION_ID: "held" });
    expect(nested.code).toBe(2);
    const nestedReceipt = JSON.parse(nested.output);
    expect(nestedReceipt.error).toContain("Nested heavy-run");
    rmSync(join(nestedReceipt.log, ".."), { recursive: true });

    writeFileSync(packagePath, JSON.stringify({ heavyRun: { deferredCommands: [["true"], []] } }));
    const badConfig = await run(["--class", "checks", "--", "true"]);
    expect(badConfig.code).toBe(2);
    expect(badConfig.errors.trim().split("\n")).toHaveLength(1);
    expect(badConfig.errors).toContain("Invalid heavy-run configuration");
    rmSync(join(badConfig.errors.trim().split("; log: ")[1], ".."), { recursive: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity checks/build jobs run concurrently, the next waits, and status lists every active", async () => {
  const f = fixture(true);
  try {
    const checks = Array.from({ length: HEAVY_CAPACITY - 1 }, (_, index) => `check${index + 1}`);
    const runs = [f.start(checks[0]), f.start("build", true, 30, 0, false, undefined, "build")];
    await Promise.all([checks[0], "build"].map(f.started));
    const clearSlots = await f.occupySlots("build", checks.slice(1));
    const status = await concurrentStatus(f.directory, f.legacyLockPath);
    expect(status.resourceBudget.capacity).toBe(HEAVY_CAPACITY);
    expect(status.active.map((job) => job.owner).sort()).toEqual([...checks, "build"].sort());

    const overflow = f.start("overflow");
    await f.queued(1);
    expect(f.state().host.active).toHaveLength(HEAVY_CAPACITY);
    expect(existsSync(join(f.root, "overflow-started"))).toBe(false);
    f.release("check1");
    await f.started("overflow");
    const fourth = overflow;
    await clearSlots();
    for (const owner of ["build", "overflow"]) f.release(owner);
    expect(
      (await Promise.all([...runs.map((run) => run.result), fourth.result])).every(
        (receipt) => receipt.exitCode === 0,
      ),
    ).toBe(true);
    expect(f.state().host.active).toEqual([]);
    expect(existsSync(f.legacyLockPath)).toBe(false);
  } finally {
    await f.clean();
  }
});

test("benchmarks and checks run concurrently without draining or blocking later work", async () => {
  const f = fixture(true);
  try {
    const check = f.start("check");
    await f.started("check");
    const benchmark = f.start("benchmark", true, 30, 0, false, undefined, "benchmark");
    await f.started("benchmark");
    const later = f.start("later");
    await f.started("later");
    expect(
      f
        .state()
        .host.active.map((job: HostJob) => job.owner)
        .sort(),
    ).toEqual(["benchmark", "check", "later"]);
    for (const owner of ["check", "benchmark", "later"]) f.release(owner);
    expect(
      (await Promise.all([check.result, benchmark.result, later.result])).every(
        (r) => r.exitCode === 0,
      ),
    ).toBe(true);
  } finally {
    await f.clean();
  }
});
test("concurrent requesters rotate by admission and keep FIFO", () => {
  const host = emptyConcurrentCapacity();
  const otherHeads = Array.from({ length: HEAVY_CAPACITY - 2 }, (_, i) =>
    ticket(`other${i + 1}`, `requester${i + 1}`),
  );
  const jobs = [
    ticket("a1", "A"),
    ticket("a2", "A"),
    ticket("b1", "B"),
    ticket("b2", "B"),
    ...otherHeads,
  ];
  for (const job of jobs) {
    job.class = "checks";
    claimConcurrentCapacity(host, job, 0, true);
  }
  expect(claimConcurrentCapacity(host, jobs[0], 1, false)).toBe(true);
  expect(claimConcurrentCapacity(host, jobs[2], 1, false)).toBe(true);
  for (const job of otherHeads) expect(claimConcurrentCapacity(host, job, 1, false)).toBe(true);
  expect(claimConcurrentCapacity(host, jobs[1], 1, false)).toBe(false);
  releaseConcurrentCapacity(host, "b1");
  expect(claimConcurrentCapacity(host, jobs[3], 2, false)).toBe(false);
  expect(claimConcurrentCapacity(host, jobs[1], 2, false)).toBe(true);
  expect(host.active.map((job) => job.reservationId)).toEqual([
    "a1",
    ...otherHeads.map((job) => job.reservationId),
    "a2",
  ]);
  expect(jobs.map((job) => job.sequence)).toEqual(jobs.map((_, i) => i));
});

test("multiple stale leases are recovered independently without reaping surviving groups or new waiters", () => {
  const host = emptyConcurrentCapacity();
  const jobs = [ticket("dead", "A"), ticket("live", "B"), ticket("descendant", "C")];
  jobs.forEach((job, i) => {
    job.class = "checks";
    job.holder = { pid: 100 + i, startedAt: "start", command: "worker" };
    job.processGroup = job.holder;
    expect(claimConcurrentCapacity(host, job, 0, false)).toBe(true);
  });
  const newWaiter = ticket("new", "D");
  claimConcurrentCapacity(host, newWaiter, 0, true);
  reapConcurrentCapacity(
    host,
    [
      { ...jobs[1].holder, pgid: 101, state: "S" },
      { pid: 103, pgid: 102, state: "S", startedAt: "later", command: "compiler" },
    ],
    [],
  );
  expect(host.active.map((job) => job.reservationId)).toEqual(["live", "descendant"]);
  expect(host.waiting).toEqual([newWaiter]);
  reapConcurrentCapacity(host, [], [newWaiter]);
  expect(host.active).toEqual([]);
  expect(host.waiting).toEqual([]);
});

test("legacy read-modify-write/reap/release cannot remove concurrent leases or their aggregate guard", async () => {
  const f = fixture(true);
  try {
    const one = f.start("one");
    const two = f.start("two");
    await Promise.all([f.started("one"), f.started("two")]);
    const before = readFileSync(join(f.directory, "heavy-concurrent.json"), "utf8");
    // These unchanged functions are the actual serial protocol loaded by old callers.
    await withQueueState((state) => {
      recoverLegacyLock(f.legacyLockPath, [], state.host.active);
      reapHostCapacity(state, []);
      releaseHostCapacity(state, "old-reservation");
      state.unleasedSince.device = 789;
      expect(claimHostCapacity(state, ticket("old", "old"), 0, existsSync(f.legacyLockPath))).toBe(
        false,
      );
      releaseHostCapacity(state, "old");
      releaseLegacyLock(f.legacyLockPath, join(f.root, "old-random-target"));
    }, f.directory);
    expect(readFileSync(join(f.directory, "heavy-concurrent.json"), "utf8")).toBe(before);
    expect(existsSync(f.legacyLockPath)).toBe(true);
    const old = f.start("legacy", true, 30, 0, false, undefined, "checks", modulePath);
    await f.queued(1);
    f.release("one");
    await one.result;
    expect(existsSync(join(f.root, "legacy-started"))).toBe(false);
    expect(existsSync(f.legacyLockPath)).toBe(true);
    f.release("two");
    await two.result;
    await f.started("legacy");
    const newer = f.start("newer");
    await f.started("newer");
    expect((await concurrentStatus(f.directory, f.legacyLockPath)).active).toHaveLength(2);
    f.release("legacy");
    await old.result;
    await f.started("newer");
    f.release("newer");
    expect((await newer.result).exitCode).toBe(0);
    expect(f.state().unleasedSince.device).toBe(789);
  } finally {
    await f.clean();
  }
});

test("a crashed concurrent holder cannot free another job's guard, and stale aggregate locks recover", async () => {
  const f = fixture(true);
  try {
    const one = f.start("crashed");
    const two = f.start("survivor");
    await Promise.all([f.started("crashed"), f.started("survivor")]);
    const closed = new Promise<void>((resolve) => one.processHandle.once("close", () => resolve()));
    one.processHandle.kill("SIGKILL");
    await closed;
    expect((await concurrentStatus(f.directory, f.legacyLockPath)).active).toHaveLength(2);
    f.release("crashed");
    // The survivor still protects the aggregate guard after legacy stale recovery.
    await withQueueState(
      (state) => recoverLegacyLock(f.legacyLockPath, [], state.host.active),
      f.directory,
    );
    expect(existsSync(f.legacyLockPath)).toBe(true);
    f.release("survivor");
    await two.result;
    // Snapshot after the supervisor finishes; a status/new caller performs recovery.
    const next = f.start("next", false);
    expect((await next.result).exitCode).toBe(0);
    expect((await concurrentStatus(f.directory, f.legacyLockPath)).active).toEqual([]);
    expect(existsSync(f.legacyLockPath)).toBe(false);
  } finally {
    await f.clean();
  }
});

test("deferred heavy steps share capacity while their cheap outer runner consumes none", async () => {
  const f = fixture(true);
  try {
    const owners = Array.from({ length: HEAVY_CAPACITY - 1 }, (_, i) => `slot${i + 1}`);
    const runs = [f.start(owners[0])];
    await f.started(owners[0]);
    const clearSlots = await f.occupySlots(owners[0], owners.slice(1));
    const concurrentModule = fileURLToPath(new URL("./heavy-run-concurrent.ts", import.meta.url));
    const source = `import {runHeavyCommand} from ${JSON.stringify(concurrentModule)};
      if(process.env.HEAVY_RUN_DEFERRED!=="1" || !process.env.HEAVY_RUN_CLI || process.env.HEAVY_RUN_RESERVATION_ID) throw new Error("Deferred contract lost");
      const result=await runHeavyCommand({...${JSON.stringify({ argv: [process.execPath, "--no-env-file", "-e", f.command("step")], owner: "step", class: "checks", waitSeconds: 30, directory: f.directory, legacyLockPath: f.legacyLockPath })}, readPressure: () => "normal", readLoad: () => 0});
      process.exitCode=result.exitCode;`;
    const outer = f.start("outer", true, 30, 0, true, source);
    await f.started("step");
    expect(
      f
        .state()
        .host.active.map((job: HostJob) => job.owner)
        .sort(),
    ).toEqual([...owners, "step"].sort());
    const fourth = f.start("fourth");
    await f.queued(1);
    f.release("step");
    expect((await outer.result).reservationMode).toBe("deferred");
    await f.started("fourth");
    await clearSlots();
    for (const name of [owners[0], "fourth"]) f.release(name);
    expect(
      (await Promise.all([...runs.map((run) => run.result), fourth.result])).every(
        (receipt) => receipt.exitCode === 0,
      ),
    ).toBe(true);
  } finally {
    await f.clean();
  }
});

test("a concurrent process snapshot retries when any active identity changes and protects newly queued tickets", async () => {
  const f = fixture(true);
  const deferred = Promise.withResolvers<ProcessRow[]>();
  const newer = ticket("new-worker", "session");
  newer.class = "checks";
  const row = { ...newer.holder, pgid: newer.holder.pid, state: "S" };
  let snapshots = 0;
  try {
    const pending = withConcurrentProcessState(
      (state) => state.host.active.map((job) => job.reservationId),
      f.directory,
      f.legacyLockPath,
      () => (++snapshots === 1 ? deferred.promise : Promise.resolve([row])),
    );
    await withConcurrentProcessState(
      (state) => {
        expect(claimConcurrentCapacity(state.host, newer, 0, false)).toBe(true);
      },
      f.directory,
      f.legacyLockPath,
      () => Promise.resolve([row]),
    );
    deferred.resolve([]);
    expect(await pending).toEqual(["new-worker"]);
    expect(snapshots).toBe(2);
    await withConcurrentProcessState(
      (state) => releaseConcurrentCapacity(state.host, newer.reservationId),
      f.directory,
      f.legacyLockPath,
      () => Promise.resolve([]),
    );
  } finally {
    deferred.resolve([]);
    await f.clean();
  }
});

test("a guard published before a crashed acquire commits is recovered by a new status", async () => {
  const f = fixture(true);
  try {
    const target = join(f.directory, "heavy-concurrent-lock");
    mkdirSync(target);
    writeFileSync(
      join(target, ".heavy-run-owner.json"),
      JSON.stringify({ protocol: "heavy-concurrent-v1" }),
    );
    symlinkSync(target, f.legacyLockPath, "dir");
    // An old caller deliberately leaves this unknown owner alone.
    recoverLegacyLock(f.legacyLockPath, [], null);
    expect(existsSync(f.legacyLockPath)).toBe(true);
    expect((await concurrentStatus(f.directory, f.legacyLockPath)).active).toEqual([]);
    expect(existsSync(f.legacyLockPath)).toBe(false);
    expect(existsSync(target)).toBe(false);
  } finally {
    await f.clean();
  }
});

test("a legacy benchmark shares remaining capacity with concurrent checks", async () => {
  const f = fixture(true);
  try {
    const legacy = f.start("legacy", true, 30, 0, false, undefined, "benchmark", modulePath);
    await f.started("legacy");
    const check = f.start("check");
    await f.started("check");
    expect((await concurrentStatus(f.directory, f.legacyLockPath)).active).toHaveLength(2);
    for (const owner of ["legacy", "check"]) f.release(owner);
    expect((await Promise.all([legacy.result, check.result])).every((r) => r.exitCode === 0)).toBe(
      true,
    );
  } finally {
    await f.clean();
  }
});
test("the last new release restores a still-running legacy holder's original lock", async () => {
  const f = fixture(true);
  try {
    const legacy = f.start("legacy", true, 30, 0, false, undefined, "build", modulePath);
    await f.started("legacy");
    const originalTarget = readlinkSync(f.legacyLockPath);
    const newer = f.start("newer");
    await f.started("newer");
    const nextLegacy = f.start("next-legacy", true, 30, 0, false, undefined, "checks", modulePath);
    await f.queued(1);
    // Concurrent-v1 release always addresses its own target; it cannot erase v2.
    releaseLegacyLock(f.legacyLockPath, join(f.directory, "heavy-concurrent-lock"));
    expect(readlinkSync(f.legacyLockPath)).not.toBe(originalTarget);
    f.release("newer");
    expect((await newer.result).exitCode).toBe(0);
    expect(readlinkSync(f.legacyLockPath)).toBe(originalTarget);
    f.release("legacy");
    await legacy.result;
    // No new status or new acquisition is needed to unblock serial callers.
    await f.started("next-legacy");
    f.release("next-legacy");
    expect((await nextLegacy.result).exitCode).toBe(0);
  } finally {
    await f.clean();
  }
});

test("unknown mkdir ownership is never adopted by a concurrent client", async () => {
  const f = fixture(true);
  try {
    mkdirSync(f.legacyLockPath);
    expect((await f.start("blocked", false, 0).result).exitCode).toBe(75);
    expect(existsSync(f.legacyLockPath)).toBe(true);
    expect(f.state().host.active).toEqual([]);
  } finally {
    await f.clean();
  }
});

test("loaded concurrent-v1 waiters keep their tickets without blocking shared-capacity clients", () => {
  const host = emptyConcurrentCapacity();
  const v1 = ticket("v1", "old-requester");
  v1.class = "checks";
  claimConcurrentCapacity(host, v1, 0, true);
  const v2 = Object.assign(ticket("v2", "new-requester"), {
    clientVersion: CURRENT_HEAVY_CLIENT,
  });
  v2.class = "checks";
  const legacy = ticket("legacy", "legacy");
  legacy.class = "checks";
  expect(claimConcurrentCapacity(host, v2, 1, false, [legacy])).toBe(true);
  expect(host.waiting).toEqual([v1]);
  expect(v1.sequence).toBe(0);
  expect(host.active).toEqual([v2]);
});

test("a crash after borrowing a serial guard but before committing a new lease restores its owner", async () => {
  const f = fixture(true);
  try {
    const legacy = f.start("legacy", true, 30, 0, false, undefined, "checks", modulePath);
    await f.started("legacy");
    const originalTarget = readlinkSync(f.legacyLockPath);
    await withQueueState((state) => {
      const target = join(f.directory, "heavy-concurrent-lock-v2");
      mkdirSync(target);
      writeFileSync(
        join(target, ".heavy-run-owner.json"),
        JSON.stringify({
          protocol: "heavy-concurrent-v3",
          legacyTarget: originalTarget,
          legacyReservation: state.host.active!.reservationId,
        }),
      );
      symlinkSync(target, f.legacyLockPath + "-replacement", "dir");
      renameSync(f.legacyLockPath + "-replacement", f.legacyLockPath);
      recoverLegacyLock(f.legacyLockPath, [], state.host.active);
      expect(readlinkSync(f.legacyLockPath)).toBe(target);
    }, f.directory);
    expect(
      (await concurrentStatus(f.directory, f.legacyLockPath)).active.map((job) => job.owner),
    ).toEqual(["legacy"]);
    expect(readlinkSync(f.legacyLockPath)).toBe(originalTarget);
    f.release("legacy");
    expect((await legacy.result).exitCode).toBe(0);
  } finally {
    await f.clean();
  }
});

test("shared capacity never overtakes a requester's blocked concurrent-v1 head ticket", () => {
  const host = emptyConcurrentCapacity();
  const v1 = ticket("v1", "same");
  v1.class = "checks";
  claimConcurrentCapacity(host, v1, 0, true);
  const later = Object.assign(ticket("later", "same"), { clientVersion: CURRENT_HEAVY_CLIENT });
  later.class = "checks";
  const legacy = ticket("legacy", "legacy");
  legacy.class = "checks";
  expect(claimConcurrentCapacity(host, later, 1, false, [legacy])).toBe(false);
  const other = Object.assign(ticket("other", "other"), {
    clientVersion: CURRENT_HEAVY_CLIENT,
  });
  other.class = "checks";
  expect(claimConcurrentCapacity(host, other, 2, false, [legacy])).toBe(true);
  expect(host.waiting.map((job) => job.reservationId)).toEqual(["v1", "later"]);
  releaseConcurrentCapacity(host, "other");
  expect(claimConcurrentCapacity(host, later, 3, false)).toBe(false);
  expect(claimConcurrentCapacity(host, v1, 3, false)).toBe(true);
  expect(claimConcurrentCapacity(host, later, 4, false)).toBe(true);
});

// v1/v2 retain their frozen selector and guard; v3 retains its frozen turn
// selector with the unchanged admission wrapper. None can use the fixed selector.
function frozenConcurrentClient(root: string, version: 1 | 2 | 3 = 2): string {
  const lib = fileURLToPath(new URL("./", import.meta.url));
  const capacityPath = join(root, "old-capacity.ts");
  const turnsPath = join(root, "old-turns.ts");
  const resolve = (source: string) =>
    source.replace(
      /from "\.\/([^"]+)"/g,
      (_match, name) =>
        `from ${JSON.stringify(name === "concurrent-capacity" ? capacityPath : name === "concurrent-turns" ? turnsPath : join(lib, name))}`,
    );
  writeFileSync(
    capacityPath,
    resolve(
      readFileSync(
        join(
          lib,
          version === 3 ? "concurrent-capacity.ts" : "fixtures/concurrent-capacity-v2.ts.txt",
        ),
        "utf8",
      ),
    ).replace(/HEAVY_CAPACITY = \d+/, "HEAVY_CAPACITY = 3"),
  );
  if (version === 3)
    writeFileSync(
      turnsPath,
      resolve(readFileSync(join(lib, "fixtures/concurrent-turns-v3.ts.txt"), "utf8")),
    );
  let source = readFileSync(
    join(
      lib,
      version === 3 ? "heavy-run-concurrent.ts" : "fixtures/heavy-run-concurrent-v2.ts.txt",
    ),
    "utf8",
  );
  if (version === 1) {
    // On the concurrent-only lane, v1 has the same selector, no client marker,
    // and recognizes only the v1 target. Serial-lane behavior is tested above.
    source = source
      .replaceAll('"heavy-concurrent-lock-v2"', '"heavy-concurrent-lock"')
      .replaceAll('"heavy-concurrent-v2"', '"heavy-concurrent-v1"')
      .replace(/\s*Object.assign\(job, \{ clientVersion: "concurrent-v2" \}\);/, "");
  }
  const path = join(root, `old-client-${version}.ts`);
  writeFileSync(path, resolve(source));
  return path;
}

function currentTicket(
  id: string,
  requester = id,
): HostJob & { clientVersion: typeof CURRENT_HEAVY_CLIENT } {
  return Object.assign(ticket(id, requester), {
    class: "checks" as const,
    clientVersion: CURRENT_HEAVY_CLIENT,
  });
}

test("an older checks head keeps a free slot while other requester heads backfill", () => {
  const host = emptyConcurrentCapacity();
  const active = currentTicket("active");
  expect(claimConcurrentCapacity(host, active, 0, false)).toBe(true);
  for (const id of Array.from({ length: HEAVY_CAPACITY - 3 }, (_, i) => `extra${i + 1}`))
    expect(claimConcurrentCapacity(host, currentTicket(id), 0, false)).toBe(true);
  const old = ticket("old", "old");
  old.class = "checks";
  const a = currentTicket("a"),
    b = currentTicket("b");
  for (const job of [old, a, b]) claimConcurrentCapacity(host, job, 1, true);
  prepareConcurrentTurns(host);
  expect(host.requesters[0]).toBe("a");
  expect(claimConcurrentCapacity(host, a, 2, false)).toBe(true);
  expect(claimConcurrentCapacity(host, b, 2, false)).toBe(false);
  expect(host.active).toHaveLength(HEAVY_CAPACITY - 1);
  expect(claimConcurrentCapacity(host, old, 2, false)).toBe(true);
  expect(host.active).toHaveLength(HEAVY_CAPACITY);
  expect(host.waiting.map((job) => job.reservationId)).toEqual(["b"]);
});

test("v2 actives do not make a v1 checks head exclusive or block compatible waiters", async () => {
  const f = fixture(true);
  let dispatcher: ChildProcess | undefined;
  try {
    const old = frozenConcurrentClient(f.root),
      v1 = frozenConcurrentClient(f.root, 1);
    const anchor = f.start("anchor", true, 30, 0, false, undefined, "checks", old);
    await f.started("anchor");
    const head = f.start("v1-head", true, 30, 0, false, undefined, "checks", v1);
    await f.queued(1);
    const fill = f.start("fill", true, 30, 0, false, undefined, "checks", old);
    await f.queued(2);
    dispatcher = startCompatibilityDispatcher(f.directory, f.legacyLockPath);
    await Promise.all([f.started("v1-head"), f.started("fill")]);
    expect(f.state().host.active).toHaveLength(3);
    const fourth = f.start("fourth", true, 30, 0, false, undefined, "checks", old);
    await f.queued(3);
    expect(existsSync(join(f.root, "fourth-started"))).toBe(false);
    f.release("fill");
    await fill.result;
    await f.started("fourth");
    for (const name of ["anchor", "v1-head", "fourth"]) f.release(name);
    expect(
      (await Promise.all([anchor.result, head.result, fourth.result])).every(
        (r) => r.exitCode === 0,
      ),
    ).toBe(true);
    if (dispatcher.exitCode === null)
      await new Promise<void>((resolve) => dispatcher!.once("close", () => resolve()));
  } finally {
    if (dispatcher && dispatcher.exitCode === null) {
      const closed = new Promise<void>((resolve) => dispatcher!.once("close", () => resolve()));
      dispatcher.kill();
      await closed;
    }
    await f.clean();
  }
});

test("express history uses the last ten exact argv runs in the canonical project", () => {
  const run = (
    ranSeconds: number,
    overrides: Partial<HeavyHistoryEntry> = {},
  ): HeavyHistoryEntry => ({
    finishedAt: "2026-10-16T08:00:00Z",
    owner: "test",
    class: "checks",
    cwd: "/tree",
    project: "/repo/.git",
    command: "mise run tsc",
    argv: ["mise", "run", "tsc"],
    queuedAt: "2026-10-16T07:59:58Z",
    acquiredAt: "2026-10-16T07:59:58Z",
    waitedSeconds: 0,
    ranSeconds,
    status: "succeeded",
    childExitCode: 0,
    ...overrides,
  });
  const argv = ["mise", "run", "tsc"];
  const quick = Array.from({ length: 10 }, () => run(1));
  const qualifies = (history: HeavyHistoryEntry[], className: HeavyClass = "checks") =>
    expressHeavyCommand(history, argv, className, "/repo/.git");
  expect(qualifies(quick)).toBe(true);
  expect(qualifies(quick.slice(1))).toBe(false);
  expect(qualifies(quick, "build")).toBe(false);
  expect(qualifies(quick, "benchmark")).toBe(false);
  expect(qualifies(quick.map((entry) => ({ ...entry, project: "/other/.git" })))).toBe(false);
  expect(qualifies(quick.map((entry) => ({ ...entry, argv: ["mise run", "tsc"] })))).toBe(false);
  expect(qualifies(quick.map((entry) => ({ ...entry, reservationMode: "deferred" })))).toBe(false);
  expect(qualifies(quick.map((entry) => ({ ...entry, acquiredAt: null })))).toBe(false);
  expect(qualifies(Array.from({ length: 10 }, () => run(10)))).toBe(false);
  expect(qualifies([...quick.slice(2), run(30), run(30)])).toBe(false);
  const laterSlow = [
    run(60, { finishedAt: "2026-10-16T09:00:00Z", reservationMode: "express" }),
    run(60, { finishedAt: "2026-10-16T09:00:01Z", reservationMode: "express" }),
  ];
  expect(qualifies([...quick, ...laterSlow])).toBe(false);
  expect(
    qualifies([
      ...laterSlow,
      ...quick.map((entry) => ({
        ...entry,
        finishedAt: "2026-10-16T10:00:00Z",
        reservationMode: "express" as const,
      })),
    ]),
  ).toBe(true);
  expect(qualifies(quick.map((entry) => ({ ...entry, argv: undefined })))).toBe(true);
  expect(
    qualifies(quick.map((entry) => ({ ...entry, argv: undefined, command: "x".repeat(300) }))),
  ).toBe(false);
});

test("project identity follows shared Git storage across worktrees and subdirectories", () => {
  const root = mkdtempSync(join(tmpdir(), "heavy-project-test-"));
  try {
    const main = join(root, "main");
    const tree = join(root, "tree");
    mkdirSync(join(main, ".git", "worktrees", "tree"), { recursive: true });
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${main}/.git/worktrees/tree\n`);
    writeFileSync(join(main, ".git", "worktrees", "tree", "commondir"), "../..\n");
    expect(heavyProject(join(tree, "src"))).toBe(heavyProject(main));
    expect(heavyProject(join(root, "absent"))).toBe(null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("express runs bypass occupied capacity and share the host with benchmarks", async () => {
  const f = fixture(true);
  try {
    const source = f.command("express");
    writeFileSync(
      heavyHistoryPath(f.directory),
      Array.from({ length: 10 }, () =>
        JSON.stringify({
          finishedAt: "2026-10-16T08:00:00Z",
          owner: "history",
          class: "checks",
          cwd: process.cwd(),
          project: heavyProject(process.cwd()),
          argv: [process.execPath, "-e", source],
          command: "display only",
          queuedAt: "2026-10-16T07:59:58Z",
          acquiredAt: "2026-10-16T07:59:58Z",
          waitedSeconds: 0,
          ranSeconds: 1,
          status: "succeeded",
          childExitCode: 0,
        }),
      ).join("\n") + "\n",
    );
    const owners = Array.from({ length: HEAVY_CAPACITY }, (_, i) => `slot${i + 1}`);
    const occupied = [f.start(owners[0])];
    await f.started(owners[0]);
    const clearSlots = await f.occupySlots(owners[0], owners.slice(1));
    const express = f.start("express", true, 30, 0, false, source);
    await f.started("express");
    const status = await concurrentStatus(f.directory, f.legacyLockPath);
    expect(status.active).toHaveLength(HEAVY_CAPACITY + 1);
    expect(status.express.active).toBe(1);
    expect(status.active.find((job) => job.owner === "express")?.reservationMode).toBe("express");
    const benchmark = f.start("benchmark", true, 30, 0, false, undefined, "benchmark");
    await f.queuedOwner("benchmark");
    await clearSlots();
    f.release(owners[0]);
    await Promise.all(occupied.map((run) => run.result));
    await f.started("benchmark");
    expect(
      f
        .state()
        .host.active.map((job: HostJob) => job.owner)
        .sort(),
    ).toEqual(["benchmark", "express"]);
    f.release("express");
    expect((await express.result).reservationMode).toBe("express");
    await f.started("benchmark");
    const blocked = f.start("express", true, 30, 0, false, source);
    await f.started("express");
    expect(
      f
        .state()
        .host.active.map((job: HostJob) => job.owner)
        .sort(),
    ).toEqual(["benchmark", "express"]);
    f.release("benchmark");
    await benchmark.result;
    await f.started("express");
    f.release("express");
    expect((await blocked.result).reservationMode).toBe("express");
    const history = readHeavyHistory(heavyHistoryPath(f.directory));
    expect(history.filter((run) => run.reservationMode === "express")).toHaveLength(2);
  } finally {
    await f.clean();
  }
});

test("express leases consume no slots and benchmarks do not block express admission", () => {
  const host = emptyConcurrentCapacity();
  const check = (
    id: string,
    express = false,
  ): HostJob & { clientVersion: typeof CURRENT_HEAVY_CLIENT } => ({
    ...ticket(id, id),
    class: "checks",
    clientVersion: CURRENT_HEAVY_CLIENT,
    ...(express ? { reservationMode: "express" } : {}),
  });
  for (const id of ["express1", "express2", "express3"]) {
    expect(claimConcurrentCapacity(host, check(id, true), 0, false)).toBe(true);
  }
  for (const id of Array.from({ length: HEAVY_CAPACITY }, (_, i) => `slot${i + 1}`)) {
    expect(claimConcurrentCapacity(host, check(id), 1, false)).toBe(true);
  }
  expect(claimConcurrentCapacity(host, check("overflow"), 2, false)).toBe(false);
  const bench = { ...ticket("benchmark", "benchmark"), clientVersion: CURRENT_HEAVY_CLIENT };
  expect(claimConcurrentCapacity(host, bench, 2, false)).toBe(false);
  expect(claimConcurrentCapacity(host, check("later-express", true), 3, false)).toBe(true);
  for (const job of host.active) releaseConcurrentCapacity(host, job.reservationId);
  releaseConcurrentCapacity(host, "overflow");
  expect(claimConcurrentCapacity(host, bench, 4, false)).toBe(true);
  expect(claimConcurrentCapacity(host, check("later-express", true), 5, false)).toBe(true);
  releaseConcurrentCapacity(host, "benchmark");
  expect(claimConcurrentCapacity(host, check("later-express", true), 6, false)).toBe(true);
  expect(
    claimConcurrentCapacity(emptyConcurrentCapacity(), check("legacy-blocked", true), 0, true, [
      ticket("legacy-benchmark"),
    ]),
  ).toBe(false);
});

test("runtime cap kills the process group with a distinct actionable receipt", async () => {
  const f = fixture();
  try {
    const run = f.start(
      "capped",
      true,
      30,
      0,
      false,
      f.command("capped"),
      "checks",
      modulePath,
      true,
    );
    await f.started("capped");
    run.processHandle.stdin!.end("expire");
    const receipt = await run.result;
    expect(receipt).toMatchObject({
      status: "timed-out",
      exitCode: 124,
      runtimeLimitSeconds: 90,
      childSignal: "SIGKILL",
    });
    expect(receipt.error).toContain(receipt.argv.join(" "));
    expect(receipt.error).toContain("ran over 90s");
    expect(receipt.error).toContain("elapsed) — make it faster");
    const { processSnapshot } = await import("./process-identity");
    expect(
      (await processSnapshot()).filter(
        (row) => row.pgid === receipt.processGroup!.pid && !row.state.startsWith("Z"),
      ),
    ).toEqual([]);
  } finally {
    await f.clean();
  }
});

test("an explicit cap also kills an otherwise uncapped full check", async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, "package.json"),
    JSON.stringify({ heavyRun: { uncappedCommands: [[process.execPath, "-e"]] } }),
  );
  try {
    const run = f.start(
      "full-check",
      true,
      30,
      0,
      false,
      f.command("full-check"),
      "checks",
      modulePath,
      true,
      f.root,
      2,
    );
    await f.started("full-check");
    run.processHandle.stdin!.end("expire");
    expect(await run.result).toMatchObject({
      status: "timed-out",
      exitCode: 124,
      runtimeLimitSeconds: 2,
      childSignal: "SIGKILL",
    });
  } finally {
    await f.clean();
  }
});

test("ad-hoc checks cannot extend the default runtime cap", async () => {
  const inheritedUncapped = process.env.HEAVY_RUN_UNCAPPED;
  delete process.env.HEAVY_RUN_UNCAPPED;
  try {
    await expect(
      runHeavyCommand({
        argv: ["true"],
        class: "checks",
        owner: "cap test",
        waitSeconds: 0,
        runtimeLimitSeconds: 91,
      }),
    ).rejects.toThrow("cannot exceed 90 seconds");
  } finally {
    if (inheritedUncapped === undefined) delete process.env.HEAVY_RUN_UNCAPPED;
    else process.env.HEAVY_RUN_UNCAPPED = inheritedUncapped;
  }
});

test("build jobs have no runtime deadline", async () => {
  const f = fixture(true);
  try {
    expect(
      await f.start("build-exempt", false, 30, 0, false, f.command("build-exempt", false), "build")
        .result,
    ).toMatchObject({ exitCode: 0, runtimeLimitSeconds: null });
  } finally {
    await f.clean();
  }
});

for (const key of ["deferredCommands", "uncappedCommands"] as const) {
  test(`${key} runners propagate uncapped execution to nested reserved steps`, async () => {
    const f = fixture(true);
    const currentModule = fileURLToPath(new URL("./heavy-run-concurrent.ts", import.meta.url));
    const packagePath = join(f.root, "package.json");
    try {
      writeFileSync(
        packagePath,
        JSON.stringify({ heavyRun: { [key]: [["mise", "run", "signoff"]] } }),
      );
      expect(uncappedHeavyCommand(["mise", "run", "signoff", "--fresh"], f.root)).toBe(true);
      expect(uncappedHeavyCommand(["mise", "run", "check"], f.root)).toBe(false);
      writeFileSync(packagePath, JSON.stringify({ heavyRun: { [key]: [[]] } }));
      expect(() => uncappedHeavyCommand(["true"], f.root)).toThrow(`heavyRun.${key}`);
      const source = `
      const {runHeavyCommand} = await import(${JSON.stringify(currentModule)});
      const result = await runHeavyCommand({...${JSON.stringify({ class: "benchmark", waitSeconds: 5, owner: "step", directory: f.directory, legacyLockPath: f.legacyLockPath })}, argv:[process.execPath,"-e","if(process.env.HEAVY_RUN_UNCAPPED !== '1') process.exit(9)"], readPressure:()=>"normal", readLoad:()=>0, scheduleRuntimeDeadline:()=>{throw new Error("Nested step must not have a deadline")}});
      if(result.runtimeLimitSeconds !== null || result.exitCode !== 0) throw new Error(JSON.stringify(result));
    `;
      writeFileSync(
        packagePath,
        JSON.stringify({ heavyRun: { [key]: [[process.execPath, "-e", source]] } }),
      );
      expect(
        await f.start(
          "declared",
          false,
          30,
          0,
          true,
          source,
          "checks",
          currentModule,
          false,
          f.root,
        ).result,
      ).toMatchObject({ exitCode: 0, runtimeLimitSeconds: null });
    } finally {
      await f.clean();
    }
  });
}
