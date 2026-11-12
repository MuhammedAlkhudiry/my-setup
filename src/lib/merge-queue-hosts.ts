import { readFile, writeFile } from "node:fs/promises";
import { hostname, loadavg } from "node:os";
import type { QueueBackend } from "./merge-queue";
import { acquireQueueLock, QueueTransientError } from "./merge-queue";
import { signoffPolicy } from "./merge-queue-signoff";

export type CandidateResult = Awaited<ReturnType<QueueBackend["candidate"]>>;
export interface HostLoad {
  host: string;
  load: number;
  maxLoad: number;
  busy?: boolean;
}
/** The least-loaded idle spare Mac, else main-mac when it is idle; busy or overloaded hosts are skipped. */
export function chooseSignoffHost(samples: HostLoad[], excluded: string[] = []) {
  const eligible = samples.filter(
    (s) => !excluded.includes(s.host) && !s.busy && Number.isFinite(s.load) && s.load < s.maxLoad,
  );
  return eligible.sort(
    (a, b) => Number(a.host === "main-mac") - Number(b.host === "main-mac") || a.load - b.load,
  )[0]?.host;
}
export interface SignoffRequest {
  repo: string;
  base: string;
  sha: string;
  bundle: string;
  entries: Parameters<QueueBackend["candidate"]>[0];
  checks?: string[];
  full: boolean;
  /** The trusted main a held-main candidate signs off the changed areas since. */
  since?: string;
  /** The areas main-mac narrowed the sign-off to. */
  areas?: string[];
}
export interface RemoteSignoffResult {
  result?: CandidateResult;
  logs?: Record<string, string>;
  error?: string;
}
export type HostCommand = (
  command: string,
  args: string[],
  options: { input?: string; timeout?: number; reject?: boolean; all?: boolean },
) => Promise<{ stdout: string; failed?: boolean }>;

const worker =
  'source "$HOME/PhpstormProjects/my-setup/shell/zsh-custom.zsh" >/dev/null || exit; exec bun --no-env-file "$HOME/PhpstormProjects/my-setup/src/commands/merge-queue-signoff-worker.ts"';
/** SSH options for every sign-off connection: never prompt, and drop a dead link within a minute. */
export const SIGNOFF_SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];
export const remoteSignoffCommand = (host: string, probe = false) => [
  ...SIGNOFF_SSH_OPTIONS,
  host,
  `${worker}${probe ? " --probe" : ""}`,
];

/** No reachable/idle host and failed transports are queue infrastructure, never PR failures. */
export async function dispatchSignoff(options: {
  hosts: string[];
  execute: HostCommand;
  request: () => Promise<SignoffRequest>;
  log: string;
  probe?: (host: string) => Promise<HostLoad>;
  reserveLocal?: (release: () => void) => void;
  reserve?: (host: string) => (() => void) | undefined;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  waitSeconds?: number;
  remote?: (host: string, request: SignoffRequest) => Promise<RemoteSignoffResult>;
}) {
  const probe =
    options.probe ??
    (async (host: string) => {
      if (host === "main-mac") {
        // Busy, like a spare Mac's probe, while another queue sign-off holds this Mac.
        const release = acquireQueueLock("signoff");
        release?.();
        return { host, load: loadavg()[0]!, maxLoad: signoffPolicy().maxLoad, busy: !release };
      }
      const result = await options.execute("ssh", remoteSignoffCommand(host, true), {
        timeout: 20_000,
        reject: false,
      });
      if (result.failed) throw new Error(`unreachable ${host}`);
      return { ...JSON.parse(result.stdout), host } as HostLoad;
    });
  const excluded: string[] = [];
  const now = options.now ?? Date.now;
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.waitSeconds ?? 3600) * 1000;
  const reserve = options.reserve ?? ((host: string) => acquireQueueLock(`signoff-host-${host}`));
  while (true) {
    const samples = await Promise.all(
      options.hosts.map(async (host) => probe(host).catch(() => undefined)),
    );
    const available = samples.filter(
      (s): s is HostLoad => Boolean(s) && !excluded.includes(s!.host),
    );
    let host: string | undefined;
    let release: (() => void) | undefined;
    const unavailable = [...excluded];
    while ((host = chooseSignoffHost(available, unavailable))) {
      release = reserve(host);
      if (release) break;
      unavailable.push(host);
    }
    if (!host || !release) {
      if (!available.length || now() >= deadline)
        throw new QueueTransientError(
          `No eligible sign-off Mac${excluded.length ? `; unavailable: ${excluded.join(", ")}` : ""}`,
        );
      await pause(Math.min(5000, Math.max(1, deadline - now())));
      continue;
    }
    if (host === "main-mac") {
      if (options.reserveLocal) options.reserveLocal(release);
      else release();
      return undefined;
    }
    excluded.push(host);
    try {
      const request = await options.request();
      const envelope = options.remote
        ? await options.remote(host, request)
        : await (async () => {
            const result = await options.execute("ssh", remoteSignoffCommand(host), {
              input: JSON.stringify(request),
              timeout: 10_800_000,
              reject: false,
            });
            if (result.failed) throw new Error("SSH disconnected or timed out");
            return JSON.parse(result.stdout) as RemoteSignoffResult;
          })();
      if (envelope.error || !envelope.result || typeof envelope.result.ok !== "boolean")
        throw new Error(envelope.error ?? "invalid remote result");
      // Copy logs into main-mac's own log directory and rewrite every result path, including receipts.
      const paths = new Map<string, string>();
      for (const path of Object.keys(envelope.logs ?? {}))
        paths.set(path, `${options.log}.${host}-${paths.size}.log`);
      const rewrite = (text: string) => {
        for (const [remote, local] of [...paths].sort((a, b) => b[0].length - a[0].length))
          text = text.replaceAll(remote, local);
        return text;
      };
      for (const [path, content] of Object.entries(envelope.logs ?? {}))
        await writeFile(paths.get(path)!, rewrite(content), { mode: 0o600 });
      const result = JSON.parse(JSON.stringify(envelope.result), (_key, value) =>
        typeof value === "string" ? rewrite(value) : value,
      ) as CandidateResult;
      if (!paths.has(envelope.result.log)) throw new Error("remote result missing candidate log");
      for (const run of result.runs ?? []) run.host = host;
      return result;
    } catch (error) {
      await writeFile(`${options.log}.${host}-transport.log`, String(error), { mode: 0o600 });
    } finally {
      release();
    }
  }
}

export async function collectSignoffLogs(result: CandidateResult) {
  return collectLogs([
    result.log,
    ...(result.runs ?? []).flatMap((run) => [
      run.log,
      ...(run.receipt ? [run.receipt] : []),
      ...run.failures.map((failure) => failure.log),
    ]),
  ]);
}

/** Reads each log and every log it names, at most 64, for copying back to main-mac. */
export async function collectLogs(start: string[]) {
  const paths = new Set(start);
  const logs: Record<string, string> = {};
  for (const path of paths) {
    if (Object.keys(logs).length >= 64) break;
    const text = await readFile(path, "utf8").catch(
      () => `Log unavailable on ${hostname()}: ${path}`,
    );
    logs[path] = text;
    for (const match of text.matchAll(/(?:\blog(?:=|:\s*)|"log"\s*:\s*")(\/[^\s";]+)/g))
      paths.add(match[1]!);
  }
  return logs;
}
