#!/usr/bin/env bun
// Private SSH worker: never enqueues, merges, deploys, or forwards to main-mac.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { githubBackend, projectForRepo } from "../lib/merge-queue-backend";
import { acquireQueueLock, QueueTransientError } from "../lib/merge-queue";
import { collectSignoffLogs, type SignoffRequest } from "../lib/merge-queue-hosts";
import { signoffPolicy } from "../lib/merge-queue-signoff";

// execa resolves timed-out commands when reject:false; both paths are infrastructure failures.
export function deadlineRunner(
  run: NonNullable<Parameters<typeof githubBackend>[1]>,
  deadline: number,
): NonNullable<Parameters<typeof githubBackend>[1]> {
  return async (command, args, options) => {
    try {
      const result = await run(command, args, {
        ...options,
        timeout: Math.max(1, Math.min(options.timeout ?? Infinity, deadline - Date.now())),
      });
      if ((result as { timedOut?: boolean }).timedOut)
        throw new QueueTransientError("Remote command timed out");
      return result;
    } catch (error) {
      if ((error as { timedOut?: boolean }).timedOut)
        throw new QueueTransientError("Remote command timed out");
      throw error;
    }
  };
}

if (import.meta.main) {
  if (process.platform !== "darwin") process.exit(0);
  if (process.argv.includes("--probe")) {
    const release = acquireQueueLock("signoff");
    console.log(
      JSON.stringify({ load: loadavg()[0], maxLoad: signoffPolicy().maxLoad, busy: !release }),
    );
    release?.();
  } else {
    let directory: string | undefined;
    let release: (() => void) | undefined;
    try {
      const request = JSON.parse(await Bun.stdin.text()) as SignoffRequest;
      projectForRepo(request.repo);
      if (!/^[0-9a-f]{40}$/.test(request.sha) || !/^[0-9a-f]{40}$/.test(request.base))
        throw new Error("Invalid candidate commit");
      // Protect the reusable worktree before changing it, including across a lost SSH connection.
      release = acquireQueueLock(`remote-${request.repo.replaceAll("/", "-")}`);
      if (!release) throw new QueueTransientError("Remote candidate worktree busy");
      directory = await mkdtemp(join(tmpdir(), "merge-queue-transfer-"));
      const bundle = join(directory, "candidate.bundle");
      await writeFile(bundle, Buffer.from(request.bundle, "base64"), { mode: 0o600 });
      const deadline = Date.now() + 10_740_000;
      const execute = deadlineRunner(
        (command, args, options) => execa(command, args, { ...options, forceKillAfterDelay: 5000 }),
        deadline,
      );
      const backend = githubBackend(request.repo, execute, {
        hosts: null,
        preparedCandidate: { sha: request.sha, bundle },
      });
      const result = await backend.candidate(request.entries, request.base, request.checks, {
        full: request.full,
        since: request.since,
        areas: request.areas,
      });
      console.log(JSON.stringify({ result, logs: await collectSignoffLogs(result) }));
    } catch (error) {
      // A worker exception is an infrastructure result, distinct from a completed failing check.
      console.log(JSON.stringify({ error: String(error) }));
    } finally {
      release?.();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
