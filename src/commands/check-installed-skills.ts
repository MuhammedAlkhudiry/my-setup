#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { OPTIONAL_EXTERNAL_SKILL_NAMES, REMOTE_SKILL_SOURCES } from "../../config/skills";
import { readDeviceProfile, selectRemoteSkillSources } from "../lib/device";
import { renderProfileBlocks } from "../lib/profile-blocks";
import { discoverLocalSkills } from "../lib/skills";

const HOME = homedir();
const PROFILE = readDeviceProfile(HOME);
const ROOT_DIR = join(import.meta.dir, "..", "..");
const LOCAL_SKILLS_ROOT = join(ROOT_DIR, "content", "skills");
const INSTALLED_SKILLS_ROOT = join(HOME, ".agents", "skills");
const MANIFEST_PATH = join(INSTALLED_SKILLS_ROOT, ".my-setup-managed-skills.json");

interface Finding {
  label: string;
  detail: string;
}

function readManifest(): { names: string[]; valid: boolean } {
  if (!existsSync(MANIFEST_PATH)) {
    return { names: [], valid: false };
  }

  try {
    const content = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as unknown;
    return {
      names: Array.isArray(content)
        ? content.filter((value): value is string => typeof value === "string").sort()
        : [],
      valid: Array.isArray(content),
    };
  } catch {
    return { names: [], valid: false };
  }
}

function walkFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(path, root);
      }

      if (!entry.isFile()) {
        return [];
      }

      return relative(root, path);
    })
    .sort();
}

function compareSkillDirs(sourceDir: string, installedDir: string): string[] {
  const sourceFiles = walkFiles(sourceDir);
  const installedFiles = walkFiles(installedDir);
  const files = [...new Set([...sourceFiles, ...installedFiles])].sort();
  const differences: string[] = [];

  for (const file of files) {
    const sourcePath = join(sourceDir, file);
    const installedPath = join(installedDir, file);

    if (!existsSync(sourcePath)) {
      differences.push(`extra installed file ${file}`);
      continue;
    }

    if (!existsSync(installedPath)) {
      differences.push(`missing installed file ${file}`);
      continue;
    }

    // Markdown is installed with this profile's blocks rendered, so compare against that output.
    const expected = file.endsWith(".md")
      ? Buffer.from(renderProfileBlocks(readFileSync(sourcePath, "utf-8"), PROFILE.name, file))
      : readFileSync(sourcePath);

    if (!expected.equals(readFileSync(installedPath))) {
      differences.push(`changed file ${file}`);
    }
  }

  return differences;
}

const declaredRemoteSkillNames = REMOTE_SKILL_SOURCES.flatMap((source) =>
  source.skills.map((skill) => skill.name),
);
const remoteSkillNames = selectRemoteSkillSources(REMOTE_SKILL_SOURCES, PROFILE)
  .flatMap((source) => source.skills.map((skill) => skill.name))
  .sort();
const excludedSkills = new Set(PROFILE.excludedSkills);
const localSkills = discoverLocalSkills(LOCAL_SKILLS_ROOT, {
  additionalSkillNames: [...declaredRemoteSkillNames, ...OPTIONAL_EXTERNAL_SKILL_NAMES],
}).filter((skill) => !excludedSkills.has(skill.name));
const localSkillNames = localSkills.map((skill) => skill.name).sort();
const remoteSkillNameSet = new Set(remoteSkillNames);
const managedSkillNames = [...new Set([...localSkillNames, ...remoteSkillNames])].sort();
const installedRootExists = existsSync(INSTALLED_SKILLS_ROOT);
const manifestExists = existsSync(MANIFEST_PATH);
const manifest = readManifest();
const manifestSkillNames = manifest.names;
const findings: Finding[] = [];

if (!installedRootExists) {
  findings.push({
    label: "missing install",
    detail: `${INSTALLED_SKILLS_ROOT} does not exist`,
  });
} else if (!manifestExists) {
  findings.push({
    label: "missing manifest",
    detail: `${MANIFEST_PATH} does not exist`,
  });
} else if (!manifest.valid) {
  findings.push({
    label: "invalid manifest",
    detail: `${MANIFEST_PATH} is not a managed skill list`,
  });
}

if (manifestExists && manifest.valid) {
  for (const skillName of manifestSkillNames.filter((name) => !managedSkillNames.includes(name))) {
    findings.push({
      label: "stale manifest",
      detail: `${skillName} is managed in the manifest but not declared in source`,
    });
  }

  for (const skillName of managedSkillNames.filter((name) => !manifestSkillNames.includes(name))) {
    findings.push({
      label: "missing manifest entry",
      detail: `${skillName} is declared in source but missing from the managed manifest`,
    });
  }
}

if (installedRootExists) {
  for (const skill of localSkills.filter((skill) => !remoteSkillNameSet.has(skill.name))) {
    const installedDir = join(INSTALLED_SKILLS_ROOT, skill.name);

    if (!existsSync(installedDir)) {
      findings.push({
        label: "missing local skill",
        detail: `${skill.name} is missing from ${INSTALLED_SKILLS_ROOT}`,
      });
      continue;
    }

    const differences = compareSkillDirs(skill.dir, installedDir);
    if (differences.length) {
      findings.push({
        label: "local skill drift",
        detail: `${skill.name}: ${differences.slice(0, 3).join(", ")}`,
      });
    }
  }

  for (const skillName of remoteSkillNames) {
    const installedDir = join(INSTALLED_SKILLS_ROOT, skillName);

    if (!existsSync(installedDir)) {
      findings.push({
        label: "missing remote skill",
        detail: `${skillName} is declared in config/skills.ts but not installed`,
      });
    }
  }
}

if (!findings.length) {
  console.log(`managed skills synced (${managedSkillNames.length})`);
  process.exit(0);
}

for (const finding of findings) {
  console.log(`${finding.label}: ${finding.detail}`);
}

process.exit(1);
