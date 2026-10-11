import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { DeviceProfileName } from "../../config/devices";
import { MODELS } from "../../config/models";
import { renderProfileBlocks } from "./profile-blocks";

type ModelValues = { readonly [key: string]: string | ModelValues };

function modelEntries(values: ModelValues, prefix = ""): Array<[string, string]> {
  return Object.entries(values).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return typeof value === "string" ? [[path, value]] : modelEntries(value, path);
  });
}

const MODEL_REFERENCES = new Map(modelEntries(MODELS));

export function renderModelReferences(content: string, source = "content"): string {
  const rendered = content.replace(/\{\{models\.([^{}]*)\}\}/g, (reference, path: string) => {
    const value = MODEL_REFERENCES.get(path);
    if (value === undefined) throw new Error(`Unknown model reference ${reference} in ${source}`);

    return value;
  });

  if (/\{\{models\b/.test(rendered)) {
    throw new Error(`Malformed model reference in ${source}`);
  }

  return rendered;
}

export function renderManagedMarkdown(
  content: string,
  profile: DeviceProfileName,
  source = "content",
): string {
  return renderModelReferences(renderProfileBlocks(content, profile, source), source);
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);

    return entry.isFile() &&
      /\.(?:ts|md|json|toml|zsh|sh|py|js)$/.test(entry.name) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Reject managed model literals outside the catalog; historical test fixtures are exempt. */
export function assertCentralizedModels(root: string): void {
  const literals = [...new Set(MODEL_REFERENCES.values())]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Also catch older or newly introduced versioned IDs before they enter the catalog.
  const versionedId = String.raw`(?:gpt|claude|glm|deepseek|gemini|qwen|kimi)-[a-z0-9.-]*\d[a-z0-9.-]*`;
  const pattern = new RegExp(`(?<![\\w-])(?:${literals.join("|")}|${versionedId})(?![\\w-])`, "g");
  const files = ["config", "src", "content", "shell"].flatMap((dir) =>
    sourceFiles(join(root, dir)),
  );
  const problems: string[] = [];

  for (const file of files) {
    const source = relative(root, file).split(sep).join("/");
    if (source === "config/models.ts") continue;

    const content = readFileSync(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      for (const match of line.matchAll(pattern)) {
        problems.push(
          `${source}:${index + 1}: move ${JSON.stringify(match[0])} to config/models.ts`,
        );
      }
    }

    if (file.endsWith(".md")) {
      try {
        renderModelReferences(content, source);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  }

  if (problems.length) {
    throw new Error(
      `Model catalog validation failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
}
