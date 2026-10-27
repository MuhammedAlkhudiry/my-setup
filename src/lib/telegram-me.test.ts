import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approveDraft,
  countChats,
  createDraft,
  readDraft,
  renderPreview,
  sendDraft,
  type Chat,
  type ChatMessage,
  type TelegramMeClient,
  type TelegramMeContext,
} from "./telegram-me";

const SELF = 100;
const BOT = 900;
const CHATS: Chat[] = [
  { id: SELF, title: "Owner", type: "self" },
  { id: 200, title: "Sara", type: "user" },
  { id: -300, title: "Family", type: "group" },
  { id: BOT, title: "Ops Bot", type: "bot" },
];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A fake Telegram: the ops bot chat holds pushed previews, and the test plays the owner replying to them. */
function fakeTelegram() {
  const draftsDir = mkdtempSync(join(tmpdir(), "telegram-me-test-"));
  directories.push(draftsDir);
  const botChat: ChatMessage[] = [];
  const sent: Array<{ chatId: number; text: string }> = [];
  let nextId = 1;
  const message = (fields: Partial<ChatMessage>): ChatMessage => ({
    id: nextId++,
    date: new Date(),
    outgoing: false,
    senderId: BOT,
    senderName: "Ops Bot",
    text: "",
    replyToId: null,
    edited: false,
    ...fields,
  });
  const client: TelegramMeClient = {
    selfId: async () => SELF,
    chats: async () => CHATS,
    history: async (chatId) => (chatId === BOT ? [...botChat].reverse() : []),
    historyTotal: async () => ({ count: 0, date: null }),
    sendText: async (chatId, text) => {
      sent.push({ chatId, text });
      return nextId++;
    },
  };
  const context: TelegramMeContext = {
    client,
    botId: BOT,
    draftsDir,
    pushPreview: async (text) => {
      botChat.push(message({ text }));
    },
  };
  const ownerSays = (text: string, replyToId: number | null) =>
    botChat.push(
      message({
        outgoing: true,
        senderId: SELF,
        senderName: "Owner",
        text,
        replyToId,
      }),
    );
  const lastPreview = () => botChat.filter((entry) => !entry.outgoing).at(-1)!;

  return { context, botChat, sent, ownerSays, lastPreview, message };
}

test("a draft is sent only after the owner replies yes to its exact preview", async () => {
  const telegram = fakeTelegram();
  const draft = await createDraft(telegram.context, "sara", "  See you at 8  \n");

  expect(draft.text).toBe("See you at 8");
  expect(telegram.lastPreview().text).toBe(renderPreview(draft));
  expect(renderPreview(draft)).toContain(
    `Telegram draft ${draft.id}\nTo: Sara (user 200)\n\nSee you at 8`,
  );
  await expect(sendDraft(telegram.context, draft.id)).rejects.toThrow("not approved");
  await expect(approveDraft(telegram.context, draft.id)).rejects.toThrow('No "yes" reply');

  telegram.ownerSays("yes", null);
  await expect(approveDraft(telegram.context, draft.id)).rejects.toThrow('No "yes" reply');
  telegram.ownerSays("maybe later", telegram.lastPreview().id);
  await expect(approveDraft(telegram.context, draft.id)).rejects.toThrow('No "yes" reply');

  telegram.ownerSays("Yes!", telegram.lastPreview().id);
  await approveDraft(telegram.context, draft.id);
  const sent = await sendDraft(telegram.context, draft.id);

  expect(telegram.sent).toEqual([{ chatId: 200, text: "See you at 8" }]);
  expect(sent.sent?.messageId).toBeNumber();
  await expect(sendDraft(telegram.context, draft.id)).rejects.toThrow("already sent");
  expect(telegram.sent).toHaveLength(1);
});

test("editing the draft file, the preview, or approving another draft never sends", async () => {
  const telegram = fakeTelegram();
  const draft = await createDraft(telegram.context, "-300", "Dinner is at 9");
  telegram.ownerSays("yes", telegram.lastPreview().id);
  await approveDraft(telegram.context, draft.id);

  const path = join(telegram.context.draftsDir!, `${draft.id}.json`);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("Dinner is at 9", "Send me your password"));
  await expect(sendDraft(telegram.context, draft.id)).rejects.toThrow("no longer matches");
  writeFileSync(path, original.replace('"id": -300', '"id": 200'));
  await expect(sendDraft(telegram.context, draft.id)).rejects.toThrow("no longer matches");

  // A hand-written approval with no owner reply in Telegram is not an approval.
  const other = await createDraft(telegram.context, "Sara", "Running late");
  const otherPath = join(telegram.context.draftsDir!, `${other.id}.json`);
  writeFileSync(otherPath, JSON.stringify({ ...other, approvedAt: new Date().toISOString() }));
  await expect(sendDraft(telegram.context, other.id)).rejects.toThrow("no longer matches");

  // The bot can edit its preview, but an edited preview voids the owner's reply to it.
  writeFileSync(path, original);
  telegram.botChat.find((entry) => entry.text === renderPreview(draft))!.edited = true;
  await expect(sendDraft(telegram.context, draft.id)).rejects.toThrow("no longer matches");

  expect(telegram.sent).toEqual([]);
});

