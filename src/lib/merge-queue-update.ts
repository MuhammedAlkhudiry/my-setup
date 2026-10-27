import { writeFile } from "node:fs/promises";

export type UpdateResult =
  | { status: "pushed"; head: string; log: string }
  | { status: "conflict"; files: string[]; log: string }
  /** The branch already contains main, so any conflict is with a sibling PR that has not landed yet. */
  | { status: "current"; log: string }
  /** The author pushed since the queue read the head; the next pass requeues the new head. */
  | { status: "moved"; log: string };

type Git = (args: string[]) => Promise<{ stdout: string; all?: string; failed?: boolean }>;

// Lockfiles keep Git's text merge: a syntax-aware merge can produce a valid file with a stale content hash.
const TEXT_MERGED = ["*.lock merge", "package-lock.json merge"];

/**
 * Merge origin/main into a PR branch and push it without force, so the author's commits stay as they are.
 * Git rerere replays recorded resolutions, and mergiraf, when given, resolves syntax-level conflicts.
 */
export async function mergeMainIntoBranch(options: {
  git: Git;
  branch: string;
  head: string;
  log: string;
  /** Mergiraf's file patterns and where to write them; omitted when mergiraf is not installed. */
  mergiraf?: { attributesFile: string; patterns: string };
}): Promise<UpdateResult> {
  const { git, branch, head, log } = options;
  const run = async (args: string[]) => {
    const result = await git(args);
    if (result.failed)
      throw new Error(
        `git ${args.slice(0, 2).join(" ")} failed: ${(result.all ?? result.stdout).trim().slice(-800)}; ${log}`,
      );
    return result.stdout.trim();
  };

  await run(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  await run(["fetch", "origin", `refs/heads/${branch}`]);
  if ((await run(["rev-parse", "FETCH_HEAD"])) !== head) return { status: "moved", log };
  await run(["checkout", "--force", "--detach", head]);
  await run(["clean", "-fdx"]);
  if (!(await git(["merge-base", "--is-ancestor", "origin/main", "HEAD"])).failed)
    return { status: "current", log };

  const config = [
    "user.name=Merge Queue",
    "user.email=merge-queue@localhost",
    "commit.gpgsign=false",
    "core.hooksPath=/dev/null",
    "rerere.enabled=true",
    "rerere.autoUpdate=true",
  ];
  if (options.mergiraf) {
    const { attributesFile, patterns } = options.mergiraf;
    await writeFile(attributesFile, `${patterns.trim()}\n${TEXT_MERGED.join("\n")}\n`);
    config.push(
      `core.attributesFile=${attributesFile}`,
      "merge.mergiraf.name=mergiraf",
      "merge.mergiraf.driver=mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L",
    );
  }
  const withConfig = (args: string[]) => [...config.flatMap((setting) => ["-c", setting]), ...args];
  const merged = await git(
    withConfig(["merge", "--no-ff", "-m", `Merge main into ${branch}`, "origin/main"]),
  );
  if (merged.failed) {
    const files = (await run(["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter(Boolean);
    if (files.length) {
      await run(["merge", "--abort"]);
      return { status: "conflict", files, log };
    }
    // rerere resolved every conflict and staged the result; anything else left no merge to finish.
    if ((await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).failed)
      throw new Error(
        `git merge failed: ${(merged.all ?? merged.stdout).trim().slice(-800)}; ${log}`,
      );
    await run(withConfig(["commit", "--no-edit"]));
  }

  const pushed = await git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (pushed.failed) {
    if (/\[rejected\]|non-fast-forward|fetch first/.test(pushed.all ?? ""))
      return { status: "moved", log };
    throw new Error(`git push failed: ${(pushed.all ?? pushed.stdout).trim().slice(-800)}; ${log}`);
  }
  return { status: "pushed", head: await run(["rev-parse", "HEAD"]), log };
}
