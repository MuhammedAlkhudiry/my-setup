import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { WORKER_TOOL_PROBE } from "./merge-queue-environment";
import { candidateSignoff, type signoffPolicy } from "./merge-queue-signoff";
import { mergeMainIntoBranch } from "./merge-queue-update";
import {
  mergeQueueDirectory,
  QueueEnvironmentError,
  QueueTransientError,
  type PullRequest,
  type QueueBackend,
} from "./merge-queue";
import { removeMergedWorktree } from "./merged-worktree";

export function projectForRepo(repo: string) {
  const project = ACTIVE_PROJECTS.find(
    (project) =>
      project.remoteUrl
        .replace("https://github.com/", "")
        .replace(/\.git$/, "")
        .toLowerCase() === repo.toLowerCase(),
  );
  if (!project) throw new Error("Repository is not an active project");
  return project;
}
type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    reject?: boolean;
    all?: boolean;
    timeout?: number;
    env?: Record<string, string>;
  },
) => Promise<{ stdout: string; all?: string; failed?: boolean }>;
export function githubBackend(
  repo: string,
  execute: CommandRunner = execa,
  signoffOptions: {
    policy?: ReturnType<typeof signoffPolicy>;
    admission?: Parameters<typeof candidateSignoff>[0]["admission"];
    readLog?: (path: string) => Promise<string>;
  } = {},
): QueueBackend {
  const gh = async (args: string[]) => (await execute("gh", args, { timeout: 60_000 })).stdout;
  const project = projectForRepo(repo);
  const marker = join(mergeQueueDirectory(), `candidate-${repo.replaceAll("/", "-")}.json`);
  const slug = repo.replaceAll("/", "-");
  // Checks confirmed failing on a main SHA, so bisection does not rerun them for every half.
  const brokenOnMain = new Set<string>();
  // State lives outside managed project worktree roots, so the resource keeper leaves it alone.
  const root = join(mergeQueueDirectory(), "candidates", slug.toLowerCase());
  const clone = join(root, "repo");
  const worktree = join(root, "candidate");
  const updateWorktree = join(root, "update");
  const logPath = async (suffix = "") => {
    const logs = join(mergeQueueDirectory(), "logs");
    await mkdir(logs, { recursive: true });
    return join(logs, `${slug}-${Date.now()}-${crypto.randomUUID()}${suffix}.log`);
  };
  const ensureClone = async (
    run: (name: string, args: string[], cwd?: string) => Promise<string>,
  ) => {
    if (existsSync(clone)) return;
    await run("git", ["clone", "--shared", "--no-checkout", project.canonicalRoot, clone], root);
    await run("git", ["remote", "set-url", "origin", project.remoteUrl], clone);
  };
  const recover = async () => {
    const probe = await execute("/bin/zsh", ["-f", "-c", WORKER_TOOL_PROBE], {
      reject: false,
      all: true,
      timeout: 20_000,
    });
    if (probe.failed)
      throw new QueueEnvironmentError(`environment broken: ${probe.all || probe.stdout}`);

    await mkdir(mergeQueueDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(
      join(mergeQueueDirectory(), `environment-${repo.replaceAll("/", "-")}.json`),
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        service: process.env.XPC_SERVICE_NAME ?? null,
        tools: probe.stdout.trim().split("\n"),
        herd: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => /^HERD_PHP_\d+_INI_SCAN_DIR$/.test(key)),
        ),
      }),
      { mode: 0o600 },
    );
    try {
      const stale = JSON.parse(await readFile(marker, "utf8"));
      if (
        typeof stale.root !== "string" ||
        !stale.root.startsWith(join(tmpdir(), "merge-queue-")) ||
        stale.root.includes("/../")
      )
        throw new Error("Invalid candidate cleanup marker");
      await rm(stale.root, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(marker, { force: true });
  };
  const backend: QueueBackend = {
    recover,
    inspect: async (entry) => {
      const pr = JSON.parse(
        await gh([
          "pr",
          "view",
          String(entry.pr),
          "--repo",
          repo,
          "--json",
          "state,isDraft,mergeable,headRefOid,baseRefName,reviewDecision,mergeCommit,mergedAt,changedFiles",
        ]),
      );
      const pages = JSON.parse(
        await gh([
          "api",
          `repos/${repo}/pulls/${entry.pr}/files?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      );
      pr.files = pages
        .flat()
        .flatMap((file: { filename: string; previous_filename?: string }) => [
          { path: file.filename },
          ...(file.previous_filename ? [{ path: file.previous_filename }] : []),
        ]);
      if (pages.flat().length !== pr.changedFiles)
        throw new Error("Incomplete changed-file list; refusing queue validation");
      return pr as PullRequest;
    },
    signed: async (entry) => {
      const status = JSON.parse(await gh(["api", `repos/${repo}/commits/${entry.head}/status`]));
      return status.statuses.some(
        (item: { context: string; state: string }) =>
          item.context === "signoff" && item.state === "success",
      );
    },
    base: async () => JSON.parse(await gh(["api", `repos/${repo}/git/ref/heads/main`])).object.sha,
    removeWorktree: (entry) =>
      removeMergedWorktree({
        canonicalRoot: project.canonicalRoot,
        head: entry.head,
        home: homedir(),
      }),
    merge: async (entry) => {
      // The branch rule needs `signoff` on the queue's own merge commit; the candidate sign-off that just passed covers it.
      if (entry.signedHead)
        await gh([
          "api",
          "--method=POST",
          "--silent",
          `repos/${repo}/statuses/${entry.head}`,
          "-f",
          "state=success",
          "-f",
          "context=signoff",
          "-f",
          `description=Merge queue: main merged into signed ${entry.signedHead.slice(0, 7)}, candidate sign-off passed`,
        ]);
      await gh([
        "pr",
        "merge",
        String(entry.pr),
        "--repo",
        repo,
        "--squash",
        "--match-head-commit",
        entry.head,
      ]);
    },
    update: async (entry) => {
      const branch = (
        await gh([
          "pr",
          "view",
          String(entry.pr),
          "--repo",
          repo,
          "--json",
          "headRefName",
          "--jq",
          ".headRefName",
        ])
      ).trim();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const log = await logPath("-update");
      let output = "";
      const git = async (args: string[], cwd = updateWorktree) => {
        output += `$ git ${args.join(" ")}\n`;
        const result = await execute("git", args, {
          cwd,
          reject: false,
          all: true,
          timeout: 600_000,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        output += `${result.all ?? ""}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return result;
      };
      const run = async (name: string, args: string[], cwd = clone) => {
        const result = await git(args, cwd);
        if (result.failed) throw new Error(`${name} ${args[0]} failed: ${result.all}; ${log}`);
        return result.stdout.trim();
      };
      await ensureClone(run);
      // Share the canonical clone's recorded resolutions, so a conflict resolved once in a task worktree replays here.
      const rrCache = join(clone, ".git/rr-cache");
      if (!existsSync(rrCache)) {
        const common = await run("git", [
          "-C",
          project.canonicalRoot,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        await mkdir(join(common, "rr-cache"), { recursive: true });
        await symlink(join(common, "rr-cache"), rrCache);
      }
      if (!existsSync(updateWorktree)) {
        await run("git", ["worktree", "prune"]);
        await run("git", ["worktree", "add", "--detach", updateWorktree, "origin/main"]);
      }
      const mergiraf = await execute("mergiraf", ["languages", "--gitattributes"], {
        reject: false,
        timeout: 20_000,
      });
      return mergeMainIntoBranch({
        git,
        branch,
        head: entry.head,
        log,
        mergiraf: mergiraf.failed
          ? undefined
          : {
              attributesFile: join(root, "mergiraf.gitattributes"),
              patterns: mergiraf.stdout,
            },
      });
    },
    deploy: async (sha) => {
      const log = await logPath("-deploy");
      let output = "";
      const step = async (command: string, args: string[], timeout = 600_000) => {
        output += `$ ${command} ${args.join(" ")}\n`;
        const result = await execute(command, args, {
          cwd: worktree,
          reject: false,
          all: true,
          timeout,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        output += `${result.all ?? ""}\n`;
        await writeFile(log, output, { mode: 0o600 });
        if (result.failed)
          throw new Error(
            `${command} ${args.slice(0, 3).join(" ")} failed: ${(result.all ?? "").trim().slice(-800)}`,
          );
        return result.stdout.trim();
      };
      try {
        if (!existsSync(worktree)) throw new Error("No candidate worktree to deploy from");
        await step("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
        await step("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
        // A batch's main SHA has the verified candidate's tree; prepare again only when it differs.
        const prepared =
          (await step("git", ["rev-parse", "HEAD^{tree}"])) ===
          (await step("git", ["rev-parse", `${sha}^{tree}`]));
        await step("git", ["reset", "--hard", sha]);
        await step("git", ["clean", "-fd"]);
        await step("mise", ["trust"]);
        if (!prepared)
          await step(
            "heavy-run",
            ["--class", "checks", "--wait", "3600", "--", "mise", "run", "prepare"],
            3_900_000,
          );
        // Run only a deploy task the merged main defines; older mains have just the SSH deploy.
        const tasks = new Set(
          (
            JSON.parse(await step("mise", ["tasks", "ls", "--json"])) as {
              name: string;
            }[]
          ).map((task) => task.name),
        );
        if (!tasks.has("deploy") && tasks.has("deploy:ssh")) {
          await step("mise", ["run", "deploy:ssh"], 2_700_000);
          return {
            ok: true,
            log,
            deployedSha: await step("git", ["rev-parse", "origin/main"]),
          };
        }
        if (!tasks.has("deploy"))
          return {
            ok: true,
            log,
            skipped: "main defines no deploy or deploy:ssh task",
          };
        const last =
          (await step("mise", ["run", "deploy", "--", "--sha", sha], 2_700_000))
            .split("\n")
            .at(-1) ?? "";
        const deployed = last.match(/^deployed ([0-9a-f]{40})$/)?.[1];
        const skipped = last.match(/^skipped (.+)$/)?.[1];
        if (!deployed && !skipped) throw new Error(`Deploy printed no result line: ${last}`);
        return { ok: true, log, deployedSha: deployed, skipped };
      } catch (error) {
        output += `${String(error)}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return { ok: false, log, error: String(error) };
      }
    },
    candidate: async (entries, base, checks) => {
      // No entries: the nightly full sign-off of plain main.
      const nightly = !entries.length;
      await recover();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const log = await logPath();
      let output = "";
      let baselinePrepared = false;
      let checkingPr = false;
      const command = async (command: string, args: string[], cwd = clone) => {
        output += `$ ${command} ${args.join(" ")}\n`;
        await writeFile(log, output, { mode: 0o600 });
        const result = await execute(command, args, {
          cwd,
          reject: false,
          all: true,
          env: { HEAVY_RUN_UNCAPPED: "1", GIT_TERMINAL_PROMPT: "0" },
        });
        output += `${(result.all ?? "").replaceAll("\0", "\n")}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return result;
      };
      const run = async (name: string, args: string[], cwd = clone) => {
        const result = await command(name, args, cwd);
        if (result.failed)
          throw new Error(
            `Candidate command failed: ${result.all?.trim().slice(-1500) || name}; ${log}`,
          );
        return result.stdout.trim();
      };
      const prepare = async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const result = await command(
            "heavy-run",
            ["--class", "checks", "--wait", "3600", "--", "mise", "run", "prepare"],
            worktree,
          );
          if (!result.failed) return;
          const detail = result.all ?? result.stdout;
          const fullLog = detail.match(/log: (\S+\/full\.log)/)?.[1];
          const fullText = fullLog ? await readFile(fullLog, "utf8").catch(() => "") : "";
          if (/timeout after \d+s|timed out|Exceeded timeout/i.test(`${detail}\n${fullText}`)) {
            if (attempt === 1) continue;
            throw new QueueTransientError(`prepare timed out twice; ${fullLog ?? log}`);
          }
          throw new Error(`Candidate prepare failed: ${detail.trim().slice(-1500)}; ${log}`);
        }
      };
      const requireClean = async (stage: string) => {
        const dirty = await run(
          "git",
          ["status", "--porcelain", "--untracked-files=all"],
          worktree,
        );
        if (dirty) throw new QueueEnvironmentError(`Dirty candidate ${stage}: ${dirty}; ${log}`);
      };
      const restorePublishedAssets = async () => {
        // Composer's filament:upgrade republishes vendor assets even on unchanged main.
        // Validate the exact committed candidate, preserving any PR's committed asset changes.
        // This restore is confined to generated Filament output in our disposable checkout.
        const paths = (await run("git", ["diff", "--name-only", "-z"], worktree))
          .split("\0")
          .filter((path) => /(?:^|\/)public\/(?:css|js|fonts)\/filament\//.test(path));
        if (paths.length) await run("git", ["restore", "--worktree", "--", ...paths], worktree);
      };
      try {
        await ensureClone(run);
        await run("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
        if ((await run("git", ["rev-parse", "origin/main"])) !== base)
          throw new Error("main changed before candidate construction");
        if (!existsSync(worktree)) {
          await run("git", ["worktree", "prune"]);
          await run("git", ["worktree", "add", "--detach", worktree, base]);
        }
        await run("git", ["reset", "--hard", base], worktree);
        await run("git", ["clean", "-fd"], worktree);
        await requireClean("before candidate construction");
        await run("mise", ["trust"], worktree);
        await prepare();
        baselinePrepared = true;
        await restorePublishedAssets();
        await requireClean("after plain main prepare");
        for (const entry of entries) {
          await run("git", ["fetch", "origin", `refs/pull/${entry.pr}/head`]);
          if ((await run("git", ["rev-parse", "FETCH_HEAD"])) !== entry.head)
            throw new Error("PR head changed before candidate construction");
          try {
            await run(
              "git",
              [
                "-c",
                "user.name=Merge Queue",
                "-c",
                "user.email=merge-queue@localhost",
                "-c",
                "commit.gpgsign=false",
                "merge",
                "--squash",
                "--no-commit",
                entry.head,
              ],
              worktree,
            );
          } catch {
            return { ok: false, log, conflict: entry.pr };
          }
          await run(
            "git",
            [
              "-c",
              "user.name=Merge Queue",
              "-c",
              "user.email=merge-queue@localhost",
              "commit",
              "--allow-empty",
              "--no-verify",
              "--no-gpg-sign",
              "-m",
              `Queue PR #${entry.pr}`,
            ],
            worktree,
          );
        }
        // Sign-off checks the exact committed candidate.
        checkingPr = true;
        if (!nightly) {
          await run("mise", ["trust"], worktree);
          await prepare();
          await restorePublishedAssets();
        }
        await requireClean("before verification");
        const candidateHead = await run("git", ["rev-parse", "HEAD"], worktree);

        // A batch checks only the areas it changes since `base`; the nightly run checks every area of plain main.
        // A sign-off without these flags checks the changes since origin/main, which the clone fetched as `base`.
        const checkScript = await readFile(join(worktree, "scripts/check.ts"), "utf8").catch(
          () => "",
        );
        const scope = nightly
          ? checkScript.includes('"--full"')
            ? ["--full"]
            : []
          : checkScript.includes('"--base"')
            ? ["--base", base]
            : [];
        const result = await candidateSignoff({
          ...signoffOptions,
          runLog: log,
          log: async (line) => {
            output += `${line}\n`;
            await writeFile(log, output, { mode: 0o600 });
          },
          requireClean: async () => {
            await requireClean("after sign-off");
            if ((await run("git", ["rev-parse", "HEAD"], worktree)) !== candidateHead)
              throw new QueueEnvironmentError(
                "Sign-off changed candidate HEAD; refusing to blame a PR",
              );
          },
          run: async (attempt) => {
            await requireClean("before sign-off attempt");
            if (checks?.length) {
              // Bisection: rerun only the checks the full batch failed, each as its own heavy step.
              let combined = "";
              for (const name of checks) {
                const check = await command(
                  "heavy-run",
                  ["--class", "checks", "--wait", "3600", "--", "mise", "run", name],
                  worktree,
                );
                const checkLog = `${log}.run-${attempt}-${name.replaceAll(":", "-")}.log`;
                await writeFile(checkLog, check.all ?? check.stdout, {
                  mode: 0o600,
                });
                if (check.failed) combined += `FAIL ${name} log=${checkLog}\n`;
              }
              return {
                ok: !combined,
                output: combined,
                log: `${log}.run-${attempt}.log`,
              };
            }
            if ((await run("git", ["rev-parse", "HEAD"], worktree)) !== candidateHead)
              throw new QueueEnvironmentError("Candidate HEAD changed before retry");
            const result = await command(
              "heavy-run",
              [
                "--class",
                "checks",
                "--wait",
                "3600",
                "--",
                "mise",
                "run",
                "signoff",
                "--",
                "--no-post",
                ...scope,
                ...(attempt === 2 ? ["--fresh"] : []),
              ],
              worktree,
            );
            const runLog = `${log}.run-${attempt}.log`;
            await writeFile(runLog, result.all ?? result.stdout, {
              mode: 0o600,
            });
            return {
              ok: !result.failed,
              output: result.all ?? result.stdout,
              log: runLog,
            };
          },
        });
        const failing = result.runs.map((run) =>
          [...new Set(run.failures.map((failure) => failure.name))].sort().join(" "),
        );
        if (
          result.ok ||
          nightly ||
          failing.length !== 2 ||
          !failing[0] ||
          failing[0] !== failing[1]
        )
          return { ...result, log };

        // The same checks failing twice on main too are main's breakage, not the batch's; land it.
        const names = failing[0].split(" ");
        for (const name of names.filter((name) => !brokenOnMain.has(`${base} ${name}`))) {
          await run("git", ["reset", "--hard", base], worktree);
          await run("git", ["clean", "-fd"], worktree);
          await prepare();
          await restorePublishedAssets();
          const onMain = await command(
            "heavy-run",
            ["--class", "checks", "--wait", "3600", "--", "mise", "run", name],
            worktree,
          );
          if (!onMain.failed) return { ...result, log };
          brokenOnMain.add(`${base} ${name}`);
        }
        output += `Landing: ${names.join(", ")} also fail on main ${base}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return { ...result, ok: true, log, brokenOnMain: names };
      } catch (error) {
        // Infrastructure errors must not falsely blame every PR during bisection.
        if (checkingPr && !(error instanceof QueueEnvironmentError)) {
          try {
            await requireClean("when sign-off failed");
          } catch (dirty) {
            error = dirty;
          }
        }
        output += `${String(error)}\n`;
        await writeFile(log, output, { mode: 0o600 });
        if (
          baselinePrepared &&
          checkingPr &&
          !(error instanceof QueueEnvironmentError) &&
          !/missing from PATH|command not found|ENOENT/.test(String(error))
        )
          return { ok: false, log };
        if (error instanceof QueueTransientError) throw error;
        throw new QueueEnvironmentError(`environment broken: ${String(error)}; ${log}`);
      }
    },
  };
  backend.nightly = (base) => backend.candidate([], base);
  return backend;
}
