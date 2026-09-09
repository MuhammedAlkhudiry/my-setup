import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { findSimulator } from "./simulator";

export interface ExpoDevelopmentClientOptions {
  port: string;
  scheme: string;
  simulatorName: string;
}

export function developmentClientUrl(scheme: string, port: string): string {
  const metroUrl = encodeURIComponent(`http://127.0.0.1:${port}`);
  return `${scheme}://expo-development-client/?url=${metroUrl}`;
}

export async function verifyExpoDevelopmentServer(
  port: string,
  options: {
    request?: (input: string) => Promise<Response>;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<void> {
  const statusUrl = `http://127.0.0.1:${port}/status`;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const request = options.request ?? fetch;

  while (Date.now() < deadline) {
    try {
      const response = await request(statusUrl);
      if (response.ok && (await response.text()) === "packager-status:running") return;
    } catch {
      // Metro is still starting.
    }
    await Bun.sleep(options.pollIntervalMs ?? 250);
  }

  throw new Error(`Metro did not become ready on port ${port}`);
}

export function openExpoDevelopmentClient(options: ExpoDevelopmentClientOptions): void {
  const state = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "-j", "devices"], {
      encoding: "utf8",
    }),
  ) as Parameters<typeof findSimulator>[0];
  const simulator = findSimulator(state, options.simulatorName);
  if (!simulator?.udid) throw new Error(`iOS simulator ${options.simulatorName} is missing`);

  if (simulator.state !== "Booted") {
    execFileSync("xcrun", ["simctl", "boot", simulator.udid], {
      stdio: "pipe",
    });
  }
  execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
  execFileSync(
    "xcrun",
    ["simctl", "openurl", simulator.udid, developmentClientUrl(options.scheme, options.port)],
    { stdio: "pipe" },
  );
  console.log(`Opened Metro ${options.port} on ${options.simulatorName}`);
}

export function verifyExpoDevelopmentClientFreshness(options: {
  mobileDirectory: string;
  simulatorName: string;
  bundleIdentifier: string;
}): void {
  const state = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "-j", "devices"], {
      encoding: "utf8",
    }),
  ) as Parameters<typeof findSimulator>[0];
  const simulator = findSimulator(state, options.simulatorName);
  if (!simulator?.udid) throw new Error(`iOS simulator ${options.simulatorName} is missing`);

  let applicationPath: string;
  try {
    applicationPath = execFileSync(
      "xcrun",
      ["simctl", "get_app_container", simulator.udid, options.bundleIdentifier, "app"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error(
      `Development client ${options.bundleIdentifier} is not installed on ${options.simulatorName}`,
    );
  }

  const installedAt = statSync(applicationPath).mtimeMs;
  const inputs = [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "app.json",
    "app.config.js",
    "app.config.ts",
    "ios/Podfile",
    "ios/Podfile.lock",
  ];
  const iosDirectory = join(options.mobileDirectory, "ios");
  if (existsSync(iosDirectory)) {
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (
          entry.isDirectory() &&
          !["Pods", "build", "DerivedData"].includes(entry.name) &&
          !entry.name.endsWith(".xcworkspace")
        ) {
          visit(path);
        } else if (entry.isFile() && entry.name === "project.pbxproj") {
          inputs.push(path.slice(options.mobileDirectory.length + 1));
        }
      }
    };
    visit(iosDirectory);
  }
  const staleInput = inputs
    .map((path) => ({ path, absolute: join(options.mobileDirectory, path) }))
    .filter(({ absolute }) => existsSync(absolute))
    .find(({ absolute }) => statSync(absolute).mtimeMs > installedAt);
  if (staleInput) {
    throw new Error(
      `Development client is older than ${staleInput.path}; rebuild and reinstall it on ${options.simulatorName}`,
    );
  }
}
