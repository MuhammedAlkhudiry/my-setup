// main-mac's worker messages the Housekeeper thread about events that need action, so a broken queue or a failed PR
// wakes it instead of waiting for its next pass. Spare Macs run no worker, so only main-mac sends.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** shell/t3-inbox.zsh reads the same file. */
export const housekeeperThread = (rootDir: string) =>
  readFileSync(join(rootDir, "config/housekeeper-thread.txt"), "utf8").trim();

export function housekeeperNotifier(rootDir: string, home = homedir()) {
  return async (message: string) => {
    await execa(join(home, ".t3/bin/t3"), ["thread", "send", housekeeperThread(rootDir), "-"], {
      input: message,
      timeout: 30_000,
    });
  };
}

/** Keeps both ends of a long reason: errors usually end with their log path. */
export function shorten(text: string, max = 600) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const half = Math.floor((max - 5) / 2);
  return `${flat.slice(0, half)} ... ${flat.slice(-half)}`;
}
