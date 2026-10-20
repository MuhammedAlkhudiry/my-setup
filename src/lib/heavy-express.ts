import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HeavyHistoryEntry } from "./heavy-run";
import type { HeavyClass } from "./host-capacity";

export const EXPRESS_RUNS = 10;

/** Shared Git storage identifies a repository across linked worktrees and subdirectories. */
export function heavyProject(cwd: string): string | null {
  try {
    for (let root = realpathSync(cwd); ; root = dirname(root)) {
      const dot = join(root, ".git");
      try {
        let git = statSync(dot).isDirectory()
          ? dot
          : resolve(
              root,
              readFileSync(dot, "utf8")
                .trim()
                .replace(/^gitdir: /, ""),
            );
        try {
          git = resolve(git, readFileSync(join(git, "commondir"), "utf8").trim());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return realpathSync(git);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (dirname(root) === root) return null;
    }
  } catch {
    return null;
  }
}

/** Historical display commands are usable only for simple, untruncated argv. */
function sameCommand(run: HeavyHistoryEntry, argv: string[]): boolean {
  if (run.argv) return JSON.stringify(run.argv) === JSON.stringify(argv);
  return (
    run.command.length < 300 &&
    argv.every((arg) => /^[\w./:@=+-]+$/.test(arg)) &&
    run.command === argv.join(" ")
  );
}

export function expressHeavyCommand(
  history: HeavyHistoryEntry[],
  argv: string[],
  className: HeavyClass,
  project: string | null,
  before = Date.now(),
  resolveProject = heavyProject,
): boolean {
  if (className !== "checks" || !project) return false;
  const projects = new Map<string, string | null>();
  const runs = history
    .filter((run) => {
      if (
        run.class !== "checks" ||
        !run.acquiredAt ||
        run.reservationMode === "deferred" ||
        Date.parse(run.finishedAt) > before ||
        !Number.isFinite(run.ranSeconds) ||
        run.ranSeconds < 0 ||
        !sameCommand(run, argv)
      )
        return false;
      if (!projects.has(run.cwd)) projects.set(run.cwd, run.project ?? resolveProject(run.cwd));
      return projects.get(run.cwd) === project;
    })
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
    .slice(0, EXPRESS_RUNS);
  if (runs.length < EXPRESS_RUNS) return false;
  const times = runs.map((run) => run.ranSeconds).sort((a, b) => a - b);
  return (times[4] + times[5]) / 2 < 10 && times[8] < 30;
}

export function readHeavyHistory(path: string): HeavyHistoryEntry[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HeavyHistoryEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
