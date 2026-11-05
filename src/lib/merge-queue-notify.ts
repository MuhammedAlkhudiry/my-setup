// main-mac's worker messages the thread that owns a PR about its failures and merges, so that thread fixes or checks its own
// change, and the Housekeeper about batch events: deploys, a broken queue, and owners it could not reach. Spare Macs run no
// worker, so only main-mac sends; it reaches threads on spare Macs over SSH.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** The thread that owns a PR, and the spare Mac it runs on; unset host means main-mac. */
export interface QueueOwner {
  thread?: string;
  host?: string;
}

/** shell/t3-inbox.zsh reads the same file. */
export const housekeeperThread = (rootDir: string) =>
  readFileSync(join(rootDir, "config/housekeeper-thread.txt"), "utf8").trim();

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Sends to the owning thread when there is one, else to the Housekeeper, which also gets anything its owner could not receive. */
export function queueNotifier(rootDir: string, home = homedir()) {
  const t3 = join(home, ".t3/bin/t3");
  const send = (thread: string, message: string, host?: string) =>
    host
      ? execa("ssh", [host, `~/.t3/bin/t3 thread send ${quote(thread)} -`], { input: message, timeout: 30_000 })
      : execa(t3, ["thread", "send", thread, "-"], { input: message, timeout: 30_000 });

  return async (message: string, owner?: QueueOwner) => {
    const housekeeper = housekeeperThread(rootDir);
    if (!owner?.thread || owner.thread === housekeeper) {
      await send(housekeeper, message);
      return;
    }

    try {
      await send(owner.thread, message, owner.host);
    } catch (error) {
      const reason = shorten(error instanceof Error ? error.message : String(error), 200);
      await send(
        housekeeper,
        `${message}\n(Not delivered to owning thread ${owner.thread} on ${owner.host ?? "main-mac"}: ${reason}. Relaunch or take over the PR.)`,
      );
    }
  };
}

/** Keeps both ends of a long reason: errors usually end with their log path. */
export function shorten(text: string, max = 600) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const half = Math.floor((max - 5) / 2);
  return `${flat.slice(0, half)} ... ${flat.slice(-half)}`;
}
