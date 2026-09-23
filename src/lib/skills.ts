import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export interface LocalSkill {
  name: string;
  description: string;
  category: string;
  dir: string;
  skillPath: string;
  characterCount: number;
  lineCount: number;
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

interface SkillDiscoveryOptions {
  reportWarning?: (message: string) => void;
  additionalSkillNames?: readonly string[];
}

const DEFAULT_CATEGORY = "uncategorized";
const SKILL_CHARACTER_WARNING_LIMIT = 4000;
const SKILL_LONG_LINE_WARNING_LIMIT = 240;
const SKILL_SECTION_CHARACTER_WARNING_LIMIT = 2000;
const SKILL_LOCAL_PATH_PREFIXES = ["references/", "scripts/", "assets/"];

function parseSkillFrontmatter(content: string, skillPath: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`Skill is missing YAML frontmatter: ${skillPath}`);
  }

  const values = Bun.YAML.parse(match[1]);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(`Skill frontmatter must be a YAML object: ${skillPath}`);
  }

  const { name, description } = values as Record<string, unknown>;
  if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
    throw new Error(`Skill frontmatter needs name and description: ${skillPath}`);
  }

  return { name, description };
}

function countLines(content: string): number {
  if (!content) {
    return 0;
  }

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lineCount = normalizedContent.split("\n").length;
  return normalizedContent.endsWith("\n") ? lineCount - 1 : lineCount;
}

function findSkillPaths(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const skillPath = join(dir, "SKILL.md");
  if (existsSync(skillPath)) {
    return [skillPath];
  }

  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .flatMap((entryPath) => findSkillPaths(entryPath));
}

function findMarkdownPaths(dir: string): string[] {
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .flatMap((entryPath) =>
      statSync(entryPath).isDirectory()
        ? findMarkdownPaths(entryPath)
        : entryPath.endsWith(".md")
          ? [entryPath]
          : [],
    );
}

function skillCategory(skillsRoot: string, skillDir: string): string {
  const parts = relative(skillsRoot, skillDir).split(sep).filter(Boolean);
  return parts.length > 1 ? parts[0] : DEFAULT_CATEGORY;
}

function formatList(items: string[]): string {
  const shownItems = items.slice(0, 3);
  const suffix =
    items.length > shownItems.length ? `, and ${items.length - shownItems.length} more` : "";
  return `${shownItems.join(", ")}${suffix}`;
}

function cleanLocalReferencePath(target: string): string {
  const strippedTarget = target
    .replace(/^<|>$/g, "")
    .split("#", 1)[0]
    .split("?", 1)[0]
    .replace(/[.,;:]+$/g, "");

  try {
    return decodeURIComponent(strippedTarget);
  } catch {
    return strippedTarget;
  }
}

function isLocalMarkdownTarget(target: string): boolean {
  return (
    target.length > 0 &&
    !target.startsWith("#") &&
    !target.startsWith("/") &&
    !target.startsWith("<") &&
    !target.includes("://") &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
  );
}

