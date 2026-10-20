import { execa, type Options } from "execa";

const liveGroups = new Set<number>();

type TimedCommandOptions = Pick<Options, "cwd" | "env" | "input" | "maxBuffer"> & {
  timeout: number;
  scheduleDeadline?: (expire: () => void, milliseconds: number) => () => void;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
};

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function cleanup(): void {
  for (const pid of liveGroups) {
    // Termination calls process.exit, which invokes cleanup again.
    liveGroups.delete(pid);
    killGroup(pid);
  }
}

function terminate(): void {
  cleanup();
  process.exit(143);
}

function interrupt(): void {
  cleanup();
  process.exit(130);
}

/** Bound the entire process group, including descendants keeping stdout/stderr open after their parent exits. */
export async function timedCommand(command: string, args: string[], options: TimedCommandOptions) {
  const {
    timeout,
    scheduleDeadline = (expire, milliseconds) => {
      const timer = setTimeout(expire, milliseconds);
      return () => clearTimeout(timer);
    },
    ...rest
  } = options;
  // A fast child can signal its parent during spawn, before execa returns.
  if (liveGroups.size === 0) {
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);
    process.once("exit", cleanup);
  }
  let pid: number | undefined;
  let stopDeadline: (() => void) | undefined;

  try {
    const child = execa(command, args, { ...rest, reject: false, detached: true, cleanup: false });
    pid = child.pid;
    if (pid === undefined) {
      const result = await child;
      return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
    liveGroups.add(pid);

    let timedOut = false;
    // Execa's timeout kills only the direct child, then can wait forever for inherited pipes.
    // Keep this timer and group registered until the pipes close, not just until the leader exits.
    const group = pid;
    stopDeadline = scheduleDeadline(() => {
      timedOut = true;
      killGroup(group);
    }, timeout);

    const result = await child;
    return {
      ...result,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut,
      failed: result.failed || timedOut,
      exitCode: timedOut ? 124 : result.exitCode,
    };
  } finally {
    stopDeadline?.();
    if (pid !== undefined) liveGroups.delete(pid);
    if (liveGroups.size === 0) {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("exit", cleanup);
    }
  }
}
