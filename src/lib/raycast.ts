import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CLAUDE_POOL } from "../../config/claude-pool";
import { MODELS } from "../../config/models";
import { claudePoolPaths } from "./claude-pool";

export const RAYCAST_PROVIDER_ID = "claude-pool";
export const RAYCAST_APP = "/Applications/Raycast.app";

// Every model in MODELS.raycast has a 1M-token context window.
const CONTEXT_TOKENS = 1_000_000;

const supported = (value: boolean) => ({ supported: value });

type ProvidersFile = Record<string, unknown> & { providers?: unknown[] };

export function raycastProvidersPath(home: string): string {
  return join(home, ".config/raycast/ai/providers.yaml");
}

/** The managed provider entry: the local pool's OpenAI-compatible endpoint with its client key. */
export function renderRaycastProvider(clientKey: string) {
  return {
    id: RAYCAST_PROVIDER_ID,
    name: "Claude pool",
    base_url: `http://127.0.0.1:${CLAUDE_POOL.port}/v1`,
    api_keys: { pool: clientKey },
    models: Object.values(MODELS.raycast).map(({ id, name }) => ({
      id,
      name,
      provider: "pool",
      context: CONTEXT_TOKENS,
      abilities: {
        vision: supported(true),
        tools: supported(true),
        system_message: supported(true),
        // The pool maps reasoning_effort to Claude's effort levels.
        reasoning_effort: supported(true),
        // Current Claude models reject sampling settings and the pool drops them, so a slider would do nothing.
        temperature: supported(false),
      },
    })),
  };
}

function parseProvidersFile(content: string | undefined, path: string): ProvidersFile {
  const parsed: unknown = content?.trim() ? Bun.YAML.parse(content) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Raycast providers file at ${path}`);
  }
  const file = parsed as ProvidersFile;
  if (file.providers !== undefined && !Array.isArray(file.providers)) {
    throw new Error(`Invalid Raycast providers list at ${path}`);
  }
  return file;
}

function isManagedProvider(provider: unknown): boolean {
  return (provider as { id?: unknown } | null)?.id === RAYCAST_PROVIDER_ID;
}

/** Replaces only the managed provider, keeping other providers, their order, and other top-level keys. */
export function mergeRaycastProviders(
  existing: string | undefined,
  clientKey: string,
  path = "providers.yaml",
): string {
  const file = parseProvidersFile(existing, path);
  const providers = file.providers ?? [];
  const managed = renderRaycastProvider(clientKey);
  const index = providers.findIndex(isManagedProvider);
  const merged =
    index === -1
      ? [...providers, managed]
      : providers.map((provider, at) => (at === index ? managed : provider));

  return `${Bun.YAML.stringify({ ...file, providers: merged }, null, 2)}\n`;
}

/** Finds problems with the managed provider in an installed providers.yaml. */
export function checkRaycastProvider(content: string, clientKey: string): string | undefined {
  let provider: unknown;
  try {
    provider = parseProvidersFile(content, "providers.yaml").providers?.find(isManagedProvider);
  } catch {
    return "is not valid YAML";
  }
  if (!provider) return "has no Claude pool provider";
  if (JSON.stringify(provider) !== JSON.stringify(renderRaycastProvider(clientKey))) {
    return "has an outdated Claude pool provider";
  }
  return undefined;
}

/** Writes the Claude pool provider into Raycast's providers.yaml; Raycast reloads the file on save. */
export async function installRaycastProvider(
  home: string,
): Promise<{ installed: boolean; changed: boolean }> {
  if (!existsSync(RAYCAST_APP)) return { installed: false, changed: false };

  const path = raycastProvidersPath(home);
  const clientKey = (await readFile(claudePoolPaths(home).clientKey, "utf8")).trim();
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const content = mergeRaycastProviders(existing, clientKey, path);

  // The file holds the pool's client key.
  await mkdir(dirname(path), { recursive: true });
  if (content !== existing) await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return { installed: true, changed: content !== existing };
}
