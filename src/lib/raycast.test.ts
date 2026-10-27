import { expect, test } from "bun:test";

import { MODELS } from "../../config/models";
import {
  checkRaycastProvider,
  mergeRaycastProviders,
  RAYCAST_PROVIDER_ID,
  renderRaycastProvider,
} from "./raycast";

const OTHER_PROVIDERS = `# my providers
providers:
  - id: ollama
    name: Ollama
    base_url: http://localhost:11434/v1
    models:
      - id: llama
        name: Llama
  - id: ${RAYCAST_PROVIDER_ID}
    name: Old pool
    base_url: http://127.0.0.1:1/v1
    models: []
  - id: openrouter
    name: OpenRouter
    base_url: https://openrouter.ai/api/v1
    api_keys:
      main: other-key
    models:
      - id: some/model
        name: Some model
tools:
  web_search: openrouter
`;

test("Raycast provider points at the local pool with every catalog model", () => {
  const provider = renderRaycastProvider("client-key");

  expect(provider.base_url).toBe("http://127.0.0.1:8317/v1");
  expect(provider.api_keys).toEqual({ pool: "client-key" });
  expect(provider.models.map(({ id }) => id)).toEqual(
    Object.values(MODELS.raycast).map(({ id }) => id),
  );
  for (const model of provider.models) {
    expect(model.provider).toBe("pool");
    expect(model.context).toBe(1_000_000);
    expect(model.abilities.reasoning_effort.supported).toBe(true);
    expect(model.abilities.temperature.supported).toBe(false);
  }
});

test("Raycast providers merge writes a fresh file with only the managed provider", () => {
  const merged = Bun.YAML.parse(mergeRaycastProviders(undefined, "client-key")) as {
    providers: unknown[];
  };

  expect(merged).toEqual({ providers: [renderRaycastProvider("client-key")] });
});

test("Raycast providers merge replaces only the managed provider in place", () => {
  const merged = Bun.YAML.parse(mergeRaycastProviders(OTHER_PROVIDERS, "new-key")) as {
    providers: Array<{ id: string }>;
    tools: unknown;
  };
  const original = Bun.YAML.parse(OTHER_PROVIDERS) as {
    providers: Array<{ id: string }>;
  };

  expect(merged.providers.map(({ id }) => id)).toEqual([
    "ollama",
    RAYCAST_PROVIDER_ID,
    "openrouter",
  ]);
  expect(merged.providers[0]).toEqual(original.providers[0]);
  expect(merged.providers[1]).toEqual(renderRaycastProvider("new-key"));
  expect(merged.providers[2]).toEqual(original.providers[2]);
  expect(merged.tools).toEqual({ web_search: "openrouter" });
});

test("Raycast providers merge is stable on repeat runs", () => {
  const once = mergeRaycastProviders(OTHER_PROVIDERS, "client-key");

  expect(mergeRaycastProviders(once, "client-key")).toBe(once);
});

test("Raycast providers merge refuses files it cannot read safely", () => {
  expect(() => mergeRaycastProviders("- just\n- a list\n", "key")).toThrow(/Invalid/);
  expect(() => mergeRaycastProviders("providers: nope\n", "key")).toThrow(/Invalid/);
});

test("Raycast provider check reports missing, stale, and current entries", () => {
  const current = mergeRaycastProviders(undefined, "client-key");

  expect(checkRaycastProvider(current, "client-key")).toBeUndefined();
  expect(checkRaycastProvider(current, "rotated-key")).toMatch(/outdated/);
  expect(checkRaycastProvider("providers: []\n", "client-key")).toMatch(/no Claude pool/);
  expect(checkRaycastProvider("providers: [\n", "client-key")).toMatch(/not valid YAML/);
});
