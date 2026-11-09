// `verify signoff`: the agent's sign-off, run on the least-loaded spare Mac and posted as a local one would be.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import {
  agentSignoff,
  agentSignoffCommand,
  agentSignoffDirectory,
  localizeLogs,
  type RemoteSignoffRun,
} from "../lib/agent-signoff";
import { readSignoffHosts } from "../lib/device";
import { remoteSignoffCommand, type HostLoad } from "../lib/merge-queue-hosts";

export const SIGNOFF_HELP = `Usage: verify signoff [--local] [--json] [--verbose] [<mise run signoff options>]

Signs off this checkout's pushed branch head on the least-loaded spare Mac, which posts the commit's \`signoff\` status
as \`mise run signoff\` does here. Pushes the branch first when its head is not on GitHub yet. Any reachable spare Mac runs
it, the least loaded for its size; it runs here only when none is reachable, or the checkout is dirty, detached, or on main.
  --local      run here
  --json       print {ok, host, seconds, sha, log, output, notes}
  --verbose    print the sign-off's own output after the result line
Other options, such as --full, --fresh, and --no-update, go to \`mise run signoff\`.`;

const git = async (cwd: string, ...args: string[]) =>
  (await execa("git", args, { cwd, reject: false })).stdout.trim();

export async function verifySignoff(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SIGNOFF_HELP);
    return 0;
  }
  const json = argv.includes("--json");
  const verbose = argv.includes("--verbose");
  const args = argv.filter(
    (arg) => !["--json", "--verbose", "--local"].includes(arg),
  );
  const root = await git(process.cwd(), "rev-parse", "--show-toplevel");
  if (!root) {
    console.error("verify signoff: run it inside a project checkout");
    return 2;
  }

  const started = Date.now();
  const sha = await git(root, "rev-parse", "HEAD");
  const repo = (await git(root, "remote", "get-url", "origin")).match(
    /github\.com[:/](.+?)(?:\.git)?$/,
  )?.[1];
  const branch = await git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  const dirty = (await git(root, "status", "--porcelain")) !== "";
  const notes: string[] = [];
  let spares = argv.includes("--local")
    ? []
    : (readSignoffHosts(homedir()) ?? []).filter((host) => host !== "main-mac");

  // The project's sign-off refuses dirty, unpushed, or detached work with its own message; leave that to it.
  if (spares.length && (dirty || !repo || !branch || branch === "main")) {
    notes.push("checkout is dirty, detached, or on main");
    spares = [];
  }
  if (
    spares.length &&
    (await git(root, "ls-remote", "origin", `refs/heads/${branch}`)).split(
      /\s/,
    )[0] !== sha
  ) {
    const pushed = await execa(
      "git",
      ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      {
        cwd: root,
        reject: false,
      },
    );
    if (pushed.failed) {
      notes.push("push failed");
      spares = [];
    }
  }

  const logs = join(agentSignoffDirectory(), "logs");
  await mkdir(logs, { recursive: true });
  const log = join(
    logs,
    `${repo?.replaceAll("/", "-") ?? "local"}-${sha.slice(0, 9)}-${started}`,
  );
  const run = await agentSignoff(
    { repo: repo ?? "", branch, sha, args },
    {
      spares,
      probe: async (host) => {
        const result = await execa("ssh", remoteSignoffCommand(host, true), {
          timeout: 20_000,
          reject: false,
        });
        if (result.failed) throw new Error(`unreachable ${host}`);
        return { ...JSON.parse(result.stdout), host } as HostLoad;
      },
      remote: async (host, request) => {
        const result = await execa("ssh", agentSignoffCommand(host), {
          input: JSON.stringify(request),
          timeout: 14_400_000,
          reject: false,
        });
        if (result.failed)
          throw new Error(`SSH failed: ${result.stderr.trim().slice(-300)}`);
        const envelope = JSON.parse(result.stdout) as RemoteSignoffRun & {
          error?: string;
        };
        if (envelope.error) throw new Error(envelope.error);
        return envelope;
      },
      local: async (localArgs) => {
        const result = await execa(
          "mise",
          ["run", "signoff", ...(localArgs.length ? ["--", ...localArgs] : [])],
          {
            cwd: root,
            all: true,
            reject: false,
          },
        );
        await writeFile(`${log}.log`, result.all ?? "");
        return {
          exitCode: result.exitCode ?? 1,
          output: (result.stdout || result.stderr).trim(),
        };
      },
    },
  );
  notes.push(...run.notes);

  let output = run.output;
  let mainLog = `${log}.log`;
  if (run.logs) {
    const localized = localizeLogs(run.output, run.logs, log);
    for (const file of localized.files)
      await writeFile(file.path, file.content);
    output = localized.output;
    mainLog = localized.files[0]?.path ?? mainLog;
  }

  // The spare Mac merged main into the branch and pushed it: bring this checkout to that head.
  if (run.host !== "main-mac" && branch) {
    const tip = (
      await git(root, "ls-remote", "origin", `refs/heads/${branch}`)
    ).split(/\s/)[0];
    if (tip && tip !== sha) {
      await git(root, "fetch", "--quiet", "origin", `refs/heads/${branch}`);
      const merged = await execa(
        "git",
        ["merge", "--quiet", "--ff-only", "FETCH_HEAD"],
        {
          cwd: root,
          reject: false,
        },
      );
      notes.push(
        merged.failed
          ? `origin/${branch} moved to ${tip.slice(0, 9)}; pull it`
          : `pulled ${tip.slice(0, 9)}`,
      );
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = run.exitCode === 0;
  const where = run.host === "main-mac" ? "locally" : `on ${run.host}`;
  if (json)
    console.log(
      JSON.stringify({
        ok,
        host: run.host,
        seconds,
        sha,
        log: mainLog,
        output,
        notes,
      }),
    );
  else {
    const took = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    const why = notes.length ? ` (${notes.join("; ")})` : "";
    console.log(
      `signoff ${ok ? "passed" : "failed"} ${where} in ${took} for ${sha.slice(0, 9)}${why}; log ${mainLog}`,
    );
    // A failure's own lines name each failed check's log.
    if (!ok || verbose) console.log(output);
  }
  return run.exitCode;
}
