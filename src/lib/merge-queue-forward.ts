// One merge queue runs, on main-mac: it is the Housekeeper's host and owns relays and post-merge checks. Spare Macs run no
// worker; their `add` and `status` travel over the restricted main-mac-inbox SSH key, whose forced command (shell/t3-inbox.zsh)
// accepts only these shapes. An SSH session cannot read GitHub's keychain sign-in, so a forwarded `add` is spooled as a request
// that a launchd agent in main-mac's GUI session runs, recording which Mac the owning thread lives on.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const MERGE_QUEUE_INBOX_LABEL = "com.my-setup.merge-queue-inbox";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR = /^[1-9][0-9]{0,6}$/;
const THREAD = /^[A-Za-z0-9:_.%-]{1,300}$/;
const FLAGS = new Set(["--json", "--dry-run"]);

/** Validates forwarded `merge-queue` arguments; returns them unchanged, or an error message. */
export function forwardedMergeQueueArgs(args: string[]): string[] | string {
  const [command, ...rest] = args;
  const flags = rest.filter((arg) => FLAGS.has(arg));
  const positional = rest.filter((arg) => !FLAGS.has(arg));

  if (command === "status" && positional.length === 0 && !flags.includes("--dry-run")) return args;
  if (command === "add") {
    const [repo, pr, option, thread, ...extra] = positional;
    if (
      REPO.test(repo ?? "") &&
      PR.test(pr ?? "") &&
      option === "--thread" &&
      THREAD.test(thread ?? "") &&
      extra.length === 0
    )
      return args;
  }
  return "spare Macs only run `merge-queue add <owner/repo> <pr> --thread <id>` and `merge-queue status`; main-mac's queue does the rest";
}

/** The SSH command a spare Mac runs to reach main-mac's queue. */
export function mainMacQueueCommand(args: string[]): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "main-mac-inbox",
    "merge-queue",
    ...args,
  ];
}

export interface ForwardedResult {
  exitCode: number;
  output: string;
}

/** Spools a forwarded command for main-mac's GUI session and waits for its result. */
export async function submitRequest(
  args: string[],
  from: string,
  directory: string,
  timeoutMs = 180_000,
): Promise<ForwardedResult> {
  const requests = join(directory, "requests");
  await mkdir(requests, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const result = join(requests, `${id}.result.json`);
  try {
    await writeFile(join(requests, `${id}.tmp`), JSON.stringify({ args, from }), { mode: 0o600 });
    await rename(join(requests, `${id}.tmp`), join(requests, `${id}.request.json`));
    // fs.watch drops events, especially right after it starts, so check for the result directly.
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(result)) {
      if (Date.now() >= deadline)
        throw new Error(`no answer from main-mac's merge queue inbox within ${timeoutMs / 1000}s`);
      await Bun.sleep(100);
    }
    return JSON.parse(await readFile(result, "utf8")) as ForwardedResult;
  } finally {
    await rm(result, { force: true });
  }
}

/** Runs every spooled request; launchd starts this whenever the requests directory changes. */
export async function processRequests(
  directory: string,
  run: (args: string[], from: string) => Promise<ForwardedResult>,
): Promise<number> {
  const requests = join(directory, "requests");
  let processed = 0;
  for (;;) {
    const pending = existsSync(requests)
      ? (await readdir(requests)).filter((name) => name.endsWith(".request.json"))
      : [];
    if (pending.length === 0) return processed;
    for (const name of pending) {
      const path = join(requests, name);
      const id = name.replace(/\.request\.json$/, "");
      let result: ForwardedResult;
      try {
        const request = JSON.parse(await readFile(path, "utf8")) as {
          args: string[];
          from: string;
        };
        const allowed = forwardedMergeQueueArgs(request.args);
        result =
          typeof allowed === "string" ||
          allowed[0] !== "add" ||
          !/^[a-z0-9][a-z0-9.-]*$/.test(request.from)
            ? {
                exitCode: 64,
                output: `merge-queue: ${typeof allowed === "string" ? allowed : "only add is spooled"}`,
              }
            : await run(allowed, request.from);
      } catch (error) {
        result = { exitCode: 1, output: `merge-queue: ${String(error)}` };
      }
      await rm(path, { force: true });
      await writeFile(join(requests, `${id}.result.tmp`), JSON.stringify(result), { mode: 0o600 });
      await rename(join(requests, `${id}.result.tmp`), join(requests, `${id}.result.json`));
      processed++;
    }
  }
}
