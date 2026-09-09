#!/usr/bin/env zsh

set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH."
  exit 1
fi

exec bun run - "$@" <<'EOF'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const REGISTRY_BASE = "https://registry.npmjs.org";
const STATIC_PACKAGE = "@hugeicons/static";
const CORE_PACKAGE = "@hugeicons/core-free-icons";
const CACHE_ROOT = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache"), "hugeicons");
const CURRENT_LINK = join(CACHE_ROOT, "current");

function iconsDir(): string {
  return join(CURRENT_LINK, "icons");
}

function exportsFile(): string {
  return join(CURRENT_LINK, "exports.txt");
}

function versionFile(): string {
  return join(CURRENT_LINK, "version.txt");
}

async function hasCompleteCache(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "icons"))) &&
    (await pathExists(join(root, "exports.txt"))) &&
    (await pathExists(join(root, "ready.txt")))
  );
}

type CacheManifest = {
  staticVersion: string;
  coreVersion: string;
  staticIntegrity?: string;
  coreIntegrity?: string;
};

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function usage(exitCode = 0): never {
  const text = [
    "Usage:",
    "  hugeicons search <query>",
    "  hugeicons path <icon-name>",
    "  hugeicons svg <icon-name> [--out <file>]",
    "  hugeicons usage <platform> <icon-name>",
    "  hugeicons list",
    "",
    "Platforms: react, react-native, vue, svelte, angular, flutter, html",
  ].join("\n");
  if (exitCode === 0) {
    console.log(text);
  } else {
    console.error(text);
  }
  process.exit(exitCode);
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

function toRegistryUrl(packageName: string): string {
  return `${REGISTRY_BASE}/${encodeURIComponent(packageName)}/latest`;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function spawnOrFail(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(stderr || `${cmd[0]} failed with exit code ${result.exitCode}`);
  }

  return new TextDecoder().decode(result.stdout);
}

async function downloadTo(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function updateCache(manifest: CacheManifest, staticTarball: string, coreTarball: string): Promise<void> {
  await mkdir(CACHE_ROOT, { recursive: true });
  const tempDir = await mkdtemp(join(CACHE_ROOT, ".generation-"));
  const staticArchive = join(tempDir, "static.tgz");
  const coreArchive = join(tempDir, "core.tgz");
  const stagedIconsDir = join(tempDir, "icons");
  let published = false;

  try {
    await downloadTo(staticTarball, staticArchive);
    await downloadTo(coreTarball, coreArchive);

    await mkdir(stagedIconsDir, { recursive: true });
    spawnOrFail(["tar", "-xzf", staticArchive, "-C", stagedIconsDir, "--strip-components=2", "package/icons"]);

    const tarList = spawnOrFail(["tar", "-tf", coreArchive]);
    const exportNames = tarList
      .split("\n")
      .filter((line) => line.startsWith("package/dist/esm/") && line.endsWith("Icon.js"))
      .map((line) => basename(line, ".js"))
      .sort();

    await rm(staticArchive, { force: true });
    await rm(coreArchive, { force: true });
    await writeFile(join(tempDir, "exports.txt"), exportNames.join("\n") + "\n");
    await writeFile(join(tempDir, "version.txt"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(tempDir, "ready.txt"), "ready\n");

    // Publish the complete generation by swapping one symlink. A failed or
    // concurrent refresh therefore leaves the previously published cache
    // usable, and readers never observe a half-written generation.
    const nextLink = join(CACHE_ROOT, `.current-${basename(tempDir)}`);
    await symlink(tempDir, nextLink);
    try {
      await rename(nextLink, CURRENT_LINK);
      published = true;
    } finally {
      await rm(nextLink, { force: true });
    }
  } finally {
    // Published generations are retained so readers that started before a
    // concurrent swap can finish against their immutable generation.
    if (!published) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function ensureCache(): Promise<void> {
  let cachedManifest: CacheManifest | null = null;
  if (await pathExists(versionFile())) {
    try {
      cachedManifest = JSON.parse(await readFile(versionFile(), "utf8")) as CacheManifest;
    } catch {
      cachedManifest = null;
    }
  }

  try {
    const [staticMeta, coreMeta] = await Promise.all([
      fetchJson(toRegistryUrl(STATIC_PACKAGE)),
      fetchJson(toRegistryUrl(CORE_PACKAGE)),
    ]);

    const staticVersion = String(staticMeta.version ?? "");
    const coreVersion = String(coreMeta.version ?? "");
    const staticTarball = String((staticMeta.dist as { tarball?: string } | undefined)?.tarball ?? "");
    const coreTarball = String((coreMeta.dist as { tarball?: string } | undefined)?.tarball ?? "");
    const staticIntegrity = String((staticMeta.dist as { integrity?: string } | undefined)?.integrity ?? "");
    const coreIntegrity = String((coreMeta.dist as { integrity?: string } | undefined)?.integrity ?? "");

    if (!staticVersion || !coreVersion || !staticTarball || !coreTarball) {
      throw new Error("Hugeicons package metadata is incomplete.");
    }

    const manifest: CacheManifest = {
      staticVersion,
      coreVersion,
      ...(staticIntegrity ? { staticIntegrity } : {}),
      ...(coreIntegrity ? { coreIntegrity } : {}),
    };

    if (
      JSON.stringify(manifest) !== JSON.stringify(cachedManifest) ||
      !(await hasCompleteCache(CURRENT_LINK))
    ) {
      await updateCache(manifest, staticTarball, coreTarball);
    }

    return;
  } catch (error) {
    if (await hasCompleteCache(CURRENT_LINK)) {
      return;
    }
    fatal(`Failed to refresh Hugeicons cache: ${(error as Error).message}`);
  }
}

async function listIcons(): Promise<string[]> {
  await ensureCache();
  const output = spawnOrFail(["find", iconsDir(), "-type", "f", "-name", "*.svg"]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => basename(line, ".svg"))
    .sort();
}

async function readExports(): Promise<Set<string>> {
  await ensureCache();
  const content = await readFile(exportsFile(), "utf8");
  return new Set(content.split("\n").filter(Boolean));
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function toExportName(iconName: string): string {
  if (iconName === "w-3-schools") {
    return "WThreeSchoolsIcon";
  }

  const specialParts = new Map<string, string>([
    ["1st", "First"],
    ["2nd", "Second"],
    ["3rd", "Third"],
    ["3d", "ThreeD"],
    ["4k", "FourK"],
    ["7z", "SevenZ"],
  ]);

  const parts = iconName.split("-");
  return (
    parts
      .map((part) => {
        const special = specialParts.get(part);
        if (special) {
          return special;
        }
        if (/^\d+$/.test(part)) {
          return part;
        }
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join("") + "Icon"
  );
}

async function resolveIconPath(iconName: string): Promise<string> {
  await ensureCache();
  const path = join(iconsDir(), `${iconName}.svg`);
  if (!(await pathExists(path))) {
    fatal(`Hugeicons icon not found: ${iconName}`);
  }
  return path;
}

function renderUsage(platform: string, iconName: string, exportName: string | null): string {
  if (platform === "html") {
    return `hugeicons svg ${iconName}`;
  }

  if (platform === "flutter") {
    return [
      "Dependencies:",
      "  flutter pub add flutter_svg",
      "",
      "Usage:",
      `  final iconPath = 'assets/icons/${iconName}.svg';`,
      "  SvgPicture.asset(iconPath, width: 24, height: 24)",
    ].join("\n");
  }

  if (!exportName) {
    return [
      `No verified free-package export name was found for \`${iconName}\`.`,
      `Use \`hugeicons path ${iconName}\` or \`hugeicons svg ${iconName}\` instead.`,
    ].join("\n");
  }

  if (platform === "react") {
    return [
      "npm install @hugeicons/react @hugeicons/core-free-icons",
      "",
      "import { HugeiconsIcon } from '@hugeicons/react';",
      `import { ${exportName} } from '@hugeicons/core-free-icons';`,
      "",
      `<HugeiconsIcon icon={${exportName}} size={24} color=\"currentColor\" strokeWidth={1.5} />`,
    ].join("\n");
  }

  if (platform === "react-native") {
    return [
      "npm install @hugeicons/react-native @hugeicons/core-free-icons react-native-svg",
      "",
      "import { HugeiconsIcon } from '@hugeicons/react-native';",
      `import { ${exportName} } from '@hugeicons/core-free-icons';`,
      "",
      `<HugeiconsIcon icon={${exportName}} size={24} color=\"black\" strokeWidth={1.5} />`,
    ].join("\n");
  }

  if (platform === "vue") {
    return [
      "npm install @hugeicons/vue @hugeicons/core-free-icons",
      "",
      "<script setup>",
      "import { HugeiconsIcon } from '@hugeicons/vue';",
      `import { ${exportName} } from '@hugeicons/core-free-icons';`,
      "</script>",
      "",
      `<HugeiconsIcon :icon="${exportName}" :size="24" color="currentColor" :stroke-width="1.5" />`,
    ].join("\n");
  }

  if (platform === "svelte") {
    return [
      "npm install @hugeicons/svelte @hugeicons/core-free-icons",
      "",
      "<script>",
      "  import { HugeiconsIcon } from '@hugeicons/svelte';",
      `  import { ${exportName} } from '@hugeicons/core-free-icons';`,
      "</script>",
      "",
      `<HugeiconsIcon icon={${exportName}} size={24} color="currentColor" strokeWidth={1.5} />`,
    ].join("\n");
  }

  if (platform === "angular") {
    return [
      "npm install @hugeicons/angular @hugeicons/core-free-icons",
      "",
      "import { HugeiconsIconComponent } from '@hugeicons/angular';",
      `import { ${exportName} } from '@hugeicons/core-free-icons';`,
      "",
      "@Component({",
      "  standalone: true,",
      "  imports: [HugeiconsIconComponent],",
      "  template: `",
      `    <hugeicons-icon [icon]="${exportName}" [size]="24" color="currentColor" [strokeWidth]="1.5" />`,
      "  `,",
      "})",
    ].join("\n");
  }

  fatal(`Unsupported platform: ${platform}`);
}

async function main(): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    usage(0);
  }

  if (command === "list") {
    console.log((await listIcons()).join("\n"));
    return;
  }

  if (command === "search") {
    const query = normalizeQuery(args.slice(1).join(" "));
    if (!query) {
      usage(1);
    }

    const terms = query.split(/\s+/).filter(Boolean);
    const matches = (await listIcons()).filter((name) =>
      terms.every((term) => name.toLowerCase().includes(term))
    );

    if (matches.length === 0) {
      fatal(`No Hugeicons match for: ${query}`);
    }

    console.log(matches.slice(0, 50).join("\n"));
    if (matches.length > 50) {
      console.error(`Showing 50 of ${matches.length} matches.`);
    }
    return;
  }

  if (command === "path") {
    const iconName = args[1];
    if (!iconName) {
      usage(1);
    }
    console.log(await resolveIconPath(iconName));
    return;
  }

  if (command === "svg") {
    const iconName = args[1];
    if (!iconName) {
      usage(1);
    }

    const outIndex = args.indexOf("--out");
    const svg = await readFile(await resolveIconPath(iconName), "utf8");

    if (outIndex >= 0) {
      const outFile = args[outIndex + 1];
      if (!outFile) {
        fatal("Missing file path after --out");
      }
      await writeFile(outFile, svg);
      console.log(outFile);
      return;
    }

    process.stdout.write(svg);
    return;
  }

  if (command === "usage") {
    const platform = args[1];
    const iconName = args[2];
    if (!platform || !iconName) {
      usage(1);
    }

    await resolveIconPath(iconName);
    const exports = await readExports();
    const exportName = toExportName(iconName);
    console.log(renderUsage(platform, iconName, exports.has(exportName) ? exportName : null));
    return;
  }

  usage(1);
}

await main();
EOF
