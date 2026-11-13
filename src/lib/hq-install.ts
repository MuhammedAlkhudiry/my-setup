import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installAgent } from "./merge-queue-install";

export const HQ_DELIVER_LABEL = "com.muhammed.hq-deliver";

/** main-mac sends each pick on a thread's hq question back to that thread (`hq deliver`), every half minute. */
export async function installHqDeliver(options: { home: string; rootDir: string; bun: string }) {
  if (process.platform !== "darwin") return;
  const { home, rootDir, bun } = options;
  const directory = join(home, ".local/state/hq");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await installAgent(
    home,
    rootDir,
    HQ_DELIVER_LABEL,
    [bun, "--no-env-file", join(rootDir, "src/commands/hq-cli.ts"), "deliver"],
    {
      trigger: "<key>StartInterval</key><integer>30</integer><key>RunAtLoad</key><true/>",
      log: join(directory, "deliver.log"),
    },
  );
}
