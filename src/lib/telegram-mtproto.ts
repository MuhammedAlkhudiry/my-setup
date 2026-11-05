// Downloads Telegram files of up to 2 GB by signing the ops bot in over MTProto; the Bot API stops at 20 MB.
// Signing in over MTProto never calls the Bot API's logOut and leaves the webhook alone, so the cloud Bot API keeps working.

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CREDENTIALS_HOME_ENV, CREDENTIALS_ROOT } from "../../config/credentials";

const appSchema = z.object({
  api_id: z.number().int().positive(),
  api_hash: z.string().regex(/^[0-9a-f]{32}$/),
});

/** The slice of the MTProto client the download uses, so tests can pass a mock. */
export interface BotFileClient {
  /** Signs in with the session when given, otherwise with the bot token; returns the session to store. */
  signIn(session: string | undefined): Promise<string>;
  /** Writes the message's file to `path`; returns false when the message has no file. */
  downloadMessageFile(chatId: number, messageId: number, path: string): Promise<boolean>;
  close(): Promise<void>;
}

function credentialsHome(): string {
  return process.env[CREDENTIALS_HOME_ENV] || join(homedir(), CREDENTIALS_ROOT);
}

export function mtprotoSessionPath(): string {
  return join(credentialsHome(), "telegram/ops-bot.mtproto-session");
}

export function readMtprotoApp(): { apiId: number; apiHash: string } {
  try {
    const app = appSchema.parse(
      JSON.parse(readFileSync(join(credentialsHome(), "telegram/mtproto-app.json"), "utf8")),
    );
    return { apiId: app.api_id, apiHash: app.api_hash };
  } catch {
    throw new Error("Telegram MTProto app credentials missing or invalid in credentials home");
  }
}

export function parseDownloadTarget(chatId: string, messageId: string): { chatId: number; messageId: number } {
  if (!/^-?\d{1,20}$/.test(chatId)) throw new Error("Chat id must be an integer, such as -1001234567890");
  if (!/^[1-9]\d{0,9}$/.test(messageId)) throw new Error("Message id must be a positive integer");

  return { chatId: Number(chatId), messageId: Number(messageId) };
}

function saveSession(session: string): void {
  const path = mtprotoSessionPath();
  writeFileSync(path, session, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Downloads one message's file to `outPath` through a partial file, never overwriting; returns its size in bytes. */
export async function downloadTelegramMessageFile(
  client: BotFileClient,
  chatId: string,
  messageId: string,
  outPath: string,
): Promise<number> {
  const target = parseDownloadTarget(chatId, messageId);
  if (existsSync(outPath)) throw new Error("Output path already exists; choose a new path");
  if (!existsSync(dirname(outPath))) throw new Error("Output directory does not exist");

  const sessionPath = mtprotoSessionPath();
  const stored = existsSync(sessionPath) ? readFileSync(sessionPath, "utf8").trim() : undefined;
  const partial = `${outPath}.partial`;

  try {
    const session = await client.signIn(stored || undefined);
    if (session !== stored) saveSession(session);
    if (!(await client.downloadMessageFile(target.chatId, target.messageId, partial)))
      throw new Error("Message has no file, or the ops bot cannot see it");
    renameSync(partial, outPath);

    return statSync(outPath).size;
  } finally {
    rmSync(partial, { force: true });
    await client.close();
  }
}
