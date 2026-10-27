#!/usr/bin/env bun

// Reads the owner's Telegram chats and sends messages as the owner after their approval; see src/lib/telegram-me.ts.

import { homedir } from "node:os";

import { MemoryStorage, TelegramClient, type Peer } from "@mtcute/bun";
import { cac } from "cac";
import { z } from "zod";

import { agentOutput } from "../lib/agent-output";
import { readDeviceProfile, readRemoteClaudePoolUrl } from "../lib/device";
import { opsBot, sendTelegramMessage } from "../lib/telegram";
import {
  approveDraft,
  CHAT_TYPES,
  countChats,
  createDraft,
  describeChat,
  findChat,
  KEYCHAIN_SERVICE,
  sendDraft,
  type Chat,
  type ChatCount,
  type ChatMessage,
  type Draft,
  type TelegramMeClient,
} from "../lib/telegram-me";

agentOutput("telegram-me", {
  nativeJson: true,
  summary: (output) => output.trim(),
});

const json = process.argv.includes("--json");
const apiSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().regex(/^[0-9a-f]{32}$/),
});

// The session stays in this Mac's login Keychain: never in files, never copied to spare Macs.
const keychain = {
  api: { service: KEYCHAIN_SERVICE, name: "api" },
  session: { service: KEYCHAIN_SERVICE, name: "session" },
};

function requireMainMac(): void {
  const home = homedir();
  if (readDeviceProfile(home).name !== "personal" || readRemoteClaudePoolUrl(home))
    throw new Error("telegram-me runs only on the main Mac, which holds the owner's session");
}

async function readApi(): Promise<z.infer<typeof apiSchema> | undefined> {
  const stored = await Bun.secrets.get(keychain.api);
  return stored ? apiSchema.parse(JSON.parse(stored)) : undefined;
}

function chatOf(peer: Peer): Chat {
  if (peer.type === "user")
    return {
      id: peer.id,
      title: peer.displayName,
      type: peer.isSelf ? "self" : peer.isBot ? "bot" : peer.isDeleted ? "deleted" : "user",
    };
  const type = ["group", "supergroup", "channel"].includes(peer.chatType) ? peer.chatType : "other";
  return { id: peer.id, title: peer.displayName, type: type as Chat["type"] };
}

function newClient(api: z.infer<typeof apiSchema>): TelegramClient {
  return new TelegramClient({
    ...api,
    storage: new MemoryStorage(),
    updates: false,
    logLevel: 0 /* LogManager.OFF */,
  });
}

async function withClient<T>(run: (client: TelegramMeClient) => Promise<T>): Promise<T> {
  const api = await readApi();
  const session = await Bun.secrets.get(keychain.session);
  if (!api || !session) throw new Error("Not signed in; run telegram-me login on the main Mac");

  const tg = newClient(api);
  let chats: Chat[] | undefined;
  // Memory storage starts empty, so loading the dialogs first lets later calls resolve chats by id.
  const loadChats = async () => {
    if (!chats) {
      chats = [];
      for await (const dialog of tg.iterDialogs()) chats.push(chatOf(dialog.peer));
    }
    return chats;
  };
  const client: TelegramMeClient = {
    selfId: async () => (await tg.getMe()).id,
    chats: loadChats,
    history: async (chatId, limit) => {
      await loadChats();
      return (await tg.getHistory(chatId, { limit })).map(
        (message): ChatMessage => ({
          id: message.id,
          date: message.date,
          outgoing: message.isOutgoing,
          senderId: message.sender.id,
          senderName: message.sender.displayName,
          text: message.text,
          replyToId: message.replyToMessage?.id ?? null,
          edited: message.editDate !== null,
        }),
      );
    },
    historyTotal: async (chatId, oldest = false) => {
      await loadChats();
      const page = await tg.getHistory(chatId, { limit: 1, reverse: oldest });
      return { count: page.total, date: page[0]?.date ?? null };
    },
    sendText: async (chatId, text) => {
      await loadChats();
      return (await tg.sendText(chatId, text)).id;
    },
  };

  try {
    await tg.importSession(session);
    await tg.connect();
    return await run(client);
  } finally {
    await tg.destroy();
  }
}

async function context<T>(
  run: (context: Parameters<typeof approveDraft>[0]) => Promise<T>,
): Promise<T> {
  return withClient((client) =>
    run({
      client,
      botId: opsBot().botId,
      pushPreview: async (text) => {
        await sendTelegramMessage(text);
      },
    }),
  );
}

/** A native macOS prompt, so codes and passwords go straight from the owner into this process. */
async function ask(prompt: string, hidden = false): Promise<string> {
  const script = [
    `set answer to display dialog ${JSON.stringify(prompt)} default answer "" ${hidden ? "with hidden answer " : ""}with title "telegram-me login" buttons {"Cancel", "OK"} default button "OK" giving up after 600`,
    "if gave up of answer then error number -128",
    "text returned of answer",
  ];
  const result = Bun.spawnSync(["osascript", ...script.flatMap((line) => ["-e", line])]);
  const value = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !value) throw new Error("Login cancelled at the macOS prompt");
  return value;
}

function printDraft(draft: Draft, verb: string): void {
  if (json) {
    console.log(JSON.stringify(draft));
    return;
  }
  console.log(`telegram-me: ${verb} draft ${draft.id} to ${describeChat(draft.chat)}`);
  if (verb === "created") console.log(`---\n${draft.text}\n---`);
}

