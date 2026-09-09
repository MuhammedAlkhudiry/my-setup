import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

interface MenuApp {
  directory: string;
  name: string;
  executable: string;
  needsShellEnvironment?: boolean;
  cacheDirectory?: string;
}

const MENU_APPS: MenuApp[] = [
  { directory: "lanes-menu", name: "Lanes", executable: "LanesMenu", needsShellEnvironment: true },
  { directory: "plans-menu", name: "Plans", executable: "PlansMenu", needsShellEnvironment: true },
  { directory: "ads-menu", name: "Ads", executable: "AdsMenu", cacheDirectory: "ads" },
  { directory: "ai-usage-menu", name: "AI Usage", executable: "AIUsageMenu" },
];

export async function installMenuApps(): Promise<void> {
  await Promise.all(MENU_APPS.map(installMenuApp));
}

async function installMenuApp(app: MenuApp): Promise<void> {
  const sourceRoot = join(import.meta.dir, "../apps", app.directory);
  const appName = app.name + ".app";
  const bundleId = "com.muhammed." + app.directory;
  const home = homedir();
  const appPath = join(home, "Applications", appName);
  const executablePath = join(appPath, "Contents", "MacOS", app.executable);
  const launchAgentPath = join(home, "Library", "LaunchAgents", `${bundleId}.plist`);

  await execa("swift", ["build", "-c", "release", "--package-path", sourceRoot], {
    stdio: "pipe",
  });
  const signingIdentity = await findAppleDevelopmentIdentity(app.name);

  const stagingRoot = await mkdtemp(join(tmpdir(), app.directory + "-"));
  const stagedApp = join(stagingRoot, appName);
  try {
    await mkdir(join(stagedApp, "Contents", "MacOS"), { recursive: true });
    await copyFile(
      join(sourceRoot, ".build", "release", app.executable),
      join(stagedApp, "Contents", "MacOS", app.executable),
    );
    await copyFile(join(sourceRoot, "Info.plist"), join(stagedApp, "Contents", "Info.plist"));
    await chmod(join(stagedApp, "Contents", "MacOS", app.executable), 0o755);
    await execa(
      "/usr/bin/codesign",
      ["--force", "--sign", signingIdentity, "--timestamp=none", stagedApp],
      { stdio: "pipe" },
    );

    await mkdir(join(home, "Applications"), { recursive: true });
    await rm(appPath, { recursive: true, force: true });
    await rename(stagedApp, appPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const launchAgent = createLaunchAgent(
    bundleId,
    executablePath,
    app.needsShellEnvironment ? home : undefined,
  );
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(launchAgentPath, launchAgent);

  if (app.cacheDirectory) {
    await rm(
      join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "my-setup", app.cacheDirectory),
      {
        recursive: true,
        force: true,
      },
    );
  }

  const userID = process.getuid?.();
  if (userID === undefined) {
    throw new Error(`The ${app.name} menu-bar app can only be installed on macOS.`);
  }
  const domain = `gui/${userID}`;
  await execa("/bin/launchctl", ["bootout", domain, launchAgentPath], {
    reject: false,
    stdio: "pipe",
  });
  await execa("/bin/launchctl", ["bootstrap", domain, launchAgentPath], { stdio: "pipe" });
}

async function findAppleDevelopmentIdentity(appName: string): Promise<string> {
  const { stdout } = await execa(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { stdio: "pipe" },
  );
  const identity = stdout.match(/^\s*\d+\)\s+([A-F0-9]{40})\s+"Apple Development:/m)?.[1];
  if (!identity) {
    throw new Error(
      `A valid Apple Development signing identity is required to install ${appName}.`,
    );
  }
  return identity;
}

function createLaunchAgent(bundleId: string, executablePath: string, home?: string): string {
  const environment = home ? createShellEnvironment(home) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${bundleId}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executablePath)}</string>
  </array>
  <key>ProcessType</key>
  <string>Interactive</string>
${environment}  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function createShellEnvironment(home: string): string {
  const executableSearchPath = [
    join(home, ".local/share/mise/installs/node/latest/bin"),
    join(home, ".bun/bin"),
    join(home, ".local/bin"),
    join(home, "bin"),
    join(home, "Library/Application Support/Herd/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(executableSearchPath)}</string>
  </dict>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