test("Saved Messages need no approval, but a tampered self draft cannot reach another chat", async () => {
  const telegram = fakeTelegram();
  const draft = await createDraft(telegram.context, "me", "note to self");

  expect(telegram.botChat).toEqual([]);
  await sendDraft(telegram.context, draft.id);
  expect(telegram.sent).toEqual([{ chatId: SELF, text: "note to self" }]);

  const forged = await createDraft(telegram.context, "me", "hello");
  const path = join(telegram.context.draftsDir!, `${forged.id}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace(`"id": ${SELF}`, '"id": 200'));
  await expect(sendDraft(telegram.context, forged.id)).rejects.toThrow("claims Saved Messages");
  expect(telegram.sent).toHaveLength(1);
});

test("drafts reject the ops bot chat, unknown or ambiguous chats, and empty or oversized text", async () => {
  const telegram = fakeTelegram();

  await expect(createDraft(telegram.context, "Ops Bot", "yes")).rejects.toThrow("ops bot");
  await expect(createDraft(telegram.context, "Nobody", "hi")).rejects.toThrow("No chat Nobody");
  await expect(createDraft(telegram.context, "Sara", "   ")).rejects.toThrow("nonempty");
  await expect(createDraft(telegram.context, "Sara", "x".repeat(4096))).rejects.toThrow("too long");
  await expect(
    createDraft(
      {
        ...telegram.context,
        client: {
          ...telegram.context.client,
          chats: async () => [...CHATS, { id: 201, title: "sara", type: "user" }],
        },
      },
      "Sara",
      "hi",
    ),
  ).rejects.toThrow("2 chats");
  expect(() => readDraft("../etc", telegram.context.draftsDir)).toThrow("Invalid draft id");
  expect(telegram.botChat).toEqual([]);
});

test("chat counts are paced, back off on FLOOD_WAIT, and sort largest first", async () => {
  const totals = new Map([
    [200, { count: 12, newest: "2026-10-01", oldest: "2019-03-04" }],
    [201, { count: 4800, newest: "2026-10-20", oldest: "2015-06-07" }],
    [202, { count: 0, newest: null, oldest: null }],
  ]);
  const calls: Array<{ chatId: number; oldest: boolean }> = [];
  const sleeps: number[] = [];
  let flooded = false;
  const client: TelegramMeClient = {
    selfId: async () => SELF,
    chats: async () => CHATS,
    history: async () => [],
    historyTotal: async (chatId, oldest = false) => {
      calls.push({ chatId, oldest });
      if (chatId === 201 && !flooded) {
        flooded = true;
        throw new Error("420: FLOOD_WAIT_7 (A wait of 7 seconds is required)");
      }
      const total = totals.get(chatId)!;
      const date = oldest ? total.oldest : total.newest;
      return { count: total.count, date: date ? new Date(date) : null };
    },
    sendText: async () => 0,
  };
  const chats: Chat[] = [200, 201, 202].map((id) => ({
    id,
    title: `P${id}`,
    type: "user",
  }));

  const counted = await countChats(client, chats, {
    paceMs: 250,
    top: 2,
    first: true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(
    counted.map(({ id, count, firstDate, lastDate }) => ({
      id,
      count,
      firstDate,
      lastDate,
    })),
  ).toEqual([
    {
      id: 201,
      count: 4800,
      firstDate: "2015-06-07T00:00:00.000Z",
      lastDate: "2026-10-20T00:00:00.000Z",
    },
    {
      id: 200,
      count: 12,
      firstDate: "2019-03-04T00:00:00.000Z",
      lastDate: "2026-10-01T00:00:00.000Z",
    },
  ]);
  // Oldest-message requests go only to the kept chats.
  expect(calls.filter((call) => call.oldest).map((call) => call.chatId)).toEqual([201, 200]);
  expect(sleeps).toEqual([250, 8000, 250, 250, 250, 250]);

  const stuck = {
    ...client,
    historyTotal: async () => Promise.reject(new Error("FLOOD_WAIT_3600")),
  };
  await expect(countChats(stuck, chats, { sleep: async () => {} })).rejects.toThrow("wait 3600s");
});
