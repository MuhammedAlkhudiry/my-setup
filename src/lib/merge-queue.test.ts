import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processRepository,
  QueueEnvironmentError,
  QueueTransientError,
  readMergeQueue,
  updateMergeQueue,
  validatePr,
  type PullRequest,
  type QueueBackend,
  type QueueEntry,
} from "./merge-queue";

const directories: string[] = [];
test("a bisection leaf persists the failing stages and log paths from both attempts", async () => {
  const f = await fixture(1);
  const runs = [1, 2].map((attempt) => ({
    attempt,
    startLoad: 1,
    endLoad: 30,
    log: `/run-${attempt}.log`,
    failures: [
      {
        name: `stage-${attempt}`,
        log: `/stage-${attempt}.log`,
        reason: "timeout",
      },
    ],
  }));
  f.backend.candidate = async () => ({
    ok: false,
    log: "/candidate.log",
    runs,
  });
  await processRepository("owner/repo", f.backend, f.directory);
  const entry = f.state().entries[0]!;
  expect(entry.status).toBe("failed");
  expect(entry.runs).toEqual(runs);
  for (const attempt of [1, 2]) {
    expect(entry.error).toContain(`stage-${attempt}`);
    expect(entry.error).toContain(`/stage-${attempt}.log`);
    expect(entry.error).toContain(`/run-${attempt}.log`);
  }
});
test("an entry that lands after a load retry keeps both runs", async () => {
  const f = await fixture(1);
  const runs = [
    {
      attempt: 1,
      startLoad: 5,
      endLoad: 9,
      peakLoad: 30,
      log: "/run-1.log",
      failures: [{ name: "e2e", log: "/e2e.log", reason: "check failure" }],
      retried: "load peaked at 30.00, threshold 14; retried once load dropped",
    },
    { attempt: 2, startLoad: 4, endLoad: 6, peakLoad: 6, log: "/run-2.log", failures: [] },
  ];
  f.backend.candidate = async () => ({ ok: true, log: "/candidate.log", runs });
  await processRepository("owner/repo", f.backend, f.directory);
  const entry = f.state().entries[0]!;
  expect(entry.status).toBe("merged");
  expect(entry.runs).toEqual(runs);
});

