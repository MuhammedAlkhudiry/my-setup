// Shared OpenRouter access for the scripts: the key comes from OPENROUTER_API_KEY or a .env file in the
// working directory, and every paid call appends its cost to logs/spend.jsonl in the working directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

export function openRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  const dotenv = existsSync(".env") ? readFileSync(".env", "utf8").match(/OPENROUTER_API_KEY=(\S+)/)?.[1] : undefined;
  if (!dotenv) throw new Error("Set OPENROUTER_API_KEY or add it to .env in the working directory.");
  return dotenv;
}

export function logSpend(entry: Record<string, unknown>): void {
  mkdirSync("logs", { recursive: true });
  appendFileSync("logs/spend.jsonl", JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}
