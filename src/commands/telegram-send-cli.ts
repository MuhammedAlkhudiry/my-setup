#!/usr/bin/env bun

import { cac } from "cac";
import { agentOutput } from "../lib/agent-output";
import {
  checkTelegramWebhook,
  sendTelegramMessage,
  telegramApi,
  validateRelayUrl,
} from "../lib/telegram";

agentOutput("telegram-send", { summary: (output) => output.trim() });

const cli = cac("telegram-send").option("--verbose", "Print detailed output");

cli
  .command("", "Send stdin as one plain-text message to the owner (maximum 4096 characters)")
  .action(async () => {
    if (process.stdin.isTTY) throw new Error("Pipe the message into telegram-send");
    await sendTelegramMessage(await Bun.stdin.text());
    console.log("telegram-send: sent");
  });
cli
  .command(
    "webhook <action> [url]",
    "check: read-only health; set <url>: repoint the T3 relay without dropping updates",
  )
  .action(async (action: string, url?: string) => {
    if (action === "check" && !url) {
      const pending = await checkTelegramWebhook();
      console.log(`telegram-send: ops bot healthy; ${pending} pending updates`);
      return;
    }
    if (action !== "set" || !url) throw new Error("Use webhook check or webhook set <url>");
    validateRelayUrl(url);
    await telegramApi("setWebhook", { url });
    console.log("telegram-send: webhook set");
  });
cli.option("--json", "Return a structured receipt");
cli.help();
cli.addEventListener("command:*", () => {
  throw new Error("Unknown command; run telegram-send --help");
});

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Telegram command failed");
  process.exitCode = 1;
}
