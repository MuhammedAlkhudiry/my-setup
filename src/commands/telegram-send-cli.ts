#!/usr/bin/env bun

import { cac } from "cac";
import { MemoryStorage, TelegramClient } from "@mtcute/bun";
import { agentOutput } from "../lib/agent-output";
import {
  type BotFileClient,
  downloadTelegramMessageFile,
  readMtprotoApp,
} from "../lib/telegram-mtproto";
import {
  opsBotToken,
  checkTelegramWebhook,
  reactToTelegramMessage,
  sendTelegramMessage,
  telegramApi,
  transcribeAudio,
  validateRelayUrl,
} from "../lib/telegram";

agentOutput("telegram-send", { nativeJson: true, summary: (output) => output.trim() });

const json = process.argv.includes("--json");

function report(line: string): void {
  console.log(json ? JSON.stringify({ command: "telegram-send", status: "success", output: [line] }) : line);
}

function mtprotoBotClient(): BotFileClient {
  const tg = new TelegramClient({
    ...readMtprotoApp(),
    storage: new MemoryStorage(),
    updates: false,
    logLevel: 0 /* LogManager.OFF */,
  });

  return {
    signIn: async (session) => {
      if (session) await tg.importSession(session);
      await tg.start({ botToken: opsBotToken() });
      return tg.exportSession();
    },
    downloadMessageFile: async (chatId, messageId, path) => {
      const [message] = await tg.getMessages(chatId, [messageId]);
      const media = message?.media;
      if (!media || !("fileId" in media)) return false;
      await tg.downloadToFile(path, media);
      return true;
    },
    close: () => tg.destroy(),
  };
}

const cli = cac("telegram-send").option("--verbose", "Print detailed output");

cli
  .command("", "Send stdin as one plain-text message to the owner (maximum 4096 characters)")
  .action(async (options: { support?: boolean }) => {
    if (process.stdin.isTTY) throw new Error("Pipe the message into telegram-send");
    await sendTelegramMessage(await Bun.stdin.text(), options.support);
    report("telegram-send: sent");
  });
cli
  .command("react <messageId> [emoji]", "React to one of the owner's messages (default 👍) instead of replying")
  .action(async (messageId: string, emoji: string | undefined, options: { support?: boolean }) => {
    await reactToTelegramMessage(messageId, emoji, options.support);
    report("telegram-send: reacted");
  });
cli
  .command(
    "webhook <action> [url]",
    "check: read-only health; set <url>: repoint the T3 relay without dropping updates",
  )
  .action(async (action: string, url?: string) => {
    if (action === "check" && !url) {
      const pending = await checkTelegramWebhook();
      report(`telegram-send: ops bot healthy; ${pending} pending updates`);
      return;
    }
    if (action !== "set" || !url) throw new Error("Use webhook check or webhook set <url>");
    validateRelayUrl(url);
    await telegramApi("setWebhook", { url });
    report("telegram-send: webhook set");
  });
cli
  .command(
    "transcribe [fileId]",
    "Print the text of a Telegram voice note (Bot API file_id) or a local --file, transcribed locally",
  )
  .option("--file <path>", "Transcribe a local audio file instead of a Telegram file")
  .action(async (fileId: string | undefined, options: { file?: string }) => {
    const transcript = await transcribeAudio({ fileId, file: options.file });
    console.log(json ? JSON.stringify(transcript) : transcript.text || "telegram-send: no speech found");
  });
cli
  .command(
    "download <chatId> <messageId> <outPath>",
    "Download a message's file of up to 2 GB through the ops bot's MTProto session",
  )
  .action(async (chatId: string, messageId: string, outPath: string) => {
    const bytes = await downloadTelegramMessageFile(mtprotoBotClient(), chatId.trim(), messageId, outPath);
    report(`telegram-send: downloaded ${bytes} bytes`);
  });
cli.option("--json", "Return a structured receipt; transcribe returns {text, language, durationSeconds}");
cli.option("--support", "Send or react in the Awraq support group instead of the owner's chat");
cli.help();
cli.addEventListener("command:*", () => {
  throw new Error("Unknown command; run telegram-send --help");
});

try {
  // Group chat ids are negative; a leading space keeps cac from reading them as flags, and download trims it.
  cli.parse(
    process.argv.map((arg) => (/^-\d+$/.test(arg) ? ` ${arg}` : arg)),
    { run: false },
  );
  await cli.runMatchedCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Telegram command failed");
  process.exitCode = 1;
}
