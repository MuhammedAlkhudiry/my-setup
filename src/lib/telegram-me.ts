// Sends Telegram messages as the owner, but only the exact recipient and text the owner approved. `draft` stores the message
// and sends its preview to the owner through the ops bot; the owner approves by replying "yes" to that preview in Telegram.
// Approval is read from Telegram itself on every send: the reply must come from the owner's signed-in account and answer an
// unedited preview whose text still matches the draft. Agents cannot write as the owner without this flow, so editing a
// draft file, re-sending a preview, or editing the bot's message never produces an approval.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

export const KEYCHAIN_SERVICE = "telegram-me";
const MAX_MESSAGE = 4096;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const APPROVAL_REPLY = /^(yes|y|send|send it|ok|okay|approve|approved|نعم|أرسل|ارسل)[.!]*$/i;

export const CHAT_TYPES = [
  "self",
  "user",
  "bot",
  "deleted",
  "group",
  "supergroup",
  "channel",
  "other",
] as const;
const chatSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  type: z.enum(CHAT_TYPES),
});
const draftSchema = z.object({
  id: z.string(),
  chat: chatSchema,
  text: z.string(),
  createdAt: z.string(),
  approvedAt: z.string().optional(),
  sent: z.object({ messageId: z.number().int(), at: z.string() }).optional(),
});

export type Chat = z.infer<typeof chatSchema>;
export type Draft = z.infer<typeof draftSchema>;

export interface ChatMessage {
  id: number;
  date: Date;
  outgoing: boolean;
  senderId: number;
  senderName: string;
  text: string;
  replyToId: number | null;
  edited: boolean;
}

/** A chat's size from one history request: Telegram reports the total alongside the newest (or oldest) message. */
export interface HistoryTotal {
  count: number;
  date: Date | null;
}

export interface ChatCount extends Chat {
  count: number;
  lastDate: string | null;
  firstDate?: string | null;
}

/** The slice of the MTProto client the flow uses, so tests can pass a mock. */
export interface TelegramMeClient {
  selfId(): Promise<number>;
  chats(): Promise<Chat[]>;
  /** Newest first. */
  history(chatId: number, limit: number): Promise<ChatMessage[]>;
  /** The message total and the date of the newest message, or the oldest with `oldest`. */
  historyTotal(chatId: number, oldest?: boolean): Promise<HistoryTotal>;
  sendText(chatId: number, text: string): Promise<number>;
}

export interface TelegramMeContext {
  client: TelegramMeClient;
  /** The ops bot's user id: its chat with the owner carries previews and approvals. */
  botId: number;
  pushPreview(text: string): Promise<void>;
  draftsDir?: string;
  now?: () => Date;
}

/** Whether a session is stored, without printing it. */
export async function hasTelegramMeSession(): Promise<boolean> {
  return Boolean(await Bun.secrets.get({ service: KEYCHAIN_SERVICE, name: "session" }));
}

export function telegramMeStateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "telegram-me");
}

function draftsDirOf(context: { draftsDir?: string }): string {
  return context.draftsDir ?? join(telegramMeStateDir(), "drafts");
}

function draftPath(directory: string, id: string): string {
  if (!/^[a-z0-9]{6}$/.test(id)) throw new Error(`Invalid draft id ${id}`);
  return join(directory, `${id}.json`);
}

