import { dlopen } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UpdateResult } from "./merge-queue-update";

const {
  symbols: { flock },
} = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
});
export const mergeQueueDirectory = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "merge-queue");
export const MERGE_QUEUE_LABEL = "com.my-setup.merge-queue";
export class QueueEnvironmentError extends Error {}
export class QueueTransientError extends QueueEnvironmentError {}
export interface CandidateRun {
  attempt: number;
  startLoad: number;
  endLoad: number;
  log: string;
  failures: {
    name: string;
    log: string;
    reason: string;
    budgetOnly?: boolean;
  }[];
  /** Set when only per-test timing budgets failed: load noise in a batch, so it lands with this warning. */
  warning?: string;
}
export interface QueueEntry {
  repo: string;
  pr: number;
  head: string;
  /** Set when `head` is the queue's merge of main into this signed head; that sign-off covers it. */
  signedHead?: string;
  thread?: string;
  status: "queued" | "failed" | "merged" | "removed";
  enqueuedAt: string;
  mergedAt?: string;
  failedAt?: string;
  mergedMainSha?: string;
  deployedSha?: string;
  deployError?: string;
  error?: string;
  log?: string;
  runs?: CandidateRun[];
}
export interface QueueHistory {
  at: string;
  event: string;
  entry: QueueEntry;
}
export interface DeployRecord {
  sha: string;
  prs: number[];
  status: "pending" | "running" | "deployed" | "skipped" | "failed";
  at: string;
  deployedSha?: string;
  skipped?: string;
  error?: string;
  log?: string;
}
export interface DeployResult {
  ok: boolean;
  log: string;
  deployedSha?: string;
  skipped?: string;
  error?: string;
}
/** Batches sign off only the areas they change, so a full sign-off of main runs once a night to catch the rest. */
export interface NightlyRecord {
  /** Local date of the run, so each repository runs once per day. */
  date: string;
  sha: string;
  status: "running" | "passed" | "failed";
  at: string;
  error?: string;
  log?: string;
  runs?: CandidateRun[];
}
/** Local hour after which a worker pass with nothing to merge runs the day's full sign-off. */
export const NIGHTLY_HOUR = 3;
export interface MergeQueueState {
  environment?: Record<
    string,
    { cause: string; attempts: number; retryAt: string; transient?: boolean }
  >;
  /** The latest merged main SHA each repository's worker deploys, and how that went. */
  deploys?: Record<string, DeployRecord>;
  nightly?: Record<string, NightlyRecord>;
  entries: QueueEntry[];
  history: QueueHistory[];
}
export function readMergeQueue(directory = mergeQueueDirectory()): MergeQueueState {
  try {
    return JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { entries: [], history: [] };
  }
}
export function acquireQueueLock(
  name: string,
  directory = mergeQueueDirectory(),
): (() => void) | undefined {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${name}.lock`), "a", 0o600);
  if (flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    return;
  }
  return () => {
    flock(fd, 8);
    closeSync(fd);
  };
}
export async function updateMergeQueue(
  fn: (state: MergeQueueState) => void,
  directory = mergeQueueDirectory(),
) {
  let release = acquireQueueLock("state", directory);
  while (!release) {
    await Bun.sleep(25);
    release = acquireQueueLock("state", directory);
  }
  try {
    const state = readMergeQueue(directory);
    fn(state);
    const path = join(directory, "state.json");
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    release();
  }
}
export function record(state: MergeQueueState, entry: QueueEntry, event: string) {
  state.history.push({
    at: new Date().toISOString(),
    event,
    entry: { ...entry },
  });
}
export interface PullRequest {
  state: string;
  isDraft: boolean;
  mergeable: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: string;
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
  files: { path: string }[];
}
export interface QueueBackend {
  recover?(): Promise<void>;
  inspect(entry: QueueEntry): Promise<PullRequest>;
  signed(entry: QueueEntry): Promise<boolean>;
  base(): Promise<string>;
  /** `checks` limits verification to those checks, for bisecting a batch whose sign-off ran. */
  candidate(
    entries: QueueEntry[],
    base: string,
    checks?: string[],
  ): Promise<{
    ok: boolean;
    log: string;
    conflict?: number;
    runs?: CandidateRun[];
  }>;
  merge(entry: QueueEntry): Promise<void>;
  /** Merges main into the PR branch and pushes it without force. */
  update?(entry: QueueEntry): Promise<UpdateResult>;
  deploy(sha: string): Promise<DeployResult>;
  /** Signs off every area of main at `base`, posting nothing. */
  nightly?(base: string): Promise<{
    ok: boolean;
    log: string;
    runs?: CandidateRun[];
  }>;
  /** Removes the merged PR's own task worktree when nothing in it can be lost; returns the removed path. */
  removeWorktree?(entry: QueueEntry): Promise<string | undefined>;
}
export function validatePr(pr: PullRequest) {
  if (pr.mergeable === "UNKNOWN")
    throw new QueueTransientError("GitHub is recalculating PR mergeability");
  if (
    pr.state !== "OPEN" ||
    pr.isDraft ||
    pr.mergeable !== "MERGEABLE" ||
    pr.baseRefName !== "main"
  )
    throw new Error("PR must be open, non-draft, mergeable, and target main");
  if (pr.reviewDecision === "CHANGES_REQUESTED") throw new Error("PR has requested changes");
}
async function inspectReady(
  entry: QueueEntry,
  backend: QueueBackend,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pr = await backend.inspect(entry);
    if (pr.mergeable !== "UNKNOWN" || pr.state !== "OPEN") return pr;
    if (attempt < 4) await sleep(2000);
  }
  throw new QueueTransientError("GitHub is recalculating PR mergeability");
}
const runDetails = (runs?: CandidateRun[]) => {
  const details = runs
    ?.map(
      (run) =>
        `run ${run.attempt}: ${run.failures.map((failure) => `${failure.name}: ${failure.reason}; log=${failure.log}`).join("; ")}; candidate log=${run.log}`,
    )
    .join(" | ");
  return details ? `: ${details}` : "";
};
export const CANDIDATE_CONFLICT = "Candidate merge conflict";
/** Divide a failed candidate, preserving the passing prefix so interacting changes are tested together. */
export async function passingBatch(
  entries: QueueEntry[],
  base: string,
  backend: QueueBackend,
  fail: (entry: QueueEntry, reason: string, log: string, runs?: CandidateRun[]) => Promise<void>,
  prefix: QueueEntry[] = [],
  checks?: string[],
): Promise<QueueEntry[]> {
  if (!entries.length) return prefix;
  const result = await backend.candidate([...prefix, ...entries], base, checks);
  if (result.ok) return [...prefix, ...entries];
  if (result.conflict !== undefined) {
    const culprit = entries.find((entry) => entry.pr === result.conflict);
    if (!culprit) throw new Error("Previously passing prefix now conflicts");
    await fail(culprit, CANDIDATE_CONFLICT, result.log);
    return passingBatch(
      entries.filter((entry) => entry !== culprit),
      base,
      backend,
      fail,
      prefix,
      checks,
    );
  }
  if (entries.length === 1) {
    await fail(
      entries[0],
      `Candidate sign-off failed${runDetails(result.runs)}`,
      result.log,
      result.runs,
    );
    return prefix;
  }
  // The batch ran its areas' checks; subsets rerun only the checks that failed, which is much faster.
  const failed = [...new Set(result.runs?.at(-1)?.failures.map((failure) => failure.name))].filter(
    (name) => name !== "signoff",
  );
  const narrowed = checks ?? (failed.length ? failed : undefined);
  const middle = Math.ceil(entries.length / 2);
  const passing = await passingBatch(
    entries.slice(0, middle),
    base,
    backend,
    fail,
    prefix,
    narrowed,
  );
  return passingBatch(entries.slice(middle), base, backend, fail, passing, narrowed);
}
function queueDeploy(state: MergeQueueState, repo: string, sha: string, pr: number) {
  state.deploys ??= {};
  const previous = state.deploys[repo];
  if (
    (previous?.status === "deployed" || previous?.status === "skipped") &&
    (previous.sha === sha || previous.deployedSha === sha)
  )
    return;
  const prs = previous?.status === "pending" ? previous.prs : [];
  state.deploys[repo] = {
    sha,
    prs: [...new Set([...prs, pr])],
    status: "pending",
    at: new Date().toISOString(),
  };
}
/** Worktree cleanup is housekeeping: a failure is logged and never holds up merges or deploys. */
async function removeMergedWorktree(entry: QueueEntry, backend: QueueBackend, directory: string) {
  try {
    const removed = await backend.removeWorktree?.(entry);
    if (!removed) return;

    await updateMergeQueue((state) => {
      const current = state.entries.find(
        (item) => item.repo === entry.repo && item.pr === entry.pr,
      );
      if (current) record(state, current, `worktree-removed ${removed}`);
    }, directory);
  } catch (error) {
    console.error(
      `merge-queue: ${entry.repo}#${entry.pr} worktree kept: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
/** Deploy the latest merged SHA once; failures are recorded for status, never retried automatically. */
async function deployMerged(repo: string, backend: QueueBackend, directory: string) {
  const pending = readMergeQueue(directory).deploys?.[repo];
  if (pending?.status !== "pending") return;

  await updateMergeQueue((state) => {
    state.deploys![repo] = {
      ...pending,
      status: "running",
      at: new Date().toISOString(),
    };
  }, directory);
  let result: DeployResult;
  try {
    result = await backend.deploy(pending.sha);
  } catch (error) {
    result = { ok: false, log: "", error: String(error) };
  }

  await updateMergeQueue((state) => {
    state.deploys![repo] = {
      ...pending,
      status: !result.ok ? "failed" : result.skipped ? "skipped" : "deployed",
      at: new Date().toISOString(),
      deployedSha: result.deployedSha,
      skipped: result.skipped,
      error: result.error,
      log: result.log,
    };
    for (const entry of state.entries) {
      if (entry.repo !== repo || !pending.prs.includes(entry.pr) || entry.status !== "merged")
        continue;
      if (result.ok) entry.deployedSha = result.deployedSha ?? result.skipped;
      else entry.deployError = `${result.error ?? "deploy failed"}; ${result.log}`;
      record(
        state,
        entry,
        result.ok ? (result.skipped ? "deploy-skipped" : "deployed") : "deploy-failed",
      );
    }
  }, directory);
}
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** Runs the day's full sign-off of main once, after NIGHTLY_HOUR; failures are recorded for status, never retried. */
async function nightlySignoff(repo: string, backend: QueueBackend, directory: string, now: Date) {
  const date = localDate(now);
  if (
    !backend.nightly ||
    now.getHours() < NIGHTLY_HOUR ||
    readMergeQueue(directory).nightly?.[repo]?.date === date
  )
    return;

  const sha = await backend.base();
  const started: NightlyRecord = {
    date,
    sha,
    status: "running",
    at: new Date().toISOString(),
  };
  await updateMergeQueue((state) => {
    state.nightly ??= {};
    state.nightly[repo] = started;
  }, directory);
  let result: Awaited<ReturnType<NonNullable<QueueBackend["nightly"]>>>;
  let error: string | undefined;
  try {
    result = await backend.nightly(sha);
  } catch (thrown) {
    result = { ok: false, log: "" };
    error = String(thrown);
  }

  await updateMergeQueue((state) => {
    state.nightly![repo] = {
      ...started,
      status: result.ok ? "passed" : "failed",
      at: new Date().toISOString(),
      error: result.ok ? undefined : (error ?? `Full sign-off failed${runDetails(result.runs)}`),
      log: result.log || undefined,
      runs: result.runs,
    };
  }, directory);
}
export async function processRepository(
  repo: string,
  backend: QueueBackend,
  directory = mergeQueueDirectory(),
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
  now = () => new Date(),
) {
  const release = acquireQueueLock(`worker-${repo.replaceAll("/", "-")}`, directory);
  if (!release) return;
  const change = async (entry: QueueEntry, event: string, patch: Partial<QueueEntry>) =>
    updateMergeQueue((state) => {
      const current = state.entries.find(
        (item) => item.repo === entry.repo && item.pr === entry.pr,
      );
      if (!current || current.head !== entry.head || current.status !== "queued")
        throw new Error("Queue changed during batch; rebuilding next pass");
      Object.assign(current, patch);
      record(state, current, event);
    }, directory);
  const failed = (entry: QueueEntry, error: string, log?: string) =>
    change(entry, "failed", {
      status: "failed",
      failedAt: new Date().toISOString(),
      error,
      log,
    });
  // A sibling landing first leaves a PR behind main; merge main into it rather than fail it.
  const update = async (entry: QueueEntry, reason: string) => {
    const result = await backend.update!(entry);
    if (result.status === "pushed")
      await change(entry, "updated-from-main", {
        head: result.head,
        signedHead: entry.signedHead ?? entry.head,
      });
    if (result.status === "conflict")
      await failed(
        entry,
        `${reason}; merging main still conflicts in ${result.files.join(", ")}`,
        result.log,
      );
    return result.status;
  };
  try {
    const broken = readMergeQueue(directory).environment?.[repo];
    if (broken && Date.parse(broken.retryAt) > Date.now()) return;

    await backend.recover?.();

    // Holding the worker lock, a running deploy belongs to a worker that died mid-deploy.
    await updateMergeQueue((state) => {
      const deploy = state.deploys?.[repo];
      if (deploy?.status === "running")
        Object.assign(deploy, {
          status: "failed",
          at: new Date().toISOString(),
          error: "Worker stopped during deploy; check production before retry-deploy",
        });
      const nightly = state.nightly?.[repo];
      if (nightly?.status === "running")
        Object.assign(nightly, {
          status: "failed",
          at: new Date().toISOString(),
          error: "Worker stopped during the nightly full sign-off",
        });
    }, directory);
    // Direct merges bypass the batch receipts; deploy main whenever it moved past the last deploy.
    const last = readMergeQueue(directory).deploys?.[repo];
    if (!last || last.status === "deployed" || last.status === "skipped") {
      const main = await backend.base();
      if (main !== last?.sha && main !== last?.deployedSha)
        await updateMergeQueue((state) => {
          state.deploys ??= {};
          state.deploys[repo] = {
            sha: main,
            prs: [],
            status: "pending",
            at: new Date().toISOString(),
          };
        }, directory);
    }
    await deployMerged(repo, backend, directory);

    const queued = readMergeQueue(directory).entries.filter(
      (entry) => entry.repo === repo && entry.status === "queued",
    );
    const ready: QueueEntry[] = [];
    for (const entry of queued) {
      const pr = await inspectReady(entry, backend, sleep);
      if (pr.state === "MERGED") {
        await change(entry, "merged", {
          status: "merged",
          mergedAt: pr.mergedAt ?? new Date().toISOString(),
          mergedMainSha: pr.mergeCommit?.oid,
        });
        if (pr.mergeCommit?.oid)
          await updateMergeQueue(
            (state) => queueDeploy(state, repo, pr.mergeCommit!.oid, entry.pr),
            directory,
          );
        await removeMergedWorktree(entry, backend, directory);
        continue;
      }
      if (pr.headRefOid !== entry.head) {
        await change(entry, "head-changed", {
          head: pr.headRefOid,
          signedHead: undefined,
          enqueuedAt: new Date().toISOString(),
        });
        continue;
      }
      const signed = await backend.signed({
        ...entry,
        head: entry.signedHead ?? entry.head,
      });
      const behind = signed && pr.mergeable === "CONFLICTING" && backend.update !== undefined;
      try {
        validatePr(behind ? { ...pr, mergeable: "MERGEABLE" } : pr);
      } catch (error) {
        if (error instanceof QueueTransientError) throw error;
        await failed(entry, String(error));
        continue;
      }
      // An updated branch joins the next pass, once GitHub has the new head.
      if (behind) {
        if ((await update(entry, "PR conflicts with main")) === "current")
          await failed(entry, "PR must be open, non-draft, mergeable, and target main");
        continue;
      }
      if (signed) ready.push(entry);
    }
    if (!ready.length) {
      await deployMerged(repo, backend, directory);
      return await nightlySignoff(repo, backend, directory, now());
    }
    const base = await backend.base();
    const passing = await passingBatch(ready, base, backend, async (entry, error, log, runs) => {
      if (error !== CANDIDATE_CONFLICT || !backend.update)
        return change(entry, "failed", {
          status: "failed",
          failedAt: new Date().toISOString(),
          error,
          log,
          runs,
        });
      // Already containing main, it conflicts only with an earlier PR in this batch; retry once that lands.
      if ((await update(entry, error)) === "current")
        await change(entry, "waiting-for-sibling", {});
    });
    // Freeze membership before publishing any merge. A changed/removed member invalidates the combined result.
    for (const entry of passing) {
      const pr = await backend.inspect(entry);
      if (pr.headRefOid !== entry.head) {
        await change(entry, "head-changed", {
          head: pr.headRefOid,
          signedHead: undefined,
          enqueuedAt: new Date().toISOString(),
        });
        return;
      }
    }
    let expectedBase = base;
    const landed: QueueEntry[] = [];
    for (const entry of passing) {
      const current = readMergeQueue(directory).entries.find(
        (item) => item.repo === repo && item.pr === entry.pr,
      );
      if (current?.status !== "queued" || current.head !== entry.head) return;
      if ((await backend.base()) !== expectedBase)
        throw new Error("main moved outside this batch; rebuilding next pass");

      await backend.merge(entry);
      const merged = await backend.inspect(entry);
      if (merged.state !== "MERGED" || !merged.mergeCommit?.oid)
        throw new Error("Merge not confirmed; recovery will inspect GitHub next pass");
      expectedBase = merged.mergeCommit.oid;
      await change(entry, "merged", {
        status: "merged",
        mergedAt: merged.mergedAt ?? new Date().toISOString(),
        mergedMainSha: expectedBase,
      });
      await updateMergeQueue(
        (state) => queueDeploy(state, repo, expectedBase, entry.pr),
        directory,
      );
      landed.push(entry);
    }
    await updateMergeQueue((state) => {
      delete state.environment?.[repo];
    }, directory);
    await deployMerged(repo, backend, directory);
    for (const entry of landed) await removeMergedWorktree(entry, backend, directory);
  } catch (error) {
    if (error instanceof QueueEnvironmentError) {
      await updateMergeQueue((state) => {
        state.environment ??= {};
        const transient = error instanceof QueueTransientError;
        const attempts = (state.environment[repo]?.attempts ?? 0) + 1;
        state.environment[repo] = {
          cause: error.message,
          attempts,
          retryAt: new Date(
            Date.now() +
              (transient
                ? Math.min(30_000, 5_000 * 2 ** Math.min(attempts - 1, 3))
                : Math.min(86_400_000, 900_000 * 2 ** Math.min(attempts - 1, 7))),
          ).toISOString(),
          transient,
        };
      }, directory);
    }
    throw error;
  } finally {
    release();
  }
}
