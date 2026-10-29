// Transitional metadata dispatcher for clients that already loaded older code.
// A separate kernel flock makes startup idempotent and releases on crashes.
import { flock } from "../lib/flock";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { dispatchCompatibilityQueue } from "../lib/heavy-run-concurrent";

const [directory, legacyLockPath] = process.argv.slice(2);
if (!directory || !legacyLockPath) process.exit(2);
const fd = openSync(join(directory, "heavy-dispatcher.lock"), "a", 0o600);
try {
  if (flock(fd, 2 | 4) !== 0) process.exit(0);
  while (await dispatchCompatibilityQueue(directory, legacyLockPath)) await Bun.sleep(250);
} finally {
  flock(fd, 8);
  closeSync(fd);
}