test("transient preparation failures keep PRs queued with a short retry", async () => {
  const f = await fixture(1);
  f.backend.candidate = async () => {
    throw new QueueTransientError("prepare timed out twice");
  };
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow(
    "timed out",
  );
  const failure = f.state().environment!["owner/repo"];
  expect(failure.transient).toBe(true);
  expect(Date.parse(failure.retryAt) - Date.now()).toBeLessThanOrEqual(30_000);
  expect(f.state().entries[0]!.status).toBe("queued");
});
test("unknown GitHub mergeability retries without failing queued PRs", async () => {
  const f = await fixture(1);
  f.remote.get(1)!.mergeable = "UNKNOWN";
  await expect(
    processRepository("owner/repo", f.backend, f.directory, async () => {}),
  ).rejects.toThrow("recalculating");
  expect(f.state().entries[0]!.status).toBe("queued");
  expect(f.state().environment!["owner/repo"].transient).toBe(true);
  expect(f.candidates).toHaveLength(0);
});
test("environment failures preserve PRs and back off exponentially without bisection", async () => {
  const f = await fixture();
  let attempts = 0;
  f.backend.candidate = async () => {
    attempts++;
    throw new QueueEnvironmentError("environment broken: Composer is missing from PATH");
  };
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow(
    "environment broken",
  );
  const first = f.state().environment!["owner/repo"];
  expect(Date.parse(first.retryAt) - Date.now()).toBeGreaterThan(890_000);
  await processRepository("owner/repo", f.backend, f.directory);
  expect(attempts).toBe(1);
  expect(f.state().entries.every((entry) => entry.status === "queued" && !entry.error)).toBe(true);
  await updateMergeQueue((state) => {
    state.environment!["owner/repo"].retryAt = "2000-01-01";
  }, f.directory);
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow(
    "environment broken",
  );
  expect(f.state().environment!["owner/repo"].attempts).toBe(2);
  expect(Date.parse(f.state().environment!["owner/repo"].retryAt) - Date.now()).toBeGreaterThan(
    1_790_000,
  );
});
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture(count = 3) {
  const directory = mkdtempSync(join(tmpdir(), "merge-queue-test-"));
  directories.push(directory);
  const entries: QueueEntry[] = Array.from({ length: count }, (_, index) => ({
    repo: "owner/repo",
    pr: index + 1,
    head: `head${index + 1}`,
    status: "queued",
    enqueuedAt: "now",
    thread: "owning-thread",
  }));
  await updateMergeQueue((state) => {
    state.entries = entries;
    state.deploys = {
      "owner/repo": {
        sha: "main0",
        prs: [],
        status: "deployed",
        at: "now",
        deployedSha: "main0",
      },
    };
  }, directory);
  const remote = new Map(
    entries.map((entry) => [
      entry.pr,
      {
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        headRefOid: entry.head,
        baseRefName: "main",
        reviewDecision: "APPROVED",
        mergeCommit: null,
        mergedAt: null,
        files: [],
      } as PullRequest,
    ]),
  );
  let main = "main0";
  const merged: number[] = [];
  const candidates: number[][] = [];
  const deploys: string[] = [];
  const backend: QueueBackend = {
    deploy: async (sha) => {
      deploys.push(sha);
      return { ok: true, log: "deploy.log", deployedSha: sha };
    },
    inspect: async (entry) => ({ ...remote.get(entry.pr)! }),
    signed: async () => true,
    base: async () => main,
    candidate: async (batch) => {
      candidates.push(batch.map((entry) => entry.pr));
      return { ok: true, log: "signoff.log" };
    },
    merge: async (entry) => {
      const pr = remote.get(entry.pr)!;
      if (pr.headRefOid !== entry.head) throw new Error("head mismatch");
      merged.push(entry.pr);
      main = `merge${entry.pr}`;
      Object.assign(pr, {
        state: "MERGED",
        mergeCommit: { oid: main },
        mergedAt: "merged-time",
      });
    },
  };
  return {
    directory,
    entries,
    remote,
    backend,
    merged,
    candidates,
    deploys,
    state: () => readMergeQueue(directory),
  };
}
test("one candidate gates a batch, preserving order and durable thread/merge receipts", async () => {
  const f = await fixture();
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.candidates).toEqual([[1, 2, 3]]);
  expect(f.merged).toEqual([1, 2, 3]);
  expect(f.state().entries[2]).toMatchObject({
    status: "merged",
    mergedMainSha: "merge3",
    thread: "owning-thread",
    mergedAt: "merged-time",
  });
});
test("recalculating mergeability resolves within the same pass", async () => {
  const f = await fixture(1);
  let inspections = 0;
  const inspect = f.backend.inspect;
  f.backend.inspect = async (entry) => {
    const pr = await inspect(entry);
    return ++inspections === 1 ? { ...pr, mergeable: "UNKNOWN" } : pr;
  };
  await processRepository("owner/repo", f.backend, f.directory, async () => {});
  expect(f.candidates).toEqual([[1]]);
  expect(f.merged).toEqual([1]);
});
test("a green candidate merges every member while GitHub recalculates the next PR", async () => {
  const f = await fixture();
  const candidate = f.backend.candidate;
  f.backend.candidate = async (entries, base) => {
    const result = await candidate(entries, base);
    for (const pr of f.remote.values()) pr.mergeable = "UNKNOWN";
    return result;
  };
  const merge = f.backend.merge;
  f.backend.merge = async (entry) => {
    await merge(entry);
    for (const pr of f.remote.values()) if (pr.state === "OPEN") pr.mergeable = "UNKNOWN";
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.candidates).toEqual([[1, 2, 3]]);
  expect(f.merged).toEqual([1, 2, 3]);
});
test("changed head is requeued and excluded; next pass requires new head signoff", async () => {
  const f = await fixture();
  f.remote.get(2)!.headRefOid = "changed";
  f.backend.signed = async (entry) => entry.head !== "changed";
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.candidates).toEqual([[1, 3]]);
  expect(f.state().entries[1]).toMatchObject({
    status: "queued",
    head: "changed",
  });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 3]);
});
test("head changing during signoff invalidates batch before first merge", async () => {
  const f = await fixture();
  f.backend.candidate = async () => {
    f.remote.get(2)!.headRefOid = "changed";
    return { ok: true, log: "gate.log" };
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([]);
  expect(f.state().entries[1].head).toBe("changed");
});
test("bisection tests passing subsets together and isolates interacting failure", async () => {
  const f = await fixture(4);
  f.backend.candidate = async (batch) => {
    const ids = batch.map((entry) => entry.pr);
    f.candidates.push(ids);
    return { ok: !(ids.includes(2) && ids.includes(3)), log: "failed.log" };
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 2, 4]);
  expect(f.state().entries[2]).toMatchObject({
    status: "failed",
    log: "failed.log",
  });
  expect(f.candidates.at(-1)).toEqual([1, 2, 4]);
});
test("conflicting PR fails while remaining combined candidate is retested", async () => {
  const f = await fixture();
  f.backend.candidate = async (batch) => ({
    ok: !batch.some((entry) => entry.pr === 2),
    conflict: batch.some((entry) => entry.pr === 2) ? 2 : undefined,
    log: "conflict.log",
  });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 3]);
  expect(f.state().entries[1]).toMatchObject({
    status: "failed",
    error: "Candidate merge conflict",
  });
});
test("a PR left behind main is updated, verified under its original sign-off, and merged next pass", async () => {
  const f = await fixture(1);
  f.remote.get(1)!.mergeable = "CONFLICTING";
  f.backend.signed = async (entry) => entry.head === "head1";
  const updated: string[] = [];
  f.backend.update = async (entry) => {
    updated.push(entry.head);
    Object.assign(f.remote.get(1)!, {
      headRefOid: "updated1",
      mergeable: "MERGEABLE",
    });
    return { status: "pushed", head: "updated1", log: "update.log" };
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(updated).toEqual(["head1"]);
  expect(f.candidates).toEqual([]);
  expect(f.state().entries[0]).toMatchObject({
    status: "queued",
    head: "updated1",
    signedHead: "head1",
  });

  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.candidates).toEqual([[1]]);
  expect(f.merged).toEqual([1]);
});
test("a PR still conflicting after merging main fails with the conflicting files", async () => {
  const f = await fixture(1);
  f.remote.get(1)!.mergeable = "CONFLICTING";
  f.backend.update = async () => ({
    status: "conflict",
    files: ["tests/ai-wire.txt", "app/Prompt.php"],
    log: "update.log",
  });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.state().entries[0]).toMatchObject({
    status: "failed",
    log: "update.log",
  });
  expect(f.state().entries[0]!.error).toContain("tests/ai-wire.txt, app/Prompt.php");
});
test("an unsigned conflicting PR fails without the queue touching its branch", async () => {
  const f = await fixture(1);
  f.remote.get(1)!.mergeable = "CONFLICTING";
  f.backend.signed = async () => false;
  f.backend.update = async () => {
    throw new Error("must not update");
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.state().entries[0]).toMatchObject({
    status: "failed",
    error: "Error: PR must be open, non-draft, mergeable, and target main",
  });
});
test("a PR conflicting only with an earlier sibling waits for it to land", async () => {
  const f = await fixture(2);
  f.backend.candidate = async (batch) => {
    f.candidates.push(batch.map((entry) => entry.pr));
    const both = batch.length === 2;
    return { ok: !both, conflict: both ? 2 : undefined, log: "c.log" };
  };
  f.backend.update = async () => ({ status: "current", log: "update.log" });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1]);
  expect(f.state().entries[1]).toMatchObject({ status: "queued" });
  expect(f.state().history.at(-1)?.event).not.toBe("failed");
});
test("a new author push drops the queue's sign-off carry-over", async () => {
  const f = await fixture(1);
  await updateMergeQueue((state) => {
    Object.assign(state.entries[0]!, { head: "updated1", signedHead: "head1" });
  }, f.directory);
  f.remote.get(1)!.headRefOid = "author2";
  f.backend.signed = async (entry) => entry.head === "head1";
  await processRepository("owner/repo", f.backend, f.directory);
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.state().entries[0]).toMatchObject({
    status: "queued",
    head: "author2",
  });
  expect(f.state().entries[0]!.signedHead).toBeUndefined();
  expect(f.merged).toEqual([]);
});
test("restart after remote merge before receipt never double-merges", async () => {
  const f = await fixture();
  const merge = f.backend.merge;
  f.backend.merge = async (entry) => {
    await merge(entry);
    throw new Error("crash after GitHub accepted merge");
  };
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow("crash");
  expect(f.state().entries[0].status).toBe("queued");
  f.backend.merge = merge;
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 2, 3]);
  expect(f.state().entries.every((entry) => entry.status === "merged")).toBe(true);
});
test("external main movement aborts; setup errors leave entries queued", async () => {
  const f = await fixture();
  f.backend.base = async () => (f.candidates.length ? "external-main" : "main0");
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow(
    "main moved",
  );
  expect(f.merged).toEqual([]);
  f.backend.candidate = async () => {
    throw new Error("setup failed");
  };
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow(
    "setup failed",
  );
  expect(f.state().entries.every((entry) => entry.status === "queued")).toBe(true);
});
test("drafts and closed PRs fail validation", async () => {
  const f = await fixture(1);
  for (const patch of [{ isDraft: true }, { state: "CLOSED" }])
    expect(() => validatePr({ ...f.remote.get(1)!, ...patch })).toThrow();
});
test("a merged batch deploys its final main SHA once and records it", async () => {
  const f = await fixture();
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.deploys).toEqual(["merge3"]);
  expect(f.state().deploys!["owner/repo"]).toMatchObject({
    status: "deployed",
    prs: [1, 2, 3],
  });
  expect(f.state().entries.every((entry) => entry.deployedSha === "merge3")).toBe(true);
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.deploys).toEqual(["merge3"]);
});
test("deploy failures are recorded, never retried automatically, and a dead deploy fails", async () => {
  const f = await fixture(1);
  f.backend.deploy = async () => ({
    ok: false,
    log: "deploy.log",
    error: "verification failed",
  });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.state().deploys!["owner/repo"]).toMatchObject({
    status: "failed",
    error: "verification failed",
  });
  expect(f.state().entries[0]).toMatchObject({
    status: "merged",
    deployError: "verification failed; deploy.log",
  });
  expect(f.state().history.at(-1)!.event).toBe("deploy-failed");
  let calls = 0;
  f.backend.deploy = async () => ({
    ok: true,
    log: "",
    skipped: String(++calls),
  });
  await processRepository("owner/repo", f.backend, f.directory);
  expect(calls).toBe(0);
  await updateMergeQueue((state) => {
    state.deploys!["owner/repo"].status = "running";
  }, f.directory);
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.state().deploys!["owner/repo"]).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Worker stopped"),
  });
});
test("a merge receipt recovered after a crash still deploys", async () => {
  const f = await fixture(1);
  const merge = f.backend.merge;
  f.backend.merge = async (entry) => {
    await merge(entry);
    throw new Error("crash after GitHub accepted merge");
  };
  await expect(processRepository("owner/repo", f.backend, f.directory)).rejects.toThrow("crash");
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.deploys).toEqual(["merge1"]);
});
test("main moved by a direct merge deploys once without queued PRs", async () => {
  const f = await fixture(0);
  f.backend.base = async () => "direct";
  await processRepository("owner/repo", f.backend, f.directory);
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.deploys).toEqual(["direct"]);
  expect(f.state().deploys!["owner/repo"]).toMatchObject({
    status: "deployed",
    sha: "direct",
  });
});
test("bisection reruns only the checks the full batch failed", async () => {
  const f = await fixture(4);
  const seen: (string[] | undefined)[] = [];
  f.backend.candidate = async (batch, _base, checks) => {
    seen.push(checks);
    const ok = !batch.some((entry) => entry.pr === 3);
    return {
      ok,
      log: "x.log",
      runs: ok
        ? []
        : [
            {
              attempt: 1,
              startLoad: 0,
              endLoad: 0,
              log: "r.log",
              failures: [
                {
                  name: "scripts:test-images",
                  log: "i.log",
                  reason: "timeout",
                },
              ],
            },
          ],
    };
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 2, 4]);
  expect(seen[0]).toBeUndefined();
  expect(seen.slice(1).every((checks) => checks?.join() === "scripts:test-images")).toBe(true);
});
test("merged PRs' worktrees are removed after main deploys, and a kept worktree never fails the pass", async () => {
  const f = await fixture(2);
  const steps: string[] = [];
  const deploy = f.backend.deploy;
  f.backend.deploy = async (sha) => {
    steps.push(`deploy ${sha}`);
    return deploy(sha);
  };
  f.backend.removeWorktree = async (entry) => {
    steps.push(`remove ${entry.pr}`);
    if (entry.pr === 1) throw new Error("in use by a running process");
    return `/worktrees/pr-${entry.pr}`;
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(f.merged).toEqual([1, 2]);
  expect(steps).toEqual(["deploy merge2", "remove 1", "remove 2"]);
  expect(f.state().entries.map((entry) => entry.status)).toEqual(["merged", "merged"]);
  expect(f.state().history.map((item) => item.event)).toContain("worktree-removed /worktrees/pr-2");
});
test("a PR merged outside the queue also has its worktree removed", async () => {
  const f = await fixture(1);
  Object.assign(f.remote.get(1)!, {
    state: "MERGED",
    mergeCommit: { oid: "direct" },
    mergedAt: "merged-time",
  });
  const removed: number[] = [];
  f.backend.removeWorktree = async (entry) => {
    removed.push(entry.pr);
    return undefined;
  };
  await processRepository("owner/repo", f.backend, f.directory);
  expect(removed).toEqual([1]);
  expect(f.state().entries[0]!.status).toBe("merged");
});
test("an idle worker signs off every area of main once a day after the nightly hour, recording failures", async () => {
  const f = await fixture(0);
  const runs: string[] = [];
  let ok = true;
  f.backend.nightly = async (base) => {
    runs.push(base);
    return ok
      ? { ok: true, log: "nightly.log" }
      : {
          ok: false,
          log: "nightly.log",
          runs: [
            {
              attempt: 1,
              startLoad: 1,
              endLoad: 1,
              log: "/run-1.log",
              failures: [{ name: "backend:test", log: "/backend.log", reason: "check failure" }],
            },
          ],
        };
  };
  const at = (day: number, hour: number) => () => new Date(2026, 9, day, hour);
  const pass = (clock: () => Date) =>
    processRepository("owner/repo", f.backend, f.directory, async () => {}, clock);

  await pass(at(26, 2));
  expect(runs).toEqual([]);
  await pass(at(26, 3));
  await pass(at(26, 23));
  expect(runs).toEqual(["main0"]);
  expect(f.state().nightly!["owner/repo"]).toMatchObject({
    date: "2026-10-26",
    sha: "main0",
    status: "passed",
  });

  ok = false;
  await pass(at(27, 4));
  expect(runs).toHaveLength(2);
  expect(f.state().nightly!["owner/repo"]).toMatchObject({
    status: "failed",
    log: "nightly.log",
    error: expect.stringContaining("backend:test"),
  });

  await updateMergeQueue((state) => {
    state.nightly!["owner/repo"].status = "running";
  }, f.directory);
  await pass(at(27, 5));
  expect(runs).toHaveLength(2);
  expect(f.state().nightly!["owner/repo"]).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Worker stopped"),
  });
});
test("the nightly sign-off waits while PRs are ready to merge", async () => {
  const f = await fixture(1);
  let nightly = 0;
  f.backend.nightly = async () => {
    nightly++;
    return { ok: true, log: "" };
  };
  await processRepository(
    "owner/repo",
    f.backend,
    f.directory,
    async () => {},
    () => new Date(2026, 9, 26, 4),
  );
  expect(f.merged).toEqual([1]);
  expect(nightly).toBe(0);
  await processRepository(
    "owner/repo",
    f.backend,
    f.directory,
    async () => {},
    () => new Date(2026, 9, 26, 4),
  );
  expect(nightly).toBe(1);
});
