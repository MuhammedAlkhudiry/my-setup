#!/usr/bin/env bun

import { agentOutput } from "../../prs/scripts/agent-output";

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { baseRef, fetchRefs, runner } from "./triage-prs";
import { command, finish, options, prTarget, remoteRepo, Stop } from "../../prs/scripts/pr-cli";

const HELP = `Usage: bun pr-refresh.ts <pr-url> --repo <checkout> --expected-head <sha> [--json] [--verbose] [--dry-run]

Refresh an owned, clean PR branch: fetch its actual base, merge, mise run check,
normal push, then mise run signoff. Retry a behind-main refusal twice. Never merges the PR.
--repo and --expected-head assert ownership of this checkout and its pinned PR head.
Coordinate checkout ownership before calling; a Git-directory lock excludes other refreshes.
Requires same-repository GitHub branches, configured origin, and local check/signoff mise tasks.
Dry-run performs reads only (no fetch, merge, checks, push, sign-off).
Receipts include stage output and resume state. Resolve/commit a conflict, then rerun the
same command with the ORIGINAL --expected-head. State lives in this checkout's Git directory.
Exit: 0 certified/dry-run, 1 stage failed, 2 invalid target, 3 dirty/conflict/locked,
4 remote head/base or local checkout changed. Failures name a full log; --json emits one object; --verbose prints stage output.`;

interface PR {
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  isDraft: boolean;
}

interface State {
  version: 1;
  pr: string;
  branch: string;
  oldHead: string;
  newHead: string;
  baseBranch: string;
  baseSha: string;
  remoteHead?: string;
  phase: "merge" | "conflict" | "checks" | "push" | "signoff";
}

