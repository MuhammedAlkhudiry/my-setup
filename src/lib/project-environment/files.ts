import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { log, run } from "./command";
import type { MarkedInstall, ProjectEnvironmentContext } from "./types";

export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1], parseEnvValue(match[2])]),
  );
}

function parseEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    const characters = value.slice(1, -1);
    let parsed = "";
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      if (character !== "\\") {
        parsed += character;
        continue;
      }
      const escaped = characters[++index];
      const escapes: Record<string, string> = {
        '"': '"',
        $: "$",
        "\\": "\\",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
      };
      if (!(escaped in escapes)) throw new Error(`Invalid dotenv escape sequence: \\${escaped}`);
      parsed += escapes[escaped];
    }
    return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  const comment = value.indexOf("#");
  return (comment === -1 ? value : value.slice(0, comment)).trimEnd();
}

function serializeEnvValue(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 8 || (code >= 14 && code <= 31) || code === 127) {
      throw new Error("Dotenv values cannot contain unsupported control characters");
    }
  }
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll('"', '\\"')
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\v", "\\v")}"`;
}

export function upsertEnvValues(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));
  const matched = new Set<string>();
  const updated = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = `${match[1]}=${serializeEnvValue(pending.get(match[1])!)}`;
    matched.add(match[1]);
    return value;
  });
  for (const key of matched) pending.delete(key);
  for (const [key, value] of pending) updated.push(`${key}=${serializeEnvValue(value)}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${updated.join("\n").replace(/\n+$/, "")}\n`);
}

export function hashFiles(root: string, paths: string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash
      .update(path)
      .update("\0")
      .update(readFileSync(resolve(root, path)))
      .update("\0");
  }
  return hash.digest("hex");
}

export function ensureMarkedInstall(
  context: ProjectEnvironmentContext,
  step: string,
  install: MarkedInstall,
): void {
  const marker = resolve(context.root, install.marker);
  const expected = hashFiles(install.hashRoot, install.hashFiles);
  const current = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (current === expected) {
    log(step, `${install.label} is current`);
    return;
  }
  run(context, step, install.command, install.args, { cwd: install.cwd });
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${expected}\n`);
}
