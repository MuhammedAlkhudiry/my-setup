import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BotFileClient,
  downloadTelegramMessageFile,
  mtprotoSessionPath,
  parseDownloadTarget,
  readMtprotoApp,
} from "./telegram-mtproto";

function withCredentialsHome(run: (directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-mtproto-test-"));
    const previousHome = process.env.SERVICE_CREDENTIALS_HOME;
    mkdirSync(join(directory, "telegram"));
    process.env.SERVICE_CREDENTIALS_HOME = directory;

    try {
      await run(directory);
    } finally {
      if (previousHome === undefined) delete process.env.SERVICE_CREDENTIALS_HOME;
      else process.env.SERVICE_CREDENTIALS_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function fakeClient(file: string | undefined, calls: string[]): BotFileClient {
  return {
    signIn: async (session) => {
      calls.push(`signIn:${session ?? "token"}`);
      return session ?? "new-session";
    },
    downloadMessageFile: async (chatId, messageId, path) => {
      calls.push(`download:${chatId}:${messageId}`);
      if (file === undefined) return false;
      writeFileSync(path, file);
      return true;
    },
    close: async () => {
      calls.push("close");
    },
  };
}

test("download targets accept marked chat ids and positive message ids only", () => {
  expect(parseDownloadTarget("-1001234567890", "79")).toEqual({
    chatId: -1001234567890,
    messageId: 79,
  });
  expect(() => parseDownloadTarget("@group", "79")).toThrow("Chat id");
  expect(() => parseDownloadTarget("-100", "0")).toThrow("Message id");
  expect(() => parseDownloadTarget("-100", "7.5")).toThrow("Message id");
});

test(
  "download stores a new session with mode 600, then reuses it",
  withCredentialsHome(async (directory) => {
    const calls: string[] = [];
    const out = join(directory, "file.pdf");

    expect(
      await downloadTelegramMessageFile(fakeClient("pdf-bytes", calls), "-100123", "79", out),
    ).toBe(9);
    expect(readFileSync(out, "utf8")).toBe("pdf-bytes");
    expect(readFileSync(mtprotoSessionPath(), "utf8")).toBe("new-session");
    expect(statSync(mtprotoSessionPath()).mode & 0o777).toBe(0o600);
    expect(calls).toEqual(["signIn:token", "download:-100123:79", "close"]);

    calls.length = 0;
    await downloadTelegramMessageFile(
      fakeClient("x", calls),
      "-100123",
      "80",
      join(directory, "b.pdf"),
    );
    expect(calls[0]).toBe("signIn:new-session");
  }),
);

test(
  "download refuses to overwrite and leaves no partial file when the message has no file",
  withCredentialsHome(async (directory) => {
    const calls: string[] = [];
    const out = join(directory, "file.pdf");
    writeFileSync(out, "existing");

    await expect(
      downloadTelegramMessageFile(fakeClient("x", calls), "-100123", "79", out),
    ).rejects.toThrow("already exists");
    await expect(
      downloadTelegramMessageFile(
        fakeClient("x", calls),
        "-100123",
        "79",
        join(directory, "missing/f.pdf"),
      ),
    ).rejects.toThrow("directory does not exist");
    expect(calls).toEqual([]);

    const empty = join(directory, "empty.pdf");
    await expect(
      downloadTelegramMessageFile(fakeClient(undefined, calls), "-100123", "79", empty),
    ).rejects.toThrow("no file");
    expect(existsSync(empty) || existsSync(`${empty}.partial`)).toBe(false);
    expect(calls.at(-1)).toBe("close");
  }),
);

test(
  "app credentials errors never echo file contents",
  withCredentialsHome(async (directory) => {
    writeFileSync(
      join(directory, "telegram/mtproto-app.json"),
      JSON.stringify({ api_id: 1, api_hash: "secret" }),
    );
    expect(() => readMtprotoApp()).toThrow(
      "Telegram MTProto app credentials missing or invalid in credentials home",
    );

    writeFileSync(
      join(directory, "telegram/mtproto-app.json"),
      JSON.stringify({ api_id: 1, api_hash: "0123456789abcdef0123456789abcdef" }),
    );
    expect(readMtprotoApp().apiId).toBe(1);
  }),
);
