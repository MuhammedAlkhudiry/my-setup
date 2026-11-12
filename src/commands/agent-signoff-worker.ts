#!/usr/bin/env bun
// Private SSH worker on a spare Mac: runs an agent's `mise run signoff` on one pushed commit in its own worktree.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import type { AgentSignoffRequest } from "../lib/agent-signoff";
import { agentSignoffDirectory } from "../lib/agent-signoff";
import { acquireQueueLock } from "../lib/merge-queue";
import { projectForRepo } from "../lib/merge-queue-backend";
import { collectLogs } from "../lib/merge-queue-hosts";

// Each slot's path recurs, so the checkout-specific test database prepare makes is reused instead of piling up.
const SLOTS = 4;

if (import.meta.main) {
  let release: (() => void) | undefined;
  let canonical = "";
  let worktree = "";
  try {
    const request = JSON.parse(await Bun.stdin.text()) as AgentSignoffRequest;
    canonical = projectForRepo(request.repo).canonicalRoot;
    if (!/^[0-9a-f]{40}$/.test(request.sha)) throw new Error("Invalid commit");
    if (!/^[\w./-]+$/.test(request.branch) || request.branch === "main")
      throw new Error("Invalid branch");

    const slug = request.repo.replaceAll("/", "-").toLowerCase();
    const root = join(agentSignoffDirectory(), slug);
    let slot = 0;
    for (; slot < SLOTS && !release; slot++) release = acquireQueueLock(`slot-${slot}`, root);
    if (!release) throw new Error(`all ${SLOTS} sign-off slots busy`);
    worktree = join(root, `slot-${slot - 1}`);

    const logs = join(agentSignoffDirectory(), "logs");
    await mkdir(logs, { recursive: true });
    const log = join(logs, `${slug}-${request.sha.slice(0, 9)}-${Date.now()}.log`);
    const step = async (command: string, args: string[], cwd: string, timeout: number) => {
      const result = await execa(command, args, {
        cwd,
        all: true,
        reject: false,
        timeout,
        forceKillAfterDelay: 5000,
      });
      await writeFile(log, `$ ${command} ${args.join(" ")}\n${result.all ?? ""}\n`, { flag: "a" });
      return result;
    };
    const must = async (command: string, args: string[], cwd: string, timeout = 300_000) => {
      const result = await step(command, args, cwd, timeout);
      if (result.failed) throw new Error(`${command} ${args[0]} failed; log=${log}`);
    };

    await removeWorktree(canonical, worktree);
    await must(
      "git",
      ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", request.sha],
      canonical,
    );
    await must("git", ["worktree", "add", "--detach", worktree, request.sha], canonical);
    await must("mise", ["trust", "--quiet", join(worktree, "mise.toml")], worktree);
    await must("mise", ["run", "prepare"], worktree, 1_800_000);
    // As in the queue: Composer's filament:upgrade republishes vendor assets, which would leave the checkout dirty.
    const generated = (await execa("git", ["diff", "--name-only", "-z"], { cwd: worktree })).stdout
      .split("\0")
      .filter((path) => /(?:^|\/)public\/(?:css|js|fonts)\/filament\//.test(path));
    if (generated.length)
      await must("git", ["restore", "--worktree", "--", ...generated], worktree);

    const signoff = await step(
      "mise",
      ["run", "signoff", ...(request.args.length ? ["--", ...request.args] : [])],
      worktree,
      10_800_000,
    );
    if (signoff.timedOut) throw new Error(`sign-off timed out; log=${log}`);
    const output = (signoff.stdout || signoff.stderr).trim();
    console.log(
      JSON.stringify({
        exitCode: signoff.exitCode ?? 1,
        output,
        logs: await collectLogs([log, ...[...output.matchAll(/log=(\/\S+)/g)].map((m) => m[1]!)]),
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ error: String(error) }));
  } finally {
    if (worktree) await removeWorktree(canonical, worktree).catch(() => undefined);
    release?.();
  }
}

async function removeWorktree(canonical: string, worktree: string) {
  if (existsSync(worktree))
    await execa("git", ["worktree", "remove", "--force", worktree], {
      cwd: canonical,
      reject: false,
    });
  await rm(worktree, { recursive: true, force: true });
  await execa("git", ["worktree", "prune"], { cwd: canonical, reject: false });
}