const cli = cac("telegram-me")
  .option("--json", "Print JSON")
  .option("--verbose", "Print detailed output");

cli
  .command(
    "login",
    "One-time sign-in through native macOS prompts; stores the session in the Keychain",
  )
  .action(async () => {
    let api = await readApi();
    if (!api) {
      api = apiSchema.parse({
        apiId: Number(await ask("Telegram api_id from my.telegram.org")),
        apiHash: await ask("Telegram api_hash from my.telegram.org", true),
      });
      await Bun.secrets.set({ ...keychain.api, value: JSON.stringify(api) });
    }

    // The phone number is not secret, so an agent may pipe it in; codes and passwords only come from the prompts.
    const piped = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
    const tg = newClient(api);
    try {
      const me = await tg.start({
        phone: () => piped || ask("Owner's Telegram phone number, with country code"),
        code: () => ask("Login code Telegram just sent to your Telegram app", true),
        password: () => ask("Telegram two-step verification password", true),
        invalidCodeCallback: () => undefined,
        codeSentCallback: () => undefined,
      });
      if (me.id !== opsBot().ownerId)
        throw new Error("Signed-in account is not the owner's; session discarded");
      await Bun.secrets.set({
        ...keychain.session,
        value: await tg.exportSession(),
      });
      console.log(
        json ? JSON.stringify({ signedIn: true }) : "telegram-me: signed in as the owner",
      );
    } finally {
      await tg.destroy();
    }
  });

const day = (date: string | null | undefined) => date?.slice(0, 10) ?? "-";

cli
  .command("chats", "List chats with id, type, and title")
  .option("--search <text>", "Only titles containing this text")
  .option("--type <type>", `Only this type: ${CHAT_TYPES.join(", ")}`)
  .option(
    "--counts",
    "Add message totals and last message dates, largest first; one request per chat",
  )
  .option("--top <n>", "With --counts, keep only the n largest chats")
  .option("--first", "With --counts, add first message dates; one more request per listed chat")
  .action(
    async (options: {
      search?: string;
      type?: string;
      counts?: boolean;
      top?: number;
      first?: boolean;
    }) => {
      const search = options.search?.toLowerCase();
      const top = options.top === undefined ? undefined : Number(options.top);
      if (top !== undefined && !(Number.isInteger(top) && top > 0))
        throw new Error("--top needs a positive whole number");
      if ((top !== undefined || options.first) && !options.counts)
        throw new Error("--top and --first need --counts");
      if (options.type && !CHAT_TYPES.includes(options.type as Chat["type"]))
        throw new Error(`--type must be one of ${CHAT_TYPES.join(", ")}`);

      const chats = await withClient(async (client) => {
        const matching = (await client.chats()).filter(
          (chat) =>
            (!search || chat.title.toLowerCase().includes(search)) &&
            (!options.type || chat.type === options.type),
        );
        return options.counts
          ? countChats(client, matching, { top, first: options.first })
          : matching;
      });

      const line = (chat: Chat | ChatCount) =>
        "count" in chat
          ? [
              chat.id,
              chat.type,
              chat.count,
              ...(options.first ? [day(chat.firstDate)] : []),
              day(chat.lastDate),
              chat.title,
            ].join("\t")
          : `${chat.id}\t${chat.type}\t${chat.title}`;
      console.log(
        json ? JSON.stringify(chats) : chats.map(line).join("\n") || "telegram-me: no chats match",
      );
    },
  );

cli
  .command("read <chat>", "Recent messages, oldest first; <chat> is an id, an exact title, or me")
  .option("--limit <n>", "How many messages", { default: 20 })
  .action(async (reference: string, options: { limit: number }) => {
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    const messages = await withClient(async (client) =>
      client.history(findChat(await client.chats(), reference).id, limit),
    );
    const ordered = messages.reverse();
    console.log(
      json
        ? JSON.stringify(ordered)
        : ordered
            .map(
              (message) =>
                `[${message.date.toISOString().slice(0, 16)}] ${message.outgoing ? "me" : message.senderName}: ${message.text}`,
            )
            .join("\n") || "telegram-me: no messages",
    );
  });

cli
  .command(
    "draft <chat>",
    "Store stdin as a draft to <chat> and send its preview to the owner for approval",
  )
  .action(async (reference: string) => {
    if (process.stdin.isTTY) throw new Error("Pipe the message into telegram-me draft");
    const text = await Bun.stdin.text();
    printDraft(await context((ctx) => createDraft(ctx, reference, text)), "created");
  });

cli
  .command(
    "approve <draft-id>",
    "Mark a draft approved once the owner replied yes to its Telegram preview",
  )
  .action(async (id: string) =>
    printDraft(await context((ctx) => approveDraft(ctx, id)), "approved"),
  );

cli
  .command("send <draft-id>", "Send an approved draft exactly as stored")
  .action(async (id: string) => printDraft(await context((ctx) => sendDraft(ctx, id)), "sent"));

cli.help();
cli.addEventListener("command:*", () => {
  throw new Error("Unknown command; run telegram-me --help");
});

try {
  requireMainMac();
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  // mtcute errors can echo request details; keep only the message, never the stack.
  console.error(error instanceof Error ? error.message : "telegram-me failed");
  process.exitCode = 1;
}
