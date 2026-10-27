import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTelegramWebhook,
  sendTelegramMessage,
  telegramApi,
  validateRelayUrl,
} from "./telegram";

test("ops bot health rejects backlog, recent errors, and foreign webhook hosts without exposing secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-test-"));
  const previousHome = process.env.SERVICE_CREDENTIALS_HOME;
  const previousFetch = globalThis.fetch;
  mkdirSync(join(directory, "telegram"));
  writeFileSync(
    join(directory, "telegram/ops-bot.json"),
    JSON.stringify({ token: "123:private", owner_chat_id: "123" }),
  );
  process.env.SERVICE_CREDENTIALS_HOME = directory;
  let info: object = { url: "https://relay.t3.codes/test", pending_update_count: 0 };
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: info })) as unknown as typeof fetch;

  try {
    expect(await checkTelegramWebhook()).toBe(0);
    info = { url: "https://relay.t3.codes/test", pending_update_count: 6 };
    await expect(checkTelegramWebhook()).rejects.toThrow("backlog");
    info = {
      url: "https://relay.t3.codes/test",
      pending_update_count: 0,
      last_error_date: Date.now() / 1000,
    };
    await expect(checkTelegramWebhook()).rejects.toThrow("delivery error");
    info = { url: "https://example.com/private", pending_update_count: 0 };
    await expect(checkTelegramWebhook()).rejects.toThrow("T3 relay");
    expect(() => validateRelayUrl("https://relay.t3.codes.example.com/private")).toThrow(
      "T3 relay",
    );
    globalThis.fetch = (async () => {
      throw new Error("secret token and webhook URL");
    }) as unknown as typeof fetch;
    await expect(telegramApi("getWebhookInfo")).rejects.toThrow(
      "Telegram getWebhookInfo failed; check credentials and connectivity",
    );
    await expect(sendTelegramMessage(" ")).rejects.toThrow("nonempty");
    await expect(sendTelegramMessage("x".repeat(4097))).rejects.toThrow("never truncated");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SERVICE_CREDENTIALS_HOME;
    else process.env.SERVICE_CREDENTIALS_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});