export function readDraft(id: string, directory = draftsDirOf({})): Draft | undefined {
  const path = draftPath(directory, id);
  if (!existsSync(path)) return undefined;
  return draftSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function loadDraft(context: TelegramMeContext, id: string): Draft {
  const draft = readDraft(id, draftsDirOf(context));
  if (!draft) throw new Error(`No draft ${id}; create one with telegram-me draft`);
  return draft;
}

function saveDraft(context: TelegramMeContext, draft: Draft): void {
  const directory = draftsDirOf(context);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(draftPath(directory, draft.id), `${JSON.stringify(draft, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Saved Messages reach only the owner, so they need no approval. */
export function needsApproval(draft: Draft): boolean {
  return draft.chat.type !== "self";
}

export function describeChat(chat: Chat): string {
  return chat.type === "self" ? "Saved Messages (you)" : `${chat.title} (${chat.type} ${chat.id})`;
}

/** The exact preview text; approval holds only while the bot's message still equals it. */
export function renderPreview(draft: Draft): string {
  return [
    `Telegram draft ${draft.id}`,
    `To: ${describeChat(draft.chat)}`,
    "",
    draft.text,
    "",
    'Reply "yes" to this message to send it as you.',
  ].join("\n");
}

/** Resolves a chat by id, "me", or exact title; ambiguous or missing titles fail rather than guess. */
export function findChat(chats: Chat[], reference: string): Chat {
  const wanted = reference.trim();
  if (/^(me|self|saved)$/i.test(wanted)) {
    const self = chats.find((chat) => chat.type === "self");
    if (self) return self;
  }
  const matches = /^-?\d+$/.test(wanted)
    ? chats.filter((chat) => chat.id === Number(wanted))
    : chats.filter((chat) => chat.title.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Error(
      `${matches.length} chats are titled ${wanted}; use an id from telegram-me chats`,
    );
  throw new Error(`No chat ${wanted}; find its id with telegram-me chats --search`);
}

function newDraftId(): string {
  return [...randomBytes(6)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

export async function createDraft(
  context: TelegramMeContext,
  reference: string,
  input: string,
): Promise<Draft> {
  const text = input.trim();
  if (!text) throw new Error("Pipe a nonempty message into telegram-me draft");

  const chat = findChat(await context.client.chats(), reference);
  if (chat.id === context.botId)
    throw new Error("The ops bot chat carries approvals; drafts cannot go there");
  const draft: Draft = {
    id: newDraftId(),
    chat,
    text,
    createdAt: (context.now?.() ?? new Date()).toISOString(),
  };
  if ([...renderPreview(draft)].length > MAX_MESSAGE)
    throw new Error("Message too long for its preview; shorten it, messages are never truncated");

  if (needsApproval(draft)) await context.pushPreview(renderPreview(draft));
  saveDraft(context, draft);
  return draft;
}

/** The owner's "yes" reply to an unedited preview of this exact draft, read from the ops bot chat. */
async function findApproval(
  context: TelegramMeContext,
  draft: Draft,
): Promise<ChatMessage | undefined> {
  const messages = await context.client.history(context.botId, 100);
  const preview = renderPreview(draft);
  const previews = new Set(
    messages
      .filter((message) => !message.outgoing && message.senderId === context.botId)
      .filter((message) => !message.edited && message.text === preview)
      .map((message) => message.id),
  );
  return messages.find(
    (message) =>
      message.outgoing &&
      message.replyToId !== null &&
      previews.has(message.replyToId) &&
      APPROVAL_REPLY.test(message.text.trim()),
  );
}

export async function approveDraft(context: TelegramMeContext, id: string): Promise<Draft> {
  const draft = loadDraft(context, id);
  if (draft.sent) throw new Error(`Draft ${id} was already sent`);
  if (needsApproval(draft) && !(await findApproval(context, draft)))
    throw new Error(
      `No "yes" reply from the owner to the Telegram preview of draft ${id}; it stays unapproved`,
    );

  const approved = {
    ...draft,
    approvedAt: (context.now?.() ?? new Date()).toISOString(),
  };
  saveDraft(context, approved);
  return approved;
}

export async function sendDraft(context: TelegramMeContext, id: string): Promise<Draft> {
  const draft = loadDraft(context, id);
  if (draft.sent) throw new Error(`Draft ${id} was already sent`);
  if (needsApproval(draft)) {
    if (!draft.approvedAt)
      throw new Error(
        `Draft ${id} is not approved; run telegram-me approve ${id} after the owner's yes`,
      );
    // The draft file is only a record; Telegram holds the proof, so a hand-edited file never sends.
    if (!(await findApproval(context, draft)))
      throw new Error(
        `The owner's approval of draft ${id} no longer matches its text; draft it again`,
      );
  } else if (draft.chat.id !== (await context.client.selfId())) {
    throw new Error(`Draft ${id} claims Saved Messages but targets another chat`);
  }

  // One send per draft, even when two agents race: the lock file is created exclusively and never removed.
  const lock = `${draftPath(draftsDirOf(context), id)}.sending`;
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    throw new Error(`Draft ${id} is already being sent or was sent`);
  }

  const messageId = await context.client.sendText(draft.chat.id, draft.text);
  const sent = {
    ...draft,
    sent: { messageId, at: (context.now?.() ?? new Date()).toISOString() },
  };
  saveDraft(context, sent);
  return sent;
}

export interface CountOptions {
  /** Pause between requests so a few hundred chats stay under Telegram's rate limits. */
  paceMs?: number;
  /** Also fetch each chat's oldest message date, at one more request per chat. */
  first?: boolean;
  /** Keep only the largest chats; first dates are fetched only for these. */
  top?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_FLOOD_WAIT_SECONDS = 600;

/** Telegram's FLOOD_WAIT_X asks the client to wait X seconds before the next call. */
function floodWaitSeconds(error: unknown): number | undefined {
  const match = /FLOOD_WAIT_(\d+)/.exec(error instanceof Error ? error.message : String(error));
  return match ? Number(match[1]) : undefined;
}

/** Message totals per chat, largest first, paced and backing off whenever Telegram asks. */
export async function countChats(
  client: TelegramMeClient,
  chats: Chat[],
  options: CountOptions = {},
): Promise<ChatCount[]> {
  const { paceMs = 300, sleep = Bun.sleep } = options;
  let calls = 0;
  const paced = async (chatId: number, oldest: boolean): Promise<HistoryTotal> => {
    for (;;) {
      if (calls++ > 0) await sleep(paceMs);
      try {
        return await client.historyTotal(chatId, oldest);
      } catch (error) {
        const seconds = floodWaitSeconds(error);
        if (seconds === undefined) throw error;
        if (seconds > MAX_FLOOD_WAIT_SECONDS)
          throw new Error(
            `Telegram asked to wait ${seconds}s; retry telegram-me chats --counts later`,
          );
        await sleep((seconds + 1) * 1000);
      }
    }
  };

  const counted: ChatCount[] = [];
  for (const chat of chats) {
    const { count, date } = await paced(chat.id, false);
    counted.push({ ...chat, count, lastDate: date?.toISOString() ?? null });
  }
  counted.sort((a, b) => b.count - a.count);
  const kept = options.top ? counted.slice(0, options.top) : counted;

  if (options.first)
    for (const chat of kept)
      chat.firstDate = chat.count
        ? ((await paced(chat.id, true)).date?.toISOString() ?? null)
        : null;
  return kept;
}
