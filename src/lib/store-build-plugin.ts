import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "eas-cli-local-build-plugin";

// Follow the executable on this invocation's PATH, including global package-manager symlinks.
export function localBuildPluginVersion(easBinary: string): string {
  let directory = dirname(realpathSync(easBinary));

  while (true) {
    const metadata = join(directory, "package.json");

    if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).name === "eas-cli") {
      const local = join(directory, "build/build/local.js");
      const source = readFileSync(local, "utf8");
      const expression = source.match(/\bPLUGIN_PACKAGE_VERSION\s*=\s*([^;\n]+)/)?.[1]?.trim();
      let version = expression?.match(/^["']([^"']+)["']$/)?.[1];

      // Current EAS reads the exported version of its installed @expo/eas-build-job dependency.
      const binding = expression?.match(/^(\w+)\.version$/)?.[1];
      const imported =
        binding &&
        source.match(new RegExp(`\\b${binding}\\s*=\\s*require\\(["']@expo/eas-build-job["']\\)`));

      if (imported) {
        const require = createRequire(local);
        version = require("@expo/eas-build-job").version;
      }

      if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
        throw new Error(`Cannot determine the exact local build plugin version from ${local}.`);
      }

      return version;
    }

    const parent = dirname(directory);

    if (parent === directory) {
      throw new Error(`Cannot find the eas-cli package for ${easBinary}.`);
    }

    directory = parent;
  }
}

export function resolveLocalBuildPlugin(env: NodeJS.ProcessEnv): string {
  let binary = env.EAS_LOCAL_BUILD_PLUGIN_PATH;
  let expectedVersion: string | undefined;

  if (!binary) {
    const eas = Bun.which("eas", { PATH: env.PATH });

    if (!eas) {
      throw new Error("Cannot find eas on PATH.");
    }

    const version = localBuildPluginVersion(eas);
    expectedVersion = version;
    const cache = resolve(
      env.XDG_CACHE_HOME || join(homedir(), ".cache"),
      "my-setup",
      PACKAGE,
      version,
    );
    binary = join(cache, "node_modules/.bin", PACKAGE);
    const metadata = join(cache, "node_modules", PACKAGE, "package.json");
    const installed =
      existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).version === version;

    if (!installed || !existsSync(binary)) {
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "package.json"), JSON.stringify({ private: true }));
      console.log(`Installing ${PACKAGE}@${version} in ${cache}`);
      // npm runs lifecycle scripts just as npx would, but never reads the Expo project's Bun overrides.
      const install = spawnSync(
        "npm",
        [
          "install",
          "--prefix",
          cache,
          "--ignore-scripts=false",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          `${PACKAGE}@${version}`,
        ],
        { cwd: cache, env, stdio: "inherit" },
      );

      if (install.status !== 0) {
        throw new Error(
          `Could not install ${PACKAGE}@${version} in ${cache}: ${install.error?.message ?? `exit ${install.status}`}.`,
        );
      }
    }
  }

  // --help intentionally exits 1; --version loads the plugin without starting a build.
  const check = spawnSync(binary, ["--version"], { env, encoding: "utf8" });
  process.stdout.write(check.stdout ?? "");
  process.stderr.write(check.stderr ?? "");

  if (check.status !== 0) {
    throw new Error(
      `Local build plugin ${binary} failed --version: ${check.error?.message ?? `exit ${check.status}`}.`,
    );
  }

  if (expectedVersion && check.stdout?.trim() !== expectedVersion) {
    throw new Error(
      `Local build plugin ${binary} did not report expected version ${expectedVersion}.`,
    );
  }

  console.log(`Local build plugin verified: ${binary}`);

  return binary;
}
