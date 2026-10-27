import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { MERGE_QUEUE_LABEL } from "./merge-queue";
import { workerShellArguments } from "./merge-queue-environment";

export async function installMergeQueue(options: {
  home: string;
  rootDir: string;
  bun: string;
}) {
  if (process.platform !== "darwin") return;
  const { home, rootDir, bun } = options;
  const directory = join(home, ".local/state/merge-queue");
  const agents = join(home, "Library/LaunchAgents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(agents, { recursive: true });
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const path = join(agents, `${MERGE_QUEUE_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${MERGE_QUEUE_LABEL}</string>
<key>ProgramArguments</key><array>${["/bin/zsh", ...workerShellArguments(rootDir, [bun, "--no-env-file", join(rootDir, "src/commands/merge-queue-cli.ts"), "run"])].map((argument) => `<string>${escape(argument)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string><key>PATH</key><string>${escape("/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${escape(join(directory, "worker.log"))}</string>
<key>StandardErrorPath</key><string>${escape(join(directory, "worker.log"))}</string>
</dict></plist>
`;
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== plist;
  const domain = `gui/${process.getuid?.()}`;
  const loaded =
    (
      await execa("launchctl", ["print", `${domain}/${MERGE_QUEUE_LABEL}`], {
        reject: false,
      })
    ).exitCode === 0;
  if (changed && loaded)
    await execa("launchctl", ["bootout", `${domain}/${MERGE_QUEUE_LABEL}`]);
  if (changed) await writeFile(path, plist);
  if (changed || !loaded) await execa("launchctl", ["bootstrap", domain, path]);
}