function validateSkillLocalReferences(
  skillsRoot: string,
  skillDir: string,
  skillPath: string,
  content: string,
  options: SkillDiscoveryOptions,
): void {
  const missingTargets = new Set<string>();
  const markdownLinkPattern = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const localPathPattern = /(?:^|[\s(`])((?:references|scripts|assets)\/[A-Za-z0-9._~/#?=-]+)/gm;

  for (const match of content.matchAll(markdownLinkPattern)) {
    const target = match[1];
    if (!isLocalMarkdownTarget(target)) {
      continue;
    }

    const localPath = cleanLocalReferencePath(target);
    if (localPath && !existsSync(join(skillDir, localPath))) {
      missingTargets.add(localPath);
    }
  }

  for (const match of content.matchAll(localPathPattern)) {
    const localPath = cleanLocalReferencePath(match[1]);
    if (
      localPath &&
      SKILL_LOCAL_PATH_PREFIXES.some((prefix) => localPath.startsWith(prefix)) &&
      !existsSync(join(skillDir, localPath))
    ) {
      missingTargets.add(localPath);
    }
  }

  if (missingTargets.size > 0) {
    options.reportWarning?.(
      `Skill references missing local files: ${relative(skillsRoot, skillPath)} ${formatList(
        Array.from(missingTargets).sort(),
      )}`,
    );
  }
}

function stripMarkdownCode(content: string): string {
  let fenceCharacter: "`" | "~" | undefined;

  return content
    .split(/\r?\n/)
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        const character = fence[1].startsWith("`") ? "`" : "~";
        if (!fenceCharacter) {
          fenceCharacter = character;
        } else if (fenceCharacter === character) {
          fenceCharacter = undefined;
        }
        return "";
      }

      return fenceCharacter ? "" : line.replace(/`[^`]*`/g, "");
    })
    .join("\n");
}

const SKILL_REFERENCE_PATTERN =
  /(?:^|[^A-Za-z0-9_$])\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*(?::[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?)(?![A-Za-z0-9:-])/g;

export function findUnknownSkillReferences(
  content: string,
  knownSkillNames: ReadonlySet<string>,
): Array<{ line: number; name: string }> {
  const unknown: Array<{ line: number; name: string }> = [];
  for (const [lineIndex, line] of stripMarkdownCode(content).split("\n").entries()) {
    for (const match of line.matchAll(SKILL_REFERENCE_PATTERN)) {
      if (!knownSkillNames.has(match[1])) unknown.push({ line: lineIndex + 1, name: match[1] });
    }
  }
  return unknown;
}

function validateCrossSkillReferences(
  skillsRoot: string,
  skills: Array<LocalSkill & { content: string }>,
  additionalSkillNames: readonly string[],
): void {
  const knownSkillNames = new Set([...skills.map((skill) => skill.name), ...additionalSkillNames]);
  const unknownReferences: string[] = [];

  for (const skill of skills) {
    for (const markdownPath of findMarkdownPaths(skill.dir)) {
      const content = readFileSync(markdownPath, "utf-8");
      for (const { line, name } of findUnknownSkillReferences(content, knownSkillNames)) {
        unknownReferences.push(`${relative(skillsRoot, markdownPath)}:${line} references $${name}`);
      }
    }
  }

  if (unknownReferences.length > 0) {
    throw new Error(
      `Unknown skill references:\n${unknownReferences.map((item) => `- ${item}`).join("\n")}`,
    );
  }
}

function validateSkillSize(
  skillsRoot: string,
  skillDir: string,
  skillPath: string,
  content: string,
  options: SkillDiscoveryOptions,
): void {
  const relativePath = relative(skillsRoot, skillPath);
  const characterCount = content.length;

  if (characterCount > SKILL_CHARACTER_WARNING_LIMIT) {
    options.reportWarning?.(
      `Skill exceeds recommended ${SKILL_CHARACTER_WARNING_LIMIT} character budget: ${relativePath} has ${characterCount} characters`,
    );
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const longLines = lines
    .map((line, index) => ({ lineNumber: index + 1, length: line.length }))
    .filter((line) => line.length > SKILL_LONG_LINE_WARNING_LIMIT);

  if (longLines.length > 0) {
    options.reportWarning?.(
      `Skill has lines over ${SKILL_LONG_LINE_WARNING_LIMIT} characters: ${relativePath} ${formatList(
        longLines.map((line) => `line ${line.lineNumber} has ${line.length}`),
      )}`,
    );
  }

  const sections: Array<{ title: string; length: number }> = [];
  let currentTitle = "frontmatter";
  let currentContent = "";

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading && currentContent) {
      sections.push({ title: currentTitle, length: currentContent.length });
      currentTitle = heading[2];
      currentContent = `${line}\n`;
      continue;
    }

    currentContent += `${line}\n`;
  }

  if (currentContent) {
    sections.push({ title: currentTitle, length: currentContent.length });
  }

  const largeSections = sections.filter(
    (section) => section.length > SKILL_SECTION_CHARACTER_WARNING_LIMIT,
  );

  if (largeSections.length > 0) {
    options.reportWarning?.(
      `Skill has sections over ${SKILL_SECTION_CHARACTER_WARNING_LIMIT} characters: ${relativePath} ${formatList(
        largeSections.map((section) => `"${section.title}" has ${section.length}`),
      )}`,
    );
  }

  validateSkillLocalReferences(skillsRoot, skillDir, skillPath, content, options);
}

export function discoverLocalSkills(
  skillsRoot: string,
  options: SkillDiscoveryOptions = { reportWarning: console.warn },
): LocalSkill[] {
  const skills = findSkillPaths(skillsRoot).map((skillPath) => {
    const dir = dirname(skillPath);
    const content = readFileSync(skillPath, "utf-8");
    const frontmatter = parseSkillFrontmatter(content, skillPath);
    const characterCount = content.length;
    const lineCount = countLines(content);

    if (basename(dir) !== frontmatter.name) {
      throw new Error(
        `Skill folder name must match frontmatter name: ${skillPath} has name ${frontmatter.name}`,
      );
    }

    return {
      ...frontmatter,
      category: skillCategory(skillsRoot, dir),
      dir,
      skillPath,
      characterCount,
      lineCount,
      content,
    };
  });

  for (const skill of skills) {
    validateSkillSize(skillsRoot, skill.dir, skill.skillPath, skill.content, options);
  }

  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate local skill name: ${skill.name}`);
    }
    seen.add(skill.name);
  }

  validateCrossSkillReferences(skillsRoot, skills, options.additionalSkillNames ?? []);

  return skills
    .map(({ content: _content, ...skill }) => skill)
    .sort((a, b) => a.name.localeCompare(b.name));
}
