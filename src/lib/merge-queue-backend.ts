import { readSignoffHosts } from "./device";
import { dispatchSignoff, type SignoffRequest } from "./merge-queue-hosts";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { WORKER_TOOL_PROBE } from "./merge-queue-environment";
import { candidateSignoff, parseSignoffReceipt, type signoffPolicy } from "./merge-queue-signoff";
import { mergeMainIntoBranch } from "./merge-queue-update";
import {
  mergeQueueDirectory,
  QueueEnvironmentError,
  QueueTransientError,
  type CandidateRun,
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
    input?: string;
    timeout?: number;
    env?: Record<string, string>;
  },
) => Promise<{ stdout: string; all?: string; failed?: boolean }>;
export function githubBackend(
  repo: string,
  execute: CommandRunner = execa,
  signoffOptions: {
    hosts?: string[] | null;
    preparedCandidate?: Pick<SignoffRequest, "sha" | "bundle">;
    policy?: ReturnType<typeof signoffPolicy>;
    admission?: Parameters<typeof candidateSignoff>[0]["admission"];
    readLog?: (path: string) => Promise<string>;
  } = {},
): QueueBackend {
  const gh = async (args: string[]) => (await execute("gh", args, { timeout: 60_000 })).stdout;
  const project = projectForRepo(repo);
  const slug = repo.replaceAll("/", "-");
  // Checks confirmed failing on a main SHA, so bisection does not rerun them for every half.
  const brokenOnMain = new Set<string>();
  // State lives outside managed project worktree roots, so the resource keeper leaves it alone.
  const root = join(mergeQueueDirectory(), "candidates", slug.toLowerCase());
  const clone = join(root, "repo");
  const worktree = join(root, "candidate");
  const updateWorktree = join(root, "update");
  const unprepared = join(root, "unprepared");
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
  // A directory in the canonical clone's Git dir, which its task worktrees share, linked into the candidate clone.
  const linkCanonical = async (
    name: string,
    run: (name: string, args: string[], cwd?: string) => Promise<string>,
    replaceLocal = false,
  ) => {
    const path = join(clone, ".git", name);
    const local = await lstat(path).catch(() => undefined);
    if (local?.isSymbolicLink() || (local && !replaceLocal)) return;

    const common = await run("git", [
      "-C",
      project.canonicalRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    await mkdir(join(common, name), { recursive: true });
    if (local) await rm(path, { recursive: true, force: true });
    await symlink(join(common, name), path);
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
  };
  const signedSha = async (sha: string) => {
    const status = JSON.parse(await gh(["api", `repos/${repo}/commits/${sha}/status`]));
    return status.statuses.some(
      (item: { context: string; state: string }) =>
        item.context === "signoff" && item.state === "success",
    );
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
    signed: (entry) => signedSha(entry.head),
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
      await linkCanonical("rr-cache", run);
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
        // Tree equality reuses local prepare only; a remote sign-off never prepared this worktree.
        const prepared =
          !existsSync(unprepared) &&
          (await step("git", ["rev-parse", "HEAD^{tree}"])) ===
            (await step("git", ["rev-parse", `${sha}^{tree}`]));
        await step("git", ["reset", "--hard", sha]);
        await step("git", ["clean", "-fd"]);
        await step("mise", ["trust"]);
        if (!prepared) await step("mise", ["run", "prepare"], 3_900_000);
        await rm(unprepared, { force: true });
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
        const deployed = last.match(/^deployed ([0-9a-f]{40})(?:;.*)?$/)?.[1];
        const skipped = last.match(/^skipped (.+)$/)?.[1];
        if (!deployed && !skipped) throw new Error(`Deploy printed no result line: ${last}`);
        return { ok: true, log, deployedSha: deployed, skipped };
      } catch (error) {
        output += `${String(error)}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return { ok: false, log, error: String(error) };
      }
    },
    candidate: async (entries, base, checks, options) => {
      // No entries: the sign-off of plain main, of every area or, with `since`, of the areas changed since that trusted main.
      // `full` signs off every area of a PR candidate; `since` the areas changed since a trusted main, while main is held.
      const nightly = !entries.length;
      let since = options?.since;
      let full = !since && (nightly || Boolean(options?.full));
      let areas = options?.areas;
      await recover();
      await mkdir(root, { recursive: true, mode: 0o700 });
      const log = await logPath();
      let output = "";
      let baselinePrepared = false;
      let checkingPr = false;
      let releaseHost: (() => void) | undefined;
      const command = async (command: string, args: string[], cwd = clone) => {
        output += `$ ${command} ${args.join(" ")}\n`;
        await writeFile(log, output, { mode: 0o600 });
        const result = await execute(command, args, {
          cwd,
          reject: false,
          all: true,
          // `verify` tags the nightly full sign-off's run, so its history can be read apart from PR sign-offs.
          env: {
            GIT_TERMINAL_PROMPT: "0",
            ...(nightly && full ? { VERIFY_RUN_TAG: "nightly" } : {}),
          },
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
          const result = await command("mise", ["run", "prepare"], worktree);
          if (!result.failed) return;
          const detail = result.all ?? result.stdout;
          if (/timeout after \d+s|timed out|Exceeded timeout/i.test(detail)) {
            if (attempt === 1) continue;
            throw new QueueTransientError(`prepare timed out twice; ${log}`);
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
      const queueGit = ["-c", "user.name=Merge Queue", "-c", "user.email=merge-queue@localhost"];
      // Squash-merges each entry onto the worktree's HEAD, in order; resolves to the PR that conflicts, if any.
      const construct = async () => {
        if (signoffOptions.preparedCandidate) {
          await run("git", ["reset", "--hard", signoffOptions.preparedCandidate.sha], worktree);
          return;
        }
        for (const entry of entries) {
          await run("git", ["fetch", "origin", `refs/pull/${entry.pr}/head`]);
          if ((await run("git", ["rev-parse", "FETCH_HEAD"])) !== entry.head)
            throw new Error("PR head changed before candidate construction");
          try {
            await run(
              "git",
              [
                ...queueGit,
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
            return entry.pr;
          }
          await run(
            "git",
            [
              ...queueGit,
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
      };
      // Docs only: the project's areas.sh selects no area for the batch's paths beyond what it selects for a lone doc.
      const docsOnlyChange = async (base: string) => {
        const script = join(worktree, "scripts/areas.sh");
        if (!existsSync(script)) return false;
        const paths = (
          await run("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], worktree)
        )
          .split("\n")
          .filter(Boolean);
        if (!paths.length) return false;
        const areas = async (input: string[]) => {
          const result = await execute(script, [], {
            cwd: worktree,
            reject: false,
            input: input.join("\n"),
          });
          if (result.failed) return undefined;
          return result.stdout.split("\n").filter((line) => line.endsWith("=true"));
        };
        const [batch, docs] = await Promise.all([areas(paths), areas(["docs/index.md"])]);
        return Boolean(batch && docs && batch.every((area) => docs.includes(area)));
      };
      // The signed PR head, if any, whose tree equals the constructed candidate's.
      const signedTree = async () => {
        const tree = await run("git", ["rev-parse", "HEAD^{tree}"], worktree);
        for (const sha of new Set(
          entries.flatMap((entry) => [entry.head, entry.signedHead ?? entry.head]),
        ))
          if ((await run("git", ["rev-parse", `${sha}^{tree}`])) === tree && (await signedSha(sha)))
            return sha;
      };
      // The areas some PR and the rest of the candidate both changed since that PR's signed base, from the project's own
      // areas.sh. Every other area matches a tree that a PR's sign-off or a trusted main's already checked; areas.sh
      // selects an area for every path its checks read. Undefined when the project cannot narrow its sign-off this way.
      const overlapAreas = async () => {
        const script = join(worktree, "scripts/areas.sh");
        const checkScript = await readFile(join(worktree, "scripts/check.ts"), "utf8").catch(
          () => "",
        );
        if (!existsSync(script) || !checkScript.includes('"--areas"')) return;

        const areasOf = async (from: string, to: string) => {
          const paths = await run("git", ["diff", "--name-only", "--no-renames", from, to]);
          if (!paths) return new Set<string>();
          const result = await execute(script, [], { cwd: worktree, reject: false, input: paths });
          if (result.failed) throw new Error("areas.sh failed");
          return new Set(
            result.stdout
              .split("\n")
              .filter((line) => line.endsWith("=true"))
              .map((line) => line.slice(0, line.indexOf("="))),
          );
        };
        const sides: { pr: Set<string>; main: Set<string> }[] = [];
        for (const entry of entries) {
          const signed = entry.signedHead ?? entry.head;
          const signedBase = await run("git", ["merge-base", signed, base]);
          sides.push({
            pr: await areasOf(signedBase, signed),
            main: await areasOf(signedBase, base),
          });
        }

        const overlap = new Set<string>();
        sides.forEach((side, index) => {
          const others = new Set([
            ...side.main,
            ...sides.flatMap((other, at) => (at === index ? [] : [...other.pr])),
          ]);
          for (const area of side.pr) if (others.has(area)) overlap.add(area);
        });
        return [...overlap].sort();
      };
      try {
        await ensureClone(run);
        // Share the check passes task worktrees remember, keyed on tree and base, so identical code is not checked twice.
        await linkCanonical("check-stamps", run, true).catch(
          (error) => (output += `check stamps not shared: ${String(error)}\n`),
        );
        if (signoffOptions.preparedCandidate) {
          const present = await command("git", ["cat-file", "-e", `${base}^{commit}`]);
          if (present.failed) await run("git", ["fetch", "origin", base]);
          if (signoffOptions.preparedCandidate.sha !== base) {
            await run("git", [
              "fetch",
              signoffOptions.preparedCandidate.bundle,
              "refs/heads/merge-queue-transfer",
            ]);
            if (
              (await run("git", ["rev-parse", "FETCH_HEAD"])) !==
              signoffOptions.preparedCandidate.sha
            )
              throw new QueueEnvironmentError("Transferred candidate SHA mismatch");
          }
          await run("git", ["update-ref", "refs/remotes/origin/main", base]);
        } else await run("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
        if ((await run("git", ["rev-parse", "origin/main"])) !== base)
          throw new Error("main changed before candidate construction");
        if (since && (await command("git", ["merge-base", "--is-ancestor", since, base])).failed) {
          output += `trusted main ${since} is not an ancestor of ${base}; signing off every area\n`;
          since = undefined;
          full = true;
        }
        if (!existsSync(worktree)) {
          await run("git", ["worktree", "prune"]);
          await run("git", ["worktree", "add", "--detach", worktree, base]);
        }
        await run("git", ["reset", "--hard", base], worktree);
        await run("git", ["clean", "-fd"], worktree);
        await requireClean("before candidate construction");
        // A candidate whose tree equals a signed PR head's was already signed off as is: `mise run signoff` merges main
        // in first, so a lone PR on unchanged main usually matches. Trees, not SHAs: the queue's squash commit differs.
        // Otherwise, on a trusted main, only areas both a PR and the rest of the candidate changed need checking again.
        if (options?.reuse && !full) {
          let reused: string | undefined;
          if ((await construct()) === undefined) {
            reused = await signedTree();
            if (!reused && !checks?.length && !areas)
              areas = await overlapAreas().catch((error) => {
                output += `area overlap unknown, signing off every changed area: ${String(error)}\n`;
                return undefined;
              });
          }
          await run("git", ["reset", "--hard", base], worktree);
          await run("git", ["clean", "-fd"], worktree);
          if (reused) {
            output += `sign-off reused: candidate tree matches signed ${reused}\n`;
            await writeFile(log, output, { mode: 0o600 });
            return { ok: true, log, reusedFrom: reused };
          }
          if (areas && !areas.length) {
            output +=
              "sign-off reused: no area changed by both a PR and the rest of the candidate since its signed base\n";
            await writeFile(log, output, { mode: 0o600 });
            return { ok: true, log, areas };
          }
          if (areas)
            output += `sign-off narrowed to areas changed on both sides: ${areas.join(", ")}\n`;
        }
        const hosts =
          signoffOptions.hosts === null || signoffOptions.preparedCandidate
            ? undefined
            : (signoffOptions.hosts ?? readSignoffHosts(homedir()));
        if (hosts?.length) {
          await writeFile(unprepared, "Remote sign-off requires local prepare before deploy\n");
          const conflict = await construct();
          if (conflict !== undefined) return { ok: false, log, conflict };
          const sha = await run("git", ["rev-parse", "HEAD"], worktree);
          const bundle = join(root, "transfer.bundle");
          const result = await dispatchSignoff({
            hosts,
            execute,
            log,
            reserveLocal: (release) => {
              releaseHost = release;
            },
            request: async () => {
              if (sha !== base) {
                await run("git", ["update-ref", "refs/heads/merge-queue-transfer", sha]);
                await run("git", [
                  "bundle",
                  "create",
                  bundle,
                  `${base}..refs/heads/merge-queue-transfer`,
                ]);
              }
              return {
                repo,
                base,
                sha,
                bundle: sha === base ? "" : (await readFile(bundle)).toString("base64"),
                entries,
                checks,
                full,
                ...(since ? { since } : {}),
                ...(areas ? { areas } : {}),
              };
            },
          }).finally(() => rm(bundle, { force: true }));
          if (result) return { ...result, ...(areas ? { areas } : {}) };
          await run("git", ["reset", "--hard", base], worktree);
          await run("git", ["clean", "-fd"], worktree);
        }
        const conflict = await construct();
        if (conflict !== undefined) return { ok: false, log, conflict };
        // One prepare, of the exact committed candidate that sign-off checks.
        await run("mise", ["trust"], worktree);
        try {
          await prepare();
        } catch (error) {
          // A candidate that fails to prepare is its PRs' failure only when plain main prepares.
          if (nightly || error instanceof QueueEnvironmentError) throw error;
          await run("git", ["reset", "--hard", base], worktree);
          await run("git", ["clean", "-fd"], worktree);
          await run("mise", ["trust"], worktree);
          await prepare();
          await restorePublishedAssets();
          await requireClean("after plain main prepare");
          baselinePrepared = true;
          checkingPr = true;
          throw error;
        }
        baselinePrepared = true;
        checkingPr = true;
        await restorePublishedAssets();
        await requireClean("before verification");
        await rm(unprepared, { force: true });
        const candidateHead = await run("git", ["rev-parse", "HEAD"], worktree);

        // A batch checks only the areas it changes since `base`; a full run checks every area.
        // A sign-off without these flags checks the changes since origin/main, which the clone fetched as `base`.
        const checkScript = await readFile(join(worktree, "scripts/check.ts"), "utf8").catch(
          () => "",
        );
        const supports = (flag: string) => checkScript.includes(`"${flag}"`);
        const scope =
          full || (since && !supports("--base"))
            ? supports("--full")
              ? ["--full"]
              : []
            : areas?.length && supports("--areas")
              ? ["--areas", areas.join(",")]
              : supports("--base")
                ? ["--base", since ?? base]
                : [];
        const receipts = supports("--json");
        const docsOnly = !full && (await docsOnlyChange(since ?? base));
        if (docsOnly) output += "docs-only batch: sign-off starts without the load wait\n";
        const result = await candidateSignoff({
          ...signoffOptions,
          docsOnly,
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
              // Bisection: rerun only the checks the full batch failed, each on its own.
              let combined = "";
              const timed: NonNullable<CandidateRun["checks"]> = [];
              for (const name of checks) {
                const started = performance.now();
                const check = await command("mise", ["run", name], worktree);
                timed.push({
                  name,
                  status: check.failed ? "failed" : "passed",
                  seconds: Math.round((performance.now() - started) / 100) / 10,
                  reused: false,
                });
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
                checks: timed,
              };
            }
            if ((await run("git", ["rev-parse", "HEAD"], worktree)) !== candidateHead)
              throw new QueueEnvironmentError("Candidate HEAD changed before retry");
            const result = await command(
              "mise",
              [
                "run",
                "signoff",
                "--",
                "--no-post",
                ...scope,
                ...(receipts ? ["--json"] : []),
                // The retry reuses the passes the first run remembered for this exact code, so it reruns only what failed.
              ],
              worktree,
            );
            const runLog = `${log}.run-${attempt}.log`;
            const text = result.all ?? result.stdout;
            await writeFile(runLog, text, { mode: 0o600 });
            const parsed = receipts ? parseSignoffReceipt(result.stdout) : undefined;
            if (!parsed) return { ok: !result.failed, output: text, log: runLog };

            const receipt = `${log}.run-${attempt}.receipt.json`;
            await writeFile(receipt, `${parsed.receipt}\n`, { mode: 0o600 });
            return {
              ok: !result.failed,
              // The receipt replaces the FAIL lines; diagnostics read them back from it.
              output: `${text}\n${parsed.failures}`,
              log: runLog,
              receipt,
              checks: parsed.checks.map(({ task, status, seconds, reused }) => ({
                name: task,
                status,
                seconds: Math.round(seconds * 10) / 10,
                reused,
              })),
            };
          },
        });
        if (hosts?.length) for (const run of result.runs) run.host = "main-mac";
        const failing = result.runs.map((run) =>
          [...new Set(run.failures.map((failure) => failure.name))].sort().join(" "),
        );
        const narrowed = areas ? { areas } : {};
        // A main sign-off, or a candidate on a held main, must pass on its own; main's breakage is no excuse.
        if (
          result.ok ||
          full ||
          nightly ||
          options?.since ||
          failing.length !== 2 ||
          !failing[0] ||
          failing[0] !== failing[1]
        )
          return { ...result, log, ...narrowed };

        // The same checks failing twice on main too are main's breakage, not the batch's; land it.
        const names = failing[0].split(" ");
        for (const name of names.filter((name) => !brokenOnMain.has(`${base} ${name}`))) {
          await run("git", ["reset", "--hard", base], worktree);
          await run("git", ["clean", "-fd"], worktree);
          await prepare();
          await restorePublishedAssets();
          const onMain = await command("mise", ["run", name], worktree);
          if (!onMain.failed) return { ...result, log, ...narrowed };
          brokenOnMain.add(`${base} ${name}`);
        }
        output += `Landing: ${names.join(", ")} also fail on main ${base}\n`;
        await writeFile(log, output, { mode: 0o600 });
        return { ...result, ok: true, log, brokenOnMain: names, ...narrowed };
      } catch (error) {
        // Infrastructure errors must not falsely blame every PR during bisection.
        if (signoffOptions.preparedCandidate && error instanceof QueueTransientError) throw error;
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
      } finally {
        releaseHost?.();
      }
    },
  };
  backend.nightly = (base, options) => backend.candidate([], base, undefined, options);
  return backend;
}
