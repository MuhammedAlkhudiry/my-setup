// main-mac's worker messages the thread that owns a PR about its failures and merges, so that thread fixes or checks its own
// change, and the Ops keeper about batch events: deploys, a broken queue, and owners it could not reach. Spare Macs run no
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

export type Keeper = "housekeeper" | "ops" | "business";

/**
 * A keeper's T3 thread on main-mac from config/keeper-threads.json; a missing or empty key falls back to the Housekeeper,
 * the front desk. shell/t3-inbox.zsh reads the same file's `housekeeper` key.
 */
export function keeperThread(rootDir: string, keeper: Keeper) {
  const threads = JSON.parse(
    readFileSync(join(rootDir, "config/keeper-threads.json"), "utf8"),
  ) as Partial<Record<Keeper, string>>;
  const frontDesk = threads.housekeeper?.trim();
  if (!frontDesk) throw new Error("config/keeper-threads.json has no housekeeper thread");

  return threads[keeper]?.trim() || frontDesk;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Sends to the owning thread when there is one, else to the Ops keeper, which also gets anything its owner could not receive. */
export function queueNotifier(rootDir: string, home = homedir()) {
  const t3 = join(home, ".t3/bin/t3");
  const send = (thread: string, message: string, host?: string) =>
    host
      ? execa("ssh", [host, `~/.t3/bin/t3 thread send ${quote(thread)} -`], {
          input: message,
          timeout: 30_000,
        })
      : execa(t3, ["thread", "send", thread, "-"], { input: message, timeout: 30_000 });

  // Threads launched over MCP carry an `mcp:` prefix that `merge-queue add --thread` callers often drop; t3 names the
  // full id it meant, so retry once with it.
  const sendResolving = async (thread: string, message: string, host?: string) => {
    try {
      await send(thread, message, host);
    } catch (error) {
      const meant = /Did you mean `([^`]+)`\?/.exec(error instanceof Error ? error.message : "")?.[1];
      if (!meant) throw error;
      await send(meant, message, host);
    }
  };

  return async (message: string, owner?: QueueOwner) => {
    const ops = keeperThread(rootDir, "ops");
    if (!owner?.thread || owner.thread === ops) {
      await send(ops, message);
      return;
    }

    try {
      await sendResolving(owner.thread, message, owner.host);
    } catch (error) {
      const reason = shorten(error instanceof Error ? error.message : String(error), 200);
      await send(
        ops,
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
