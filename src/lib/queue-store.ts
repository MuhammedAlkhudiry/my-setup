import { dlopen } from "bun:ffi";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { emptyQueueState, type QueueState } from "./device-queue";

// Both queues retain the existing device-queue state file. The kernel releases the
// short transaction lock on crashes; a slow live writer is never evicted by age.
const {
  symbols: { flock },
} = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
});

export const queueDirectory = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "device-queue");

export function readQueueState(directory = queueDirectory()): QueueState {
  try {
    return {
      ...emptyQueueState(),
      ...JSON.parse(readFileSync(join(directory, "state.json"), "utf8")),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyQueueState();
  }
}

export async function withQueueState<T>(
  fn: (state: QueueState) => T & (T extends PromiseLike<unknown> ? never : unknown),
  directory = queueDirectory(),
): Promise<T> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, "state.lock"), "a", 0o600);
  const path = join(directory, "state.json");
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    while (flock(fd, 2 | 4) !== 0) {
      // Contention is not a failed command. Keep the ticket and retry, including
      // while an older process still holds the lock across asynchronous work.
      await Bun.sleep(10 + Math.floor(Math.random() * 40));
    }

    const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    const state: QueueState = previous
      ? { ...emptyQueueState(), ...JSON.parse(previous) }
      : emptyQueueState();
    const result = fn(state);
    if (result && typeof (result as unknown as { then?: unknown }).then === "function")
      throw new Error("Queue transactions must be synchronous");

    const next = JSON.stringify(state, null, 2);
    if (next !== previous) {
      writeFileSync(temporary, next, { mode: 0o600 });
      renameSync(temporary, path);
    }
    return result;
  } finally {
    rmSync(temporary, { force: true });
    flock(fd, 8);
    closeSync(fd);
  }
}
