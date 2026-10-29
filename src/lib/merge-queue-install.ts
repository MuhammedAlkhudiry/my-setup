import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { MERGE_QUEUE_LABEL } from "./merge-queue";
import { workerShellArguments } from "./merge-queue-environment";
import { MERGE_QUEUE_INBOX_LABEL } from "./merge-queue-forward";

export async function installMergeQueue(options: { home: string; rootDir: string; bun: string }) {
  if (process.platform !== "darwin") return;
  const { home, rootDir, bun } = options;
  const directory = join(home, ".local/state/merge-queue");
  const requests = join(directory, "requests");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });
  const cli = [bun, "--no-env-file", join(rootDir, "src/commands/merge-queue-cli.ts")];
  await installAgent(home, rootDir, MERGE_QUEUE_LABEL, [...cli, "run"], {
    trigger: "<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>",
    log: join(directory, "worker.log"),
  });
  // Spare Macs' `merge-queue add` lands here: this GUI session holds GitHub's keychain sign-in, which SSH sessions cannot read.
  await installAgent(home, rootDir, MERGE_QUEUE_INBOX_LABEL, [...cli, "process-requests"], {
    trigger: `<key>WatchPaths</key><array><string>${escape(requests)}</string></array><key>RunAtLoad</key><true/>`,
    log: join(directory, "inbox.log"),
  });
}

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function installAgent(
  home: string,
  rootDir: string,
  label: string,
  command: string[],
  options: { trigger: string; log: string },
) {
  const path = join(home, "Library/LaunchAgents", `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${["/bin/zsh", ...workerShellArguments(rootDir, command)].map((argument) => `<string>${escape(argument)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string><key>PATH</key><string>${escape("/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
${options.trigger}
<key>StandardOutPath</key><string>${escape(options.log)}</string>
<key>StandardErrorPath</key><string>${escape(options.log)}</string>
</dict></plist>
`;
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== plist;
  const domain = `gui/${process.getuid?.()}`;
  const loaded =
    (await execa("launchctl", ["print", `${domain}/${label}`], { reject: false })).exitCode === 0;
  if (changed && loaded) await execa("launchctl", ["bootout", `${domain}/${label}`]);
  if (changed) await writeFile(path, plist);
  if (changed || !loaded) await execa("launchctl", ["bootstrap", domain, path]);
}

/** Spare Macs forward to main-mac's queue, so they stop and remove any worker an earlier install loaded. */
export async function uninstallMergeQueue(home: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  let removed = false;
  for (const label of [MERGE_QUEUE_LABEL, MERGE_QUEUE_INBOX_LABEL]) {
    const path = join(home, "Library/LaunchAgents", `${label}.plist`);
    const service = `gui/${process.getuid?.()}/${label}`;
    const loaded = (await execa("launchctl", ["print", service], { reject: false })).exitCode === 0;
    if (loaded) await execa("launchctl", ["bootout", service]);
    if (!loaded && !existsSync(path)) continue;
    await rm(path, { force: true });
    removed = true;
  }
  return removed;
}
