import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
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

/** The ops bot token for signing in over MTProto; never print or log it. */
export function opsBotToken(): string {
  return credentials().token;
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

// Large v3 turbo handles Arabic dialects well and runs fast on Apple silicon through Metal.
export const WHISPER_MODEL = {
  name: "ggml-large-v3-turbo-q8_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
  sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
  bytes: 874_188_075,
};

export function whisperModelPath(home = homedir()): string {
  return join(home, ".local/share/my-setup/whisper", WHISPER_MODEL.name);
}

const fileSchema = z.object({ file_path: z.string().min(1), file_size: z.number().optional() });
const whisperJsonSchema = z.object({
  result: z.object({ language: z.string() }).optional(),
  transcription: z.array(z.object({ text: z.string() })),
});

export interface Transcript {
  text: string;
  language: string;
  durationSeconds: number;
}

export function validateFileId(fileId: string): void {
  if (!/^[\w-]{10,200}$/.test(fileId)) throw new Error("File id must be a Telegram Bot API file_id");
}

export function ffmpegArgs(input: string, output: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-map_metadata",
    "-1",
    "-y",
    output,
  ];
}

export function whisperArgs(model: string, wav: string, outputBase: string): string[] {
  return ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np", "-oj", "-of", outputBase];
}

export function parseWhisperJson(json: string, durationSeconds: number): Transcript {
  const parsed = whisperJsonSchema.parse(JSON.parse(json));

  return {
    text: parsed.transcription
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(" "),
    language: parsed.result?.language ?? "unknown",
    durationSeconds,
  };
}

/** Duration of a 16 kHz mono 16-bit PCM WAV, read from its data chunk. */
export function wavDurationSeconds(wav: Buffer): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data")
      return Math.round((Math.min(size, wav.length - offset - 8) / 32_000) * 10) / 10;
    offset += 8 + size + (size % 2);
  }

  throw new Error("Converted audio has no WAV data chunk");
}

async function downloadTelegramFile(fileId: string, destination: string): Promise<void> {
  const file = fileSchema.safeParse(await telegramApi("getFile", { file_id: fileId }));
  if (!file.success) throw new Error("Telegram returned invalid file information");
  const { token } = credentials();

  try {
    // The file URL contains the bot token; never print or log it.
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.data.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new Error();
    await Bun.write(destination, response);
  } catch {
    throw new Error("Telegram file download failed; check credentials and connectivity");
  }
}

/** Downloads the Whisper model once, verifying its SHA-256 before it is used. */
export async function ensureWhisperModel(path = whisperModelPath()): Promise<string> {
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const hash = createHash("sha256");

  try {
    const response = await fetch(WHISPER_MODEL.url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(partial),
    );
  } catch (error) {
    rmSync(partial, { force: true });
    throw new Error(
      `Whisper model download failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (hash.digest("hex") !== WHISPER_MODEL.sha256) {
    rmSync(partial, { force: true });
    throw new Error("Whisper model checksum mismatch; deleted the download");
  }
  renameSync(partial, path);

  return path;
}

/** Transcribes a local audio file; pass `fileId` instead to fetch a Telegram voice note first. */
export async function transcribeAudio(source: { fileId?: string; file?: string }): Promise<Transcript> {
  if (!source.fileId === !source.file) throw new Error("Pass either a file id or --file <path>");
  if (source.fileId) validateFileId(source.fileId);
  if (source.file && !existsSync(source.file)) throw new Error("Audio file not found");
  for (const tool of ["whisper-cli", "ffmpeg"])
    if (!Bun.which(tool)) throw new Error(`${tool} is not installed; transcription is unavailable here`);

  const directory = mkdtempSync(join(tmpdir(), "telegram-transcribe-"));

  try {
    const input = source.file ?? join(directory, "voice");
    if (source.fileId) await downloadTelegramFile(source.fileId, input);
    const model = await ensureWhisperModel();

    const wav = join(directory, "voice.wav");
    const converted = await execa("ffmpeg", ffmpegArgs(input, wav), { reject: false, timeout: 120_000 });
    if (converted.exitCode !== 0) throw new Error("ffmpeg could not convert the audio");

    const outputBase = join(directory, "transcript");
    const transcribed = await execa("whisper-cli", whisperArgs(model, wav, outputBase), {
      reject: false,
      timeout: 600_000,
    });
    if (transcribed.exitCode !== 0) throw new Error("whisper-cli failed to transcribe the audio");

    return parseWhisperJson(
      readFileSync(`${outputBase}.json`, "utf8"),
      wavDurationSeconds(readFileSync(wav)),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
