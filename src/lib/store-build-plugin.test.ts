import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { localBuildPluginVersion, resolveLocalBuildPlugin } from "./store-build-plugin";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(path: string, content: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

function fixture(source = 'const PLUGIN_PACKAGE_VERSION = "1.2.3";') {
  const root = mkdtempSync(join(tmpdir(), "store-build-plugin-test-"));
  roots.push(root);
  const eas = join(root, "eas-cli/bin/run");
  file(join(root, "eas-cli/package.json"), JSON.stringify({ name: "eas-cli" }));
  file(join(root, "eas-cli/build/build/local.js"), source);
  file(eas, "#!/bin/sh\nexit 0\n", true);
  mkdirSync(join(root, "bin"));
  symlinkSync(eas, join(root, "bin/eas"));
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    XDG_CACHE_HOME: join(root, "cache"),
    EAS_LOCAL_BUILD_PLUGIN_PATH: "",
  };
  const cache = join(env.XDG_CACHE_HOME, "my-setup/eas-cli-local-build-plugin/1.2.3");
  const binary = join(cache, "node_modules/.bin/eas-cli-local-build-plugin");

  return { root, eas, env, cache, binary };
}

test("reads literal versions through the PATH symlink and fails closed on unknown EAS layouts", () => {
  const { root, eas } = fixture();
  expect(localBuildPluginVersion(join(root, "bin/eas"))).toBe("1.2.3");
  file(join(root, "eas-cli/build/build/local.js"), "const PLUGIN_PACKAGE_VERSION = unknown;");
  expect(() => localBuildPluginVersion(eas)).toThrow("Cannot determine the exact");
});

test("reads the installed build-job version EAS imports, rather than the CLI version", () => {
  const { root, eas } = fixture(
    'const job_1 = require("@expo/eas-build-job");\nconst PLUGIN_PACKAGE_VERSION = job_1.version;',
  );
  file(
    join(root, "eas-cli/node_modules/@expo/eas-build-job/package.json"),
    JSON.stringify({ name: "@expo/eas-build-job", version: "4.5.6", main: "index.js" }),
  );
  file(
    join(root, "eas-cli/node_modules/@expo/eas-build-job/index.js"),
    'exports.version = require("./package.json").version;',
  );
  expect(localBuildPluginVersion(eas)).toBe("4.5.6");
});

test("installs the exact plugin outside the project with scripts enabled and reuses the verified cache", () => {
  const { root, env, binary, cache } = fixture();
  file(
    join(root, "bin/npm"),
    `#!/bin/sh
printf '%s\\n' "$@" >> '${root}/npm-args'
pwd > '${root}/npm-cwd'
mkdir -p '${cache}/node_modules/.bin' '${cache}/node_modules/eas-cli-local-build-plugin'
printf '%s' '{"version":"1.2.3"}' > '${cache}/node_modules/eas-cli-local-build-plugin/package.json'
printf '%s\\n' '#!/bin/sh' 'test "$1" = "--version" || exit 1' 'echo 1.2.3' > '${binary}'
chmod +x '${binary}'
`,
    true,
  );
  expect(resolveLocalBuildPlugin(env)).toBe(binary);
  const args = readFileSync(join(root, "npm-args"), "utf8");
  expect(args).toContain("eas-cli-local-build-plugin@1.2.3\n");
  expect(args).toContain("--ignore-scripts=false\n");
  expect(readFileSync(join(root, "npm-cwd"), "utf8").trim()).toBe(realpathSync(cache));
  expect(resolveLocalBuildPlugin(env)).toBe(binary);
  expect(readFileSync(join(root, "npm-args"), "utf8")).toBe(args);
  file(binary, "#!/bin/sh\necho 9.9.9\n", true);
  expect(() => resolveLocalBuildPlugin(env)).toThrow("expected version 1.2.3");
  file(binary, "#!/bin/sh\nexit 7\n", true);
  expect(() => resolveLocalBuildPlugin(env)).toThrow("failed --version");
});

test("honors and verifies a caller override even without eas or npm installed", () => {
  const { root, env } = fixture();
  const override = join(root, "custom-plugin");
  file(override, '#!/bin/sh\ntest "$1" = "--version"\n', true);
  expect(resolveLocalBuildPlugin({ ...env, PATH: "", EAS_LOCAL_BUILD_PLUGIN_PATH: override })).toBe(
    override,
  );
  file(override, "#!/bin/sh\nexit 2\n", true);
  expect(() => resolveLocalBuildPlugin({ ...env, EAS_LOCAL_BUILD_PLUGIN_PATH: override })).toThrow(
    "failed --version",
  );
});

test("CLI dry run fails with a log path when the plugin cannot be installed, before build or submit", () => {
  const { root, env } = fixture();
  file(join(root, "bin/npm"), "#!/bin/sh\necho 'plugin installation denied' >&2\nexit 9\n", true);
  file(
    join(root, "eas-cli/bin/run"),
    `#!/bin/sh
case "$1" in
  env:list) exit 0 ;;
  *) echo "$@" >> '${root}/unexpected-eas'; exit 8 ;;
esac
`,
    true,
  );
  file(
    join(root, "app/eas.json"),
    JSON.stringify({ build: { production: {} }, submit: { production: {} } }),
  );
  file(join(root, "app/package.json"), JSON.stringify({ overrides: { "parent>child": "1" } }));
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dir, "../commands/store-build-cli.ts"),
      "android",
      "production",
      "--dry-run",
      "--json",
    ],
    {
      cwd: join(root, "app"),
      env: { ...env, ANDROID_HOME: root, MY_SETUP_OUTPUT_CHILD: "" },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  const receipt = JSON.parse(result.stdout);
  try {
    expect(receipt.status).toBe("failed");
    const log = readFileSync(receipt.log, "utf8");
    expect(log).toContain("plugin installation denied");
    expect(log).toContain("Could not install eas-cli-local-build-plugin@1.2.3");
    expect(existsSync(join(root, "unexpected-eas"))).toBe(false);
  } finally {
    if (receipt.log) rmSync(dirname(receipt.log), { recursive: true, force: true });
  }
});
