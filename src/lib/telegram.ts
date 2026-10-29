import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CREDENTIALS_ROOT } from "../../config/credentials";

export const TELEGRAM_RELAY_HOST = "relay.t3.codes";

const credentialsSchema = z.object({
  token: z.string().regex(/^\d+:[\w-]+$/),
  owner_chat_id: z.union([z.string().regex(/^-?\d+$/), z.number().int().safe()]),
  // Group where the owner's family asks for Awraq customer support.
  support_chat_id: z.union([z.string().regex(/^-?\d+$/), z.number().int().safe()]).optional(),
});
const webhookSchema = z.object({
  url: z.string(),
  pending_update_count: z.number().int().nonnegative(),
  last_error_date: z.number().optional(),
});

function credentials() {
  try {
    return credentialsSchema.parse(
      JSON.parse(
        readFileSync(
          join(
            process.env.SERVICE_CREDENTIALS_HOME || join(homedir(), CREDENTIALS_ROOT),
            "telegram/ops-bot.json",
          ),
          "utf8",
        ),
      ),
    );
  } catch {
    throw new Error("Telegram ops bot credentials missing or invalid in credentials home");
  }
}

/** User ids of the ops bot and the owner it messages; the token's numeric prefix is the bot's user id. */
export function opsBot(): { botId: number; ownerId: number } {
  const { token, owner_chat_id } = credentials();
  return { botId: Number(token.split(":")[0]), ownerId: Number(owner_chat_id) };
}

export async function telegramApi(method: string, body: object = {}): Promise<unknown> {
  const { token } = credentials();

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = z.object({ ok: z.boolean(), result: z.unknown() }).parse(await response.json());
    if (!response.ok || !data.ok) throw new Error();

    return data.result;
  } catch {
    // Fetch errors and API descriptions can contain credentials or webhook URLs.
    throw new Error(`Telegram ${method} failed; check credentials and connectivity`);
  }
}

export function validateRelayUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === TELEGRAM_RELAY_HOST &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname !== "/"
    )
      return;
  } catch {
    /* Report only a safe fixed message. */
  }

  throw new Error("Webhook must be an HTTPS T3 relay URL on relay.t3.codes");
}

export async function checkTelegramWebhook(now = Date.now()): Promise<number> {
  const parsed = webhookSchema.safeParse(await telegramApi("getWebhookInfo"));
  if (!parsed.success) throw new Error("Telegram returned invalid webhook information");
  const info = parsed.data;
  validateRelayUrl(info.url);
  if (
    info.last_error_date !== undefined &&
    info.last_error_date * 1000 >= now - 24 * 60 * 60 * 1000
  )
    throw new Error("Telegram webhook has a delivery error within the last 24 hours");
  if (info.pending_update_count > 5)
    throw new Error(
      `Telegram webhook backlog is high: ${info.pending_update_count} pending updates (maximum 5)`,
    );

  return info.pending_update_count;
}

/** The owner's private chat, or the support group when `support` is set. */
function chatId(support: boolean): string | number {
  const { owner_chat_id, support_chat_id } = credentials();
  if (!support) return owner_chat_id;
  if (support_chat_id === undefined) throw new Error("No support_chat_id in the ops bot credentials");

  return support_chat_id;
}

export async function sendTelegramMessage(text: string, support = false): Promise<void> {
  if (!text.trim() || [...text].length > 4096)
    throw new Error(
      "Provide nonempty stdin of at most 4096 characters; messages are never truncated",
    );
  await telegramApi("sendMessage", {
    chat_id: chatId(support),
    text,
    link_preview_options: { is_disabled: true },
  });
}

export async function reactToTelegramMessage(
  messageId: string,
  emoji = "👍",
  support = false,
): Promise<void> {
  if (!/^\d+$/.test(messageId)) throw new Error("Message id must be a positive integer");

  await telegramApi("setMessageReaction", {
    chat_id: chatId(support),
    message_id: Number(messageId),
    reaction: [{ type: "emoji", emoji }],
  });
}
