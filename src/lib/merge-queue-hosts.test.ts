import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseSignoffHost, dispatchSignoff, type SignoffRequest } from "./merge-queue-hosts";
import { QueueTransientError } from "./merge-queue";
import { signoffDiagnostics } from "./merge-queue-signoff";

const samples = [
  { host: "main-mac", load: 1, maxLoad: 14 },
  { host: "big-mac", load: 5, maxLoad: 16 },
  { host: "small-mac", load: 2, maxLoad: 10 },
];
test("least loaded eligible spare wins, main is fallback, threshold is strict", () => {
  expect(chooseSignoffHost(samples)).toBe("small-mac");
  expect(chooseSignoffHost(samples, ["small-mac"])).toBe("big-mac");
  expect(chooseSignoffHost(samples, ["small-mac", "big-mac"])).toBe("main-mac");
  expect(chooseSignoffHost([{ host: "big-mac", load: 16, maxLoad: 16 }])).toBeUndefined();
  expect(chooseSignoffHost([{ ...samples[1]!, busy: true }])).toBeUndefined();
});
test("remote disconnect retries another Mac once; completed check failures retain checks and copied logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-host-test-"));
  const attempts: string[] = [];
  const request = {
    repo: "owner/repo",
    base: "base",
    sha: "candidate",
    bundle: "bundle",
    entries: [],
    full: true,
  } satisfies SignoffRequest;
  const options = {
    hosts: samples.map((s) => s.host),
    reserve: () => () => {},
    execute: async () => {
      throw new Error("unexpected command");
    },
    request: async () => request,
    log: join(directory, "candidate.log"),
    probe: async (host: string) => samples.find((s) => s.host === host)!,
  };
  try {
    const result = await dispatchSignoff({
      ...options,
      remote: async (host) => {
        attempts.push(host);
        if (host === "small-mac") throw new Error("connection lost");
        return {
          result: {
            ok: false,
            log: "/remote/candidate.log",
            runs: [
              {
                attempt: 1,
                startLoad: 5,
                endLoad: 6,
                log: "/remote/run.log",
                failures: [{ name: "api:test", reason: "check failure", log: "/remote/run.log" }],
                checks: [{ name: "api:test", status: "failed", seconds: 2, reused: false }],
                receipt: "/remote/receipt.json",
              },
            ],
          },
          logs: {
            "/remote/candidate.log": "candidate output",
            "/remote/run.log": "check failed",
            "/remote/receipt.json": JSON.stringify({
              version: 1,
              command: "signoff",
              checks: [{ task: "family-tree:pest", status: "failed", log: "/remote/pest.log" }],
            }),
            "/remote/pest.log":
              "Tests: 4174 passed\n::error title=PHP test timing regression::5.24s exceeds 5.00s",
          },
        };
      },
    });
    expect(attempts).toEqual(["small-mac", "big-mac"]);
    expect(result?.ok).toBe(false);
    expect(result?.runs?.[0]).toMatchObject({
      host: "big-mac",
      checks: [{ name: "api:test", status: "failed" }],
    });
    expect(await readFile(result!.runs![0]!.failures[0]!.log, "utf8")).toBe("check failed");
    const receipt = await readFile(result!.runs![0]!.receipt!, "utf8");
    const diagnostics = await signoffDiagnostics(receipt, result!.log);
    expect(diagnostics.failures).toMatchObject([{ name: "family-tree:pest", budgetOnly: true }]);
    expect(diagnostics.failures[0]!.log).toStartWith(directory);
    const local = await dispatchSignoff({
      ...options,
      remote: async () => {
        throw new Error("timeout");
      },
      hosts: ["small-mac", "main-mac"],
    });
    expect(local).toBeUndefined();
    await expect(
      dispatchSignoff({
        ...options,
        remote: async () => {
          throw new Error("timeout");
        },
        hosts: ["small-mac", "big-mac"],
      }),
    ).rejects.toBeInstanceOf(QueueTransientError);
    await expect(
      dispatchSignoff({
        ...options,
        probe: async () => {
          throw new Error("unreachable");
        },
      }),
    ).rejects.toBeInstanceOf(QueueTransientError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both broken spares fall back to main; concurrent dispatches reserve separate hosts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "queue-host-reserve-"));
  const reserved = new Set<string>();
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const selected: string[] = [];
  const options = {
    hosts: samples.map((s) => s.host),
    execute: async () => {
      throw new Error("unexpected command");
    },
    request: async () => ({
      repo: "owner/repo",
      base: "base",
      sha: "sha",
      bundle: "",
      entries: [],
      full: true,
    }),
    log: join(directory, "candidate.log"),
    probe: async (host: string) => samples.find((s) => s.host === host)!,
    reserve: (host: string) => {
      if (reserved.has(host)) return undefined;
      reserved.add(host);
      return () => {
        reserved.delete(host);
      };
    },
  };
  try {
    const first = dispatchSignoff({
      ...options,
      remote: async (host) => {
        selected.push(host);
        started();
        await running;
        return { result: { ok: true, log: "/remote/log" }, logs: { "/remote/log": "passed" } };
      },
    });
    await start;
    await dispatchSignoff({
      ...options,
      remote: async (host) => {
        selected.push(host);
        return { result: { ok: true, log: "/remote/log" }, logs: { "/remote/log": "passed" } };
      },
    });
    finish();
    await first;
    expect(selected).toEqual(["small-mac", "big-mac"]);
    expect(reserved.size).toBe(0);
    const failures: string[] = [];
    expect(
      await dispatchSignoff({
        ...options,
        remote: async (host) => {
          failures.push(host);
          return { error: "worker broken" };
        },
      }),
    ).toBeUndefined();
    expect(failures).toEqual(["small-mac", "big-mac"]);
  } finally {
    finish();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loaded or reserved hosts wait for capacity, bounded to one hour", async () => {
  let clock = 0;
  let busy = true;
  const options = {
    hosts: ["main-mac"],
    execute: async () => {
      throw new Error("unexpected command");
    },
    request: async () => {
      throw new Error("local must not bundle");
    },
    log: "/unused",
    now: () => clock,
    probe: async (host: string) => ({ host, load: busy ? 20 : 0, maxLoad: 10 }),
    reserve: () => () => {},
    pause: async (ms: number) => {
      clock += ms;
      busy = false;
    },
  };
  expect(await dispatchSignoff(options)).toBeUndefined();
  expect(clock).toBe(5000);
  busy = true;
  clock = 0;
  await expect(
    dispatchSignoff({
      ...options,
      pause: async (ms) => {
        clock += ms;
      },
    }),
  ).rejects.toBeInstanceOf(QueueTransientError);
  expect(clock).toBe(3_600_000);
});
