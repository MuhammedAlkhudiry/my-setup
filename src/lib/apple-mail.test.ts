import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emlxCandidates,
  emlxMessage,
  htmlToText,
  listAccounts,
  openMailIndex,
  parseMailboxUrl,
  readMessage,
  searchMessages,
} from "./apple-mail";

const GMAIL = "imap://GMAIL-ID/%5BGmail%5D/All%20Mail";
const HOTMAIL = "ews://HOTMAIL-ID/Inbox";
const names = new Map([
  ["GMAIL-ID", "owner@gmail.com"],
  ["HOTMAIL-ID", "owner@hotmail.com"],
]);
const raw = [
  "From: Shop <orders@shop.test>",
  "To: owner@hotmail.com",
  "Subject: Receipt",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Total&nbsp;<b>SAR 50</b></p><br>&#x645;&#1585;&#x62D;&#x628;&#x627;",
].join("\r\n");

function emlx(message: string): Buffer {
  const body = Buffer.from(message);
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from("<?xml plist?>")]);
}

// The Mail index tables and columns these reads use, with one Gmail and two Hotmail messages.
function fixture(dir: string): string {
  const path = join(dir, "Envelope Index");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
    CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
    CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
    CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER);
    CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, mailbox INTEGER, sender INTEGER, subject INTEGER, subject_prefix TEXT,
      summary INTEGER, date_received INTEGER, read INTEGER, deleted INTEGER);
    INSERT INTO mailboxes VALUES (1, '${GMAIL}'), (2, 'imap://GMAIL-ID/INBOX'), (3, '${HOTMAIL}');
    INSERT INTO addresses VALUES (1, 'codes@service.test', 'Service'), (2, 'orders@shop.test', 'Shop');
    INSERT INTO subjects VALUES (1, 'Your code is 1234'), (2, 'Receipt'), (3, 'Old 100%_off');
    INSERT INTO summaries VALUES (1, 'Enter   the code'), (2, 'Total SAR 50');
    INSERT INTO messages VALUES
      (19317, 1, 1, 1, NULL, 1, 1793189980, 0, 0),
      (154, 3, 2, 2, 'Re: ', 2, 1715292000, 1, 0),
      (155, 3, 2, 3, NULL, NULL, 1700000000, 1, 1);
    INSERT INTO labels VALUES (19317, 2);
  `);
  db.close();

  return path;
}

test("mailbox URLs split into the account id and decoded folders", () => {
  expect(parseMailboxUrl(GMAIL)).toEqual({ accountId: "GMAIL-ID", folders: ["[Gmail]", "All Mail"] });
  expect(parseMailboxUrl("ews://HOTMAIL-ID/%D8%A7%D9%84%D9%85%D9%81%D8%B6%D9%84%D8%A9").folders).toEqual(["المفضلة"]);
  expect(parseMailboxUrl("local://LOCAL-ID")).toEqual({ accountId: "LOCAL-ID", folders: [] });
});

test("message files sit under the reversed thousands of the id, in every store", () => {
  const root = mkdtempSync(join(tmpdir(), "apple-mail-test-"));
  try {
    mkdirSync(join(root, "GMAIL-ID/[Gmail].mbox/All Mail.mbox/STORE/Data"), { recursive: true });
    mkdirSync(join(root, "HOTMAIL-ID/Inbox.mbox/STORE/Data"), { recursive: true });
    expect(emlxCandidates(root, GMAIL, 19317)).toEqual([
      join(root, "GMAIL-ID/[Gmail].mbox/All Mail.mbox/STORE/Data/9/1/Messages/19317.emlx"),
      join(root, "GMAIL-ID/[Gmail].mbox/All Mail.mbox/STORE/Data/9/1/Messages/19317.partial.emlx"),
    ]);
    expect(emlxCandidates(root, HOTMAIL, 154)[0]).toBe(
      join(root, "HOTMAIL-ID/Inbox.mbox/STORE/Data/Messages/154.emlx"),
    );
    expect(emlxCandidates(root, "ews://MISSING/Inbox", 1)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an .emlx file yields only the raw message, not the trailing property list", () => {
  expect(Buffer.from(emlxMessage(emlx(raw))).toString()).toBe(raw);
  expect(() => emlxMessage(Buffer.from("not mail"))).toThrow();
});

test("HTML bodies become plain text with entities decoded", () => {
  expect(htmlToText("<style>p{}</style><p>Total&nbsp;<b>SAR 50</b></p><br>&#x645;&#1585;&amp;")).toBe(
    "Total SAR 50\n\nمر&",
  );
});

test("accounts and searches skip deleted mail and show Gmail labels as folders", () => {
  const dir = mkdtempSync(join(tmpdir(), "apple-mail-test-"));
  try {
    const db = openMailIndex(fixture(dir));
    expect(listAccounts(db, names).map(({ name, messages }) => [name, messages]).sort()).toEqual([
      ["owner@gmail.com", 1],
      ["owner@hotmail.com", 1],
    ]);

    const [code] = searchMessages(db, { query: "code" }, names);
    expect(code).toMatchObject({
      id: 19317,
      account: "owner@gmail.com",
      mailboxes: ["INBOX"],
      from: "Service <codes@service.test>",
      preview: "Enter the code",
      unread: true,
    });
    expect(searchMessages(db, { account: "hotmail" }, names).map((message) => message.id)).toEqual([154]);
    expect(searchMessages(db, { from: "shop", since: "2024-05-01", until: "2024-05-10" }, names)).toHaveLength(1);
    expect(searchMessages(db, { query: "100%_" }, names)).toEqual([]);
    expect(searchMessages(db, { unread: true, mailbox: "inbox" }, names)).toHaveLength(1);
    expect(() => searchMessages(db, { since: "May 1" }, names)).toThrow("YYYY-MM-DD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading a message parses its file, or reports a body Mail has not downloaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apple-mail-test-"));
  try {
    const db = openMailIndex(fixture(dir));
    const messages = join(dir, "HOTMAIL-ID/Inbox.mbox/STORE/Data/Messages");
    mkdirSync(messages, { recursive: true });
    writeFileSync(join(messages, "154.partial.emlx"), emlx(raw));

    const receipt = await readMessage(db, 154, names, dir);
    expect(receipt).toMatchObject({
      subject: "Re: Receipt",
      to: ["owner@hotmail.com"],
      text: "Total SAR 50\n\nمرحبا",
      bodyMissing: false,
    });
    expect((await readMessage(db, 19317, names, dir))?.bodyMissing).toBe(true);
    expect(await readMessage(db, 999, names, dir)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
