import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** A job's display title may change for every command; fairness uses session identity. */
export function heavyRequester(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  for (const key of [
    "T3_THREAD_ID",
    "T3CODE_THREAD_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "OPENCODE_SESSION_ID",
  ]) {
    if (env[key]?.trim()) return `${key}:${env[key]}`;
  }

  const directory = realpathSync(cwd);
  for (let root = directory; ; root = dirname(root)) {
    // .git is a file in linked worktrees. Do not collapse to the shared Git dir.
    if (existsSync(join(root, ".git"))) return `worktree:${root}`;
    if (dirname(root) === root) return `cwd:${directory}`;
  }
}
