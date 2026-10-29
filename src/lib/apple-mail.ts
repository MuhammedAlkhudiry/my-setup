// Read-only access to the mail the macOS Mail app has synced: its message index and the .emlx files beside it.
// Nothing here talks to a mail server, so reading never marks mail as read, moves, or deletes it.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import PostalMime from "postal-mime";

export const MAIL_ROOT = join(homedir(), "Library/Mail/V10");
export const MAIL_INDEX = join(MAIL_ROOT, "MailData/Envelope Index");
const ACCOUNTS_DB = join(homedir(), "Library/Accounts/Accounts4.sqlite");

export interface MailAccount {
  id: string;
  name: string;
  messages: number;
  lastReceived: string | null;
}

export interface MailSummary {
  id: number;
  account: string;
  mailboxes: string[];
  date: string;
  from: string;
  subject: string;
  preview: string;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  to: string[];
  cc: string[];
  text: string;
  attachments: { filename: string; mimeType: string }[];
  bodyMissing: boolean;
}

export interface SearchOptions {
  query?: string;
  from?: string;
  account?: string;
  mailbox?: string;
  since?: string;
  until?: string;
  unread?: boolean;
  limit?: number;
}

interface Row {
  id: number;
  url: string;
  date_received: number;
  address: string | null;
  comment: string | null;
  subject: string | null;
  subject_prefix: string | null;
  summary: string | null;
  read: number;
  labels: string | null;
}

export function openMailIndex(path = MAIL_INDEX): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (error) {
    throw new Error(
      `cannot open the Mail index at ${path} (${(error as Error).message}); Mail must be set up on this Mac and the terminal or agent host needs Full Disk Access`,
    );
  }
}

/** Account id → email address, from the macOS accounts store; Gmail keeps the address on its parent Google account. */
export function readAccountNames(path = ACCOUNTS_DB): Map<string, string> {
  const names = new Map<string, string>();
  if (!existsSync(path)) return names;

  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<{ id: string; name: string | null }, []>(
        `SELECT a.ZIDENTIFIER AS id, COALESCE(NULLIF(a.ZUSERNAME, ''), p.ZUSERNAME) AS name
         FROM ZACCOUNT a LEFT JOIN ZACCOUNT p ON p.Z_PK = a.ZPARENTACCOUNT`,
      )
      .all();
    for (const row of rows) if (row.name) names.set(row.id, row.name);
  } finally {
    db.close();
  }

  return names;
}

/** Splits a Mail mailbox URL such as `imap://<account>/%5BGmail%5D/All%20Mail` into its account id and folder path. */
export function parseMailboxUrl(url: string): { accountId: string; folders: string[] } {
  const match = /^[a-z]+:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!match) return { accountId: url, folders: [] };

  return {
    accountId: match[1]!,
    folders: match[2] ? match[2].split("/").map((part) => decodeURIComponent(part)) : [],
  };
}

function folderName(url: string): string {
  return parseMailboxUrl(url).folders.join("/") || url;
}

function accountName(url: string, names: Map<string, string>): string {
  if (url.startsWith("local://")) return "On My Mac";

  const { accountId } = parseMailboxUrl(url);
  return names.get(accountId) ?? accountId;
}

export function listAccounts(db: Database, names = readAccountNames()): MailAccount[] {
  const rows = db
    .query<{ url: string; messages: number; last: number | null }, []>(
      `SELECT mb.url, COUNT(*) AS messages, MAX(m.date_received) AS last
       FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox
       WHERE m.deleted = 0 GROUP BY mb.url`,
    )
    .all();
  const accounts = new Map<string, MailAccount>();
  for (const row of rows) {
    const id = parseMailboxUrl(row.url).accountId;
    const account = accounts.get(id) ?? {
      id,
      name: accountName(row.url, names),
      messages: 0,
      lastReceived: null,
    };
    account.messages += row.messages;
    const last = row.last ? isoDate(row.last) : null;
    if (last && (!account.lastReceived || last > account.lastReceived)) account.lastReceived = last;
    accounts.set(id, account);
  }

  return [...accounts.values()].sort((a, b) => b.messages - a.messages);
}

const SELECT_MESSAGES = `SELECT m.ROWID AS id, mb.url, m.date_received, a.address, a.comment, s.subject, m.subject_prefix,
    su.summary, m.read,
    (SELECT group_concat(lb.url, char(10)) FROM labels l JOIN mailboxes lb ON lb.ROWID = l.mailbox_id
     WHERE l.message_id = m.ROWID) AS labels
  FROM messages m
  JOIN mailboxes mb ON mb.ROWID = m.mailbox
  LEFT JOIN addresses a ON a.ROWID = m.sender
  LEFT JOIN subjects s ON s.ROWID = m.subject
  LEFT JOIN summaries su ON su.ROWID = m.summary`;

