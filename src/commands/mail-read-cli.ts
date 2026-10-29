#!/usr/bin/env bun

// Searches and reads the owner's email that the Mail app has synced on the main Mac; see src/lib/apple-mail.ts.

import { cac } from "cac";

import { parseCli } from "../lib/agent-output";
import {
  listAccounts,
  openMailIndex,
  readMessage,
  searchMessages,
  type MailSummary,
} from "../lib/apple-mail";

const json = process.argv.includes("--json");

function localTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function printSummary(message: MailSummary): void {
  const unread = message.unread ? " [unread]" : "";
  console.log(
    `${message.id}  ${localTime(message.date)}  ${message.account}  ${message.mailboxes.join(", ")}${unread}`,
  );
  console.log(`  from: ${message.from}`);
  console.log(`  subject: ${message.subject}`);
  if (message.preview) console.log(`  preview: ${message.preview.slice(0, 200)}`);
}

async function run(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`mail-read: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const cli = cac("mail-read")
  .option("--json", "Print JSON")
  .option("--verbose", "Print detailed output");

cli
  .command("accounts", "List synced accounts with message counts and the newest message date")
  .action(() =>
    run(() => {
      const accounts = listAccounts(openMailIndex());
      if (json) return console.log(JSON.stringify(accounts));

      for (const account of accounts)
        console.log(
          `${account.name}: ${account.messages} messages, newest ${account.lastReceived ? localTime(account.lastReceived) : "none"}`,
        );
    }),
  );

cli
  .command("search [query]", "Newest first; the query matches subject, sender, and body preview")
  .option("--from <text>", "Sender address or name contains")
  .option("--account <text>", "Account address contains, such as gmail or hotmail")
  .option("--mailbox <text>", "Folder or Gmail label contains, such as INBOX")
  .option("--since <date>", "Received on or after YYYY-MM-DD")
  .option("--until <date>", "Received on or before YYYY-MM-DD")
  .option("--unread", "Only unread messages")
  .option("--limit <n>", "Maximum results", { default: 20 })
  .action((query: string | undefined, options) =>
    run(() => {
      const messages = searchMessages(openMailIndex(), {
        query,
        from: options.from,
        account: options.account,
        mailbox: options.mailbox,
        since: options.since,
        until: options.until,
        unread: options.unread,
        limit: Number(options.limit),
      });
      if (json) return console.log(JSON.stringify(messages));
      if (messages.length === 0) return console.log("mail-read: no messages match");

      messages.forEach(printSummary);
    }),
  );

cli
  .command("read <id>", "Print one message's headers, text body, and attachment names")
  .action((id: string) =>
    run(async () => {
      const message = await readMessage(openMailIndex(), Number(id));
      if (!message) throw new Error(`no message ${id}`);
      if (json) return console.log(JSON.stringify(message));

      printSummary({ ...message, preview: "" });
      if (message.to.length) console.log(`  to: ${message.to.join(", ")}`);
      if (message.cc.length) console.log(`  cc: ${message.cc.join(", ")}`);
      for (const attachment of message.attachments)
        console.log(`  attachment: ${attachment.filename} (${attachment.mimeType})`);
      console.log("");
      console.log(
        message.bodyMissing
          ? `Mail has not downloaded this body; preview: ${message.preview}`
          : message.text,
      );
    }),
  );

cli.help();
parseCli(cli);
