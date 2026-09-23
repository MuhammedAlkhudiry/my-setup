import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { OPTIONAL_EXTERNAL_SKILL_NAMES, REMOTE_SKILL_SOURCES } from "../../config/skills";
import { discoverLocalSkills } from "./skills";

const ROOT_DIR = join(import.meta.dir, "..", "..");
const LOCAL_SKILLS_ROOT = join(ROOT_DIR, "content", "skills");

function skillContent(name: string, bodyLines: string[] = [`# ${name}`]): string {
  const lines = [
    "---",
    `name: ${name}`,
    `description: Example ${name} skill.`,
    "---",
    "",
    ...bodyLines,
  ];

  return lines.join("\n") + "\n";
}

function writeSkill(root: string, path: string, name: string, bodyLines?: string[]): void {
  const dir = join(root, path, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillContent(name, bodyLines));
}

describe("discoverLocalSkills", () => {
  test("discovers nested category skills", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      writeSkill(root, "tools", "laravel");
      writeSkill(root, "workflow", "implementation-walkthrough");

      const skills = discoverLocalSkills(root);

      expect(skills.map((skill) => skill.name)).toEqual(["implementation-walkthrough", "laravel"]);
      expect(skills.find((skill) => skill.name === "laravel")?.category).toBe("tools");
      expect(skills.find((skill) => skill.name === "implementation-walkthrough")?.category).toBe(
        "workflow",
      );
      expect(skills.find((skill) => skill.name === "laravel")?.lineCount).toBe(6);
      expect(skills.find((skill) => skill.name === "laravel")?.characterCount).toBe(69);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects folder and frontmatter name mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      const dir = join(root, "tools", "laravel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: react\ndescription: Wrong name.\n---\n");

      expect(() => discoverLocalSkills(root)).toThrow(/folder name must match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads a description that wraps onto several lines", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      const dir = join(root, "tools", "laravel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: laravel\ndescription:\n  Use when writing\n  Laravel code.\n---\n",
      );

      expect(discoverLocalSkills(root)[0]?.description).toBe("Use when writing Laravel code.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts namespaced external skill references", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      writeSkill(root, "tools", "browser-routing", [
        "# Browser routing",
        "Use $chrome:control-chrome when existing browser state is required.",
      ]);

      expect(() =>
        discoverLocalSkills(root, {
          additionalSkillNames: ["chrome:control-chrome"],
        }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when a skill exceeds the recommended character budget", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    const warnings: string[] = [];
    try {
      writeSkill(root, "tools", "typescript", [
        "# typescript",
        ...Array.from({ length: 5 }, (_, sectionIndex) => [
          `## Section ${sectionIndex + 1}`,
          ...Array.from({ length: 10 }, () => "x".repeat(90)),
        ]).flat(),
      ]);

      discoverLocalSkills(root, { reportWarning: (message) => warnings.push(message) });

      expect(warnings).toEqual([
        "Skill exceeds recommended 4000 character budget: tools/typescript/SKILL.md has 4693 characters",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when a skill has very long lines", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    const warnings: string[] = [];
    try {
      writeSkill(root, "tools", "typescript", ["# typescript", "x".repeat(241)]);

      discoverLocalSkills(root, { reportWarning: (message) => warnings.push(message) });

      expect(warnings).toEqual([
        "Skill has lines over 240 characters: tools/typescript/SKILL.md line 7 has 241",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when a skill has a huge section", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    const warnings: string[] = [];
    try {
      writeSkill(root, "tools", "typescript", [
        "# typescript",
        "## Large",
        ...Array.from({ length: 23 }, () => "x".repeat(90)),
      ]);

      discoverLocalSkills(root, { reportWarning: (message) => warnings.push(message) });

      expect(warnings).toEqual([
        'Skill has sections over 2000 characters: tools/typescript/SKILL.md "Large" has 2103',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when a skill references missing local files", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    const warnings: string[] = [];
    try {
      writeSkill(root, "workflow", "workflow", [
        "# workflow",
        "Read [the guide](references/missing-guide.md).",
        "Run `scripts/missing-script.ts` when needed.",
      ]);

      discoverLocalSkills(root, { reportWarning: (message) => warnings.push(message) });

      expect(warnings).toEqual([
        "Skill references missing local files: workflow/workflow/SKILL.md references/missing-guide.md, scripts/missing-script.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts known local and additional skill references", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      writeSkill(root, "workflow", "alpha", ["Use $beta and $remote-skill."]);
      writeSkill(root, "workflow", "beta");

      expect(
        discoverLocalSkills(root, { additionalSkillNames: ["remote-skill"] }).map(
          (skill) => skill.name,
        ),
      ).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown skill references with their source locations", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      writeSkill(root, "workflow", "alpha", ["Use $missing-skill."]);

      expect(() => discoverLocalSkills(root)).toThrow(
        "Unknown skill references:\n- workflow/alpha/SKILL.md:6 references $missing-skill",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checks referenced Markdown while ignoring code examples", () => {
    const root = mkdtempSync(join(tmpdir(), "my-setup-skills-"));
    try {
      writeSkill(root, "workflow", "alpha", [
        "Use `$inlineVariable`.",
        "```bash",
        "echo $fenced-variable",
        "```",
      ]);
      const referencesDir = join(root, "workflow", "alpha", "references");
      mkdirSync(referencesDir);
      writeFileSync(join(referencesDir, "guide.md"), "Use $missing-skill.\n");

      expect(() => discoverLocalSkills(root)).toThrow(
        "workflow/alpha/references/guide.md:1 references $missing-skill",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps local source skills within the skill size policy", () => {
    const warnings: string[] = [];
    const remoteSkillNames = REMOTE_SKILL_SOURCES.flatMap((source) =>
      source.skills.map((skill) => skill.name),
    );

    expect(
      discoverLocalSkills(LOCAL_SKILLS_ROOT, {
        reportWarning: (message) => warnings.push(message),
        additionalSkillNames: [...remoteSkillNames, ...OPTIONAL_EXTERNAL_SKILL_NAMES],
      }).length,
    ).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });
});