export function refresh(argv: string[]): { code: number; receipt: Record<string, unknown> } {
  const receipt: Record<string, unknown> = { version: 1, stages: [] };
  const stages = receipt.stages as Record<string, unknown>[];
  let lock: string | undefined;
  let lockFd: number | undefined;

  try {
    const parsed = options(argv, ["--repo", "--expected-head"], ["--json", "--dry-run"]);
    const target = prTarget(parsed.target);
    const expected = parsed.values["--expected-head"].toLowerCase();
    if (!existsSync(parsed.values["--repo"]))
      throw new Stop(2, "--repo must be an existing checkout");
    const cwd = realpathSync(resolve(parsed.values["--repo"]));
    const run = runner(cwd);
    const git = (args: string[], allowed = [0]) => run("git", args, allowed);
    const sha = () => git(["rev-parse", "HEAD"]).out.trim();
    const clean = () => !git(["status", "--porcelain=v1", "--untracked-files=all"]).out;
    const pr = (): PR =>
      JSON.parse(
        run("gh", [
          "pr",
          "view",
          parsed.target,
          "--json",
          "state,baseRefName,headRefName,headRefOid,isCrossRepository,isDraft",
        ]).out,
      );
    const initial = pr();

    Object.assign(receipt, {
      pr: parsed.target,
      repo: cwd,
      dryRun: parsed.flags.has("--dry-run"),
      oldHead: expected,
      draft: initial.isDraft,
    });
    if (!/^[a-f0-9]{40}$/.test(expected))
      throw new Stop(2, "--expected-head must be a full 40-character commit SHA");
    if (initial.state !== "OPEN" || initial.isCrossRepository)
      throw new Stop(2, "Requires an open, same-repository PR");
    if (
      realpathSync(git(["rev-parse", "--show-toplevel"]).out.trim()) !== cwd ||
      statSync(cwd).uid !== process.getuid?.()
    )
      throw new Stop(2, "Checkout root must be owned by the current user");

    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]).out.trim();
    if (branch !== initial.headRefName || branch === initial.baseRefName)
      throw new Stop(2, "Checkout must be on the PR head branch, not its base");
    for (const name of [branch, initial.baseRefName])
      git(["check-ref-format", `refs/heads/${name}`]);

    const remote = "origin";
    const urls = git(["config", "--get-all", `remote.${remote}.url`])
      .out.trim()
      .split("\n");
    const pushUrls = git(["config", "--get-all", `remote.${remote}.pushurl`], [0, 1])
      .out.trim()
      .split("\n")
      .filter(Boolean);
    if (
      urls.length !== 1 ||
      remoteRepo(urls[0])?.toLowerCase() !== target.repo.toLowerCase() ||
      pushUrls.some((url) => remoteRepo(url)?.toLowerCase() !== target.repo.toLowerCase()) ||
      pushUrls.length > 1
    )
      throw new Stop(2, "origin fetch/push target must be this PR repository");

    const gitDir = resolve(cwd, git(["rev-parse", "--git-dir"]).out.trim());
    const statePath = join(gitDir, "pr-refresh-state.json");
    const saved = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
      : undefined;
    if (
      saved &&
      (saved.version !== 1 ||
        saved.pr !== parsed.target ||
        saved.oldHead !== expected ||
        saved.branch !== branch ||
        saved.baseBranch !== initial.baseRefName ||
        !["merge", "conflict", "checks", "push", "signoff"].includes(saved.phase) ||
        !/^[a-f0-9]{40}$/.test(saved.newHead) ||
        !/^[a-f0-9]{40}$/.test(saved.baseSha))
    )
      throw new Stop(2, `A different refresh owns ${statePath}; inspect it before continuing`);
    const state: State = saved ?? {
      version: 1,
      pr: parsed.target,
      branch,
      oldHead: expected,
      newHead: expected,
      baseBranch: initial.baseRefName,
      baseSha: "",
      phase: "merge",
    };
    const persist = () => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, statePath);
      receipt.newHead = state.newHead;
      receipt.base = { branch: state.baseBranch, sha: state.baseSha };
      receipt.resume = {
        statePath,
        ...state,
        action:
          "Rerun this command with the original --expected-head after resolving and committing any conflict",
      };
    };
    const ancestor = (parent: string, head: string) =>
      git(["merge-base", "--is-ancestor", parent, head], [0, 1]).ok;

    if (
      !clean() ||
      git(["rev-parse", "--verify", "MERGE_HEAD"], [0, 1, 128]).ok ||
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply")) ||
      existsSync(join(gitDir, "CHERRY_PICK_HEAD"))
    ) {
      receipt.resume = saved
        ? {
            statePath,
            ...saved,
            conflicts: git(["diff", "--name-only", "--diff-filter=U"])
              .out.trim()
              .split("\n")
              .filter(Boolean),
            action:
              "Resolve and commit the merge, then rerun with the original --expected-head; or git merge --abort and rerun",
          }
        : null;
      throw new Stop(3, "Checkout is dirty or has an operation in progress");
    }
    const local = sha();
    if (
      local !== state.newHead &&
      !(saved?.phase === "conflict" && ancestor(expected, local) && ancestor(state.baseSha, local))
    )
      throw new Stop(2, "Local HEAD does not match the expected or saved refresh head");
    if (saved?.phase === "conflict" && local !== expected) {
      state.newHead = local;
      state.phase = "checks";
    }

    const remoteHeads = () => {
      const refs = git([
        "ls-remote",
        "--heads",
        remote,
        `refs/heads/${branch}`,
        `refs/heads/${state.baseBranch}`,
      ])
        .out.trim()
        .split("\n");
      const found = new Map(
        refs.map((line): [string, string] => {
          const [oid, ref] = line.split("\t");

          return [ref, oid];
        }),
      );

      return {
        head: found.get(`refs/heads/${branch}`),
        base: found.get(`refs/heads/${state.baseBranch}`),
      };
    };
    const heads = remoteHeads();
    // A push can succeed just before interruption or a transport error. Resume only the saved, exact head.
    if (
      state.phase === "push" &&
      heads.head === state.newHead &&
      initial.headRefOid === state.newHead
    )
      state.phase = "signoff";
    if (state.phase === "signoff") state.remoteHead = state.newHead;
    state.remoteHead ??= expected;
    if (heads.head !== state.remoteHead || initial.headRefOid !== heads.head)
      throw new Stop(4, "Remote PR head changed");
    if (!heads.base || (state.baseSha && state.baseSha !== heads.base))
      throw new Stop(4, "Remote base changed or disappeared");
    state.baseSha = heads.base;
    Object.assign(receipt, {
      newHead: state.newHead,
      base: { branch: state.baseBranch, sha: state.baseSha },
    });

    const tasks = JSON.parse(run("mise", ["tasks", "ls", "--json"]).out) as {
      name: string;
      source: string;
    }[];
    for (const name of ["check", "signoff"])
      if (
        !tasks.some(
          (task) => task.name === name && task.source && resolve(task.source).startsWith(`${cwd}/`),
        )
      )
        throw new Stop(2, `Missing project-local mise task: ${name}`);
    if (parsed.flags.has("--dry-run")) {
      receipt.status = "dry-run";
      receipt.plan = [
        "fetch actual base and PR head",
        "merge base",
        "mise run check",
        "normal push",
        "mise run signoff",
      ];

      return { code: 0, receipt };
    }

    lock = join(gitDir, "pr-refresh.lock");
    try {
      lockFd = openSync(lock, "wx", 0o600);
    } catch {
      throw new Stop(
        3,
        `Another refresh owns ${lock}; inspect its PID before removing a stale lock`,
      );
    }
    writeFileSync(
      lockFd,
      JSON.stringify({ pid: process.pid, pr: parsed.target, startedAt: new Date().toISOString() }),
    );
    const unchanged = () => {
      if (
        sha() !== state.newHead ||
        !clean() ||
        git(["symbolic-ref", "--short", "HEAD"]).out.trim() !== branch
      )
        throw new Stop(4, "Checkout changed during refresh; inspect it before resuming");
      const current = pr();
      const remoteNow = remoteHeads();
      const wantedHead = state.remoteHead;
      if (
        current.state !== "OPEN" ||
        current.baseRefName !== state.baseBranch ||
        current.headRefName !== branch ||
        current.headRefOid !== wantedHead ||
        remoteNow.head !== wantedHead ||
        remoteNow.base !== state.baseSha
      )
        throw new Stop(4, "Remote PR head/base or state changed during refresh");
    };
    const stage = (name: string, args: string[], allowFailure = false) => {
      console.error(`pr-refresh: ${name}`);
      const startedAt = new Date().toISOString();
      const result = command(cwd, args);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (output) process.stderr.write(output);
      stages.push({
        name,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.status,
        output,
      });
      if (!allowFailure && (result.error || result.status !== 0))
        throw new Stop(1, `${name} failed: ${result.error?.message ?? `exit ${result.status}`}`);

      return { result, output };
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      unchanged();
      persist();
      if (state.phase === "merge" || state.phase === "conflict") {
        const fetching: Record<string, unknown> = {
          name: "fetch",
          startedAt: new Date().toISOString(),
          exitCode: 1,
        };
        stages.push(fetching);
        fetchRefs(run, remote, [state.baseBranch], [target.number]);
        Object.assign(fetching, { finishedAt: new Date().toISOString(), exitCode: 0 });
        if (
          git(["rev-parse", baseRef(state.baseBranch)]).out.trim() !== state.baseSha ||
          git(["rev-parse", `refs/triage-prs/pr/${target.number}`]).out.trim() !== state.remoteHead
        )
          throw new Stop(4, "Remote moved while fetching");
        unchanged();
        const merged = git(["merge", "--no-edit", state.baseSha], [0, 1]);
        stages.push({ name: "merge", exitCode: merged.status, output: merged.out + merged.err });
        if (!merged.ok) {
          state.phase = "conflict";
          persist();
          receipt.resume = {
            ...(receipt.resume as object),
            conflicts: git(["diff", "--name-only", "--diff-filter=U"])
              .out.trim()
              .split("\n")
              .filter(Boolean),
            action:
              "Resolve and commit the merge, then rerun with the original --expected-head; or git merge --abort and rerun",
          };
          throw new Stop(3, "Merge stopped; conflict state is preserved");
        }
        state.newHead = sha();
        state.phase = "checks";
        persist();
      }

      if (state.phase === "checks" || state.phase === "push") {
        state.phase = "checks";
        persist();
        stage("checks", ["heavy-run", "--class", "checks", "--", "mise", "run", "check"]);
        unchanged();
        state.phase = "push";
        persist();
        try {
          stage("push", [
            "git",
            "push",
            "--no-follow-tags",
            remote,
            `${state.newHead}:refs/heads/${branch}`,
          ]);
        } catch (error) {
          const after = remoteHeads();
          if (after.head !== state.remoteHead && after.head !== state.newHead)
            throw new Stop(4, "Remote head moved during push");
          throw error;
        }
        state.remoteHead = state.newHead;
        state.phase = "signoff";
        persist();
      }

      unchanged();
      const signed = stage(
        "signoff",
        ["heavy-run", "--class", "checks", "--json", "--", "mise", "run", "signoff", "--json"],
        true,
      );
      if (signed.result.error || signed.result.status !== 0) {
        // heavy-run retains the child's structured receipt in its private log.
        let behindMain = false;
        try {
          const queued = JSON.parse(signed.output);
          const output = queued.log ? readFileSync(queued.log, "utf8") : signed.output;
          behindMain = output.split("\n").some((line) => {
            try {
              const result = JSON.parse(line);
              return (
                result.command === "signoff" &&
                result.errors?.some(
                  (error: { item: string }) => error.item === "signoff-behind-main",
                )
              );
            } catch {
              return false;
            }
          });
        } catch {
          /* An unstructured failure must never cause a retry. */
        }
        if (!behindMain || attempt === 2)
          throw new Stop(
            1,
            behindMain ? "Main kept moving; sign-off retry limit reached" : "signoff failed",
          );

        // Refuse remote head movement, but accept the base movement sign-off identified.
        const current = pr();
        const heads = remoteHeads();
        if (
          current.state !== "OPEN" ||
          current.headRefOid !== state.remoteHead ||
          heads.head !== state.remoteHead ||
          current.baseRefName !== state.baseBranch ||
          current.headRefName !== branch ||
          !heads.base ||
          sha() !== state.newHead ||
          !clean()
        )
          throw new Stop(4, "PR or checkout changed while sign-off waited");
        state.baseSha = heads.base;
        state.phase = "merge";
        persist();
        continue;
      }
      break;
    }
    unchanged();
    unlinkSync(statePath);
    Object.assign(receipt, {
      status: "certified",
      newHead: state.newHead,
      resume: null,
      checkReceipt: {
        head: state.newHead,
        base: state.baseSha,
        checks: "mise run check",
        signoff: "mise run signoff",
        passed: true,
      },
    });

    return { code: 0, receipt };
  } catch (error) {
    const code = error instanceof Stop ? error.code : 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pr-refresh: ${message}`);

    return { code, receipt: { ...receipt, status: "stopped", exitCode: code, error: message } };
  } finally {
    if (lockFd !== undefined) {
      closeSync(lockFd);
      if (lock) unlinkSync(lock);
    }
  }
}

if (import.meta.main) {
  agentOutput("pr-refresh", { nativeJson: true });

  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    if (argv.includes("--json")) finish({ help: HELP }, 0, true);
    else console.log(HELP);
  } else {
    const result = refresh(argv);
    finish(result.receipt, result.code, argv.includes("--json"));
  }
}