export function searchMessages(
  db: Database,
  options: SearchOptions,
  names = readAccountNames(),
): MailSummary[] {
  const where = ["m.deleted = 0"];
  const params: (string | number)[] = [];
  const like = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  if (options.query) {
    where.push(
      "(s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR su.summary LIKE ? ESCAPE '\\')",
    );
    params.push(...Array(4).fill(like(options.query)));
  }
  if (options.from) {
    where.push("(a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')");
    params.push(like(options.from), like(options.from));
  }
  if (options.since) {
    where.push("m.date_received >= ?");
    params.push(unixSeconds(options.since));
  }
  if (options.until) {
    where.push("m.date_received < ?");
    params.push(unixSeconds(options.until) + 86_400);
  }
  if (options.unread) where.push("m.read = 0");

  // Account and folder names come from outside SQLite, so those filters run on the rows; scan in pages until the limit fills.
  const limit = options.limit ?? 20;
  const results: MailSummary[] = [];
  const page = 500;
  const statement = db.query<Row, (string | number)[]>(
    `${SELECT_MESSAGES} WHERE ${where.join(" AND ")} ORDER BY m.date_received DESC LIMIT ? OFFSET ?`,
  );
  for (let offset = 0; results.length < limit; offset += page) {
    const rows = statement.all(...params, page, offset);
    for (const row of rows) {
      const summary = toSummary(row, names);
      if (options.account && !contains(summary.account, options.account)) continue;
      if (
        options.mailbox &&
        !summary.mailboxes.some((mailbox) => contains(mailbox, options.mailbox!))
      )
        continue;
      results.push(summary);
      if (results.length === limit) break;
    }
    if (rows.length < page) break;
  }

  return results;
}

export async function readMessage(
  db: Database,
  id: number,
  names = readAccountNames(),
  root = MAIL_ROOT,
): Promise<MailMessage | undefined> {
  const row = db.query<Row, [number]>(`${SELECT_MESSAGES} WHERE m.ROWID = ?`).get(id);
  if (!row) return undefined;

  const summary = toSummary(row, names);
  const file = findEmlx(root, row.url, id);
  if (!file)
    return { ...summary, to: [], cc: [], text: "", attachments: [], bodyMissing: true };

  const email = await PostalMime.parse(emlxMessage(readFileSync(file)));
  const addresses = (list: typeof email.to) =>
    (list ?? []).map((entry) =>
      "address" in entry && entry.address
        ? formatAddress(entry.address, entry.name)
        : entry.name,
    );

  return {
    ...summary,
    to: addresses(email.to),
    cc: addresses(email.cc),
    text: email.text?.trim() || htmlToText(email.html ?? ""),
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename ?? "(unnamed)",
      mimeType: attachment.mimeType,
    })),
    bodyMissing: false,
  };
}

/**
 * Mail stores message 19317 of `[Gmail]/All Mail` at
 * `<account>/[Gmail].mbox/All Mail.mbox/<store>/Data/9/1/Messages/19317.emlx`: the thousands of the id, digits reversed.
 * Bodies Mail has not fully downloaded end in `.partial.emlx`.
 */
export function emlxCandidates(root: string, url: string, id: number): string[] {
  const { accountId, folders } = parseMailboxUrl(url);
  const mailboxDir = join(root, accountId, ...folders.map((folder) => `${folder}.mbox`));
  if (!existsSync(mailboxDir)) return [];

  const thousands = Math.floor(id / 1000);
  const buckets = thousands > 0 ? String(thousands).split("").reverse() : [];
  const stores = readdirSync(mailboxDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".mbox"))
    .map((entry) => entry.name);

  return stores.flatMap((store) =>
    [`${id}.emlx`, `${id}.partial.emlx`].map((name) =>
      join(mailboxDir, store, "Data", ...buckets, "Messages", name),
    ),
  );
}

function findEmlx(root: string, url: string, id: number): string | undefined {
  return emlxCandidates(root, url, id).find((path) => existsSync(path));
}

/** An .emlx file is the message's byte length on the first line, the raw message, then an Apple property list. */
export function emlxMessage(file: Uint8Array): Uint8Array {
  const newline = file.indexOf(0x0a);
  const length = Number(new TextDecoder().decode(file.subarray(0, newline)).trim());
  if (newline < 0 || !Number.isInteger(length)) throw new Error("not an .emlx file");

  return file.subarray(newline + 1, newline + 1 + length);
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  zwnj: "",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] === "#")
        return String.fromCodePoint(
          code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
        );
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toSummary(row: Row, names: Map<string, string>): MailSummary {
  const labels = row.labels ? row.labels.split("\n").map(folderName) : [];

  return {
    id: row.id,
    account: accountName(row.url, names),
    mailboxes: labels.length > 0 ? labels : [folderName(row.url)],
    date: isoDate(row.date_received),
    from: row.address ? formatAddress(row.address, row.comment) : "",
    subject: `${row.subject_prefix ?? ""}${row.subject ?? ""}`,
    preview: (row.summary ?? "").replace(/\s+/g, " ").trim(),
    unread: row.read === 0,
  };
}

function formatAddress(address: string, name: string | null | undefined): string {
  return name && name !== address ? `${name} <${address}>` : address;
}

function contains(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function unixSeconds(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`dates use YYYY-MM-DD, got ${date}`);

  return Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000);
}
