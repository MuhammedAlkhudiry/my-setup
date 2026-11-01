import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTelegramWebhook,
  ffmpegArgs,
  parseWhisperJson,
  reactToTelegramMessage,
  sendTelegramMessage,
  telegramApi,
  transcribeAudio,
  validateFileId,
  validateRelayUrl,
  wavDurationSeconds,
  whisperArgs,
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
    await expect(reactToTelegramMessage("abc")).rejects.toThrow("positive integer");
    await expect(sendTelegramMessage("hi", true)).rejects.toThrow("No support_chat_id");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.SERVICE_CREDENTIALS_HOME;
    else process.env.SERVICE_CREDENTIALS_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transcription validates sources and builds ffmpeg and whisper arguments", async () => {
  expect(() => validateFileId("AwACAgQAAxkBAAIB")).not.toThrow();
  expect(() => validateFileId("../etc/passwd")).toThrow("file_id");
  await expect(transcribeAudio({})).rejects.toThrow("either a file id or --file");
  await expect(transcribeAudio({ fileId: "AwACAgQAAxkBAAIB", file: "/tmp/a.ogg" })).rejects.toThrow(
    "either a file id or --file",
  );
  await expect(transcribeAudio({ file: "/missing/voice.ogg" })).rejects.toThrow("not found");

  expect(ffmpegArgs("in.oga", "out.wav")).toEqual([
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "in.oga",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-map_metadata",
    "-1",
    "-y",
    "out.wav",
  ]);
  expect(whisperArgs("model.bin", "voice.wav", "out")).toEqual([
    "-m",
    "model.bin",
    "-f",
    "voice.wav",
    "-l",
    "auto",
    "-nt",
    "-np",
    "-oj",
    "-of",
    "out",
  ]);
});

test("transcription output joins segments and reads WAV duration", () => {
  expect(
    parseWhisperJson(
      JSON.stringify({
        result: { language: "ar" },
        transcription: [{ text: " السلام عليكم." }, { text: " " }, { text: " كيف الحال؟" }],
      }),
      3.5,
    ),
  ).toEqual({ text: "السلام عليكم. كيف الحال؟", language: "ar", durationSeconds: 3.5 });
  expect(parseWhisperJson(JSON.stringify({ transcription: [] }), 0).language).toBe("unknown");

  const data = Buffer.alloc(64_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  expect(wavDurationSeconds(Buffer.concat([header, data]))).toBe(2);
  expect(() => wavDurationSeconds(header.subarray(0, 36))).toThrow("no WAV data chunk");
});
