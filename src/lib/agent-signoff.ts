import { homedir } from "node:os";
import { join } from "node:path";

import { chooseSignoffHost, type HostLoad, SIGNOFF_SSH_OPTIONS } from "./merge-queue-hosts";

/**
 * An agent's sign-off of its pushed branch head, run on the least-loaded spare Mac so project suites do not compete with
 * main-mac's agents. The spare Mac runs the project's own `mise run signoff`, which posts the `signoff` status exactly as a
 * local run does. Any failure to get a completed run there falls back to running here; it never refuses.
 */
export interface AgentSignoffRequest {
  repo: string;
  branch: string;
  sha: string;
  /** Passed to `mise run signoff --`, such as --full or --fresh. */
  args: string[];
}
/** A completed `mise run signoff`, whatever its checks found. */
export interface SignoffRun {
  exitCode: number;
  output: string;
}
/** A spare Mac's run: its output plus every log it names, keyed by the spare Mac's path. */
export interface RemoteSignoffRun extends SignoffRun {
  logs: Record<string, string>;
}

export const agentSignoffDirectory = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-signoff");

const worker =
  'source "$HOME/PhpstormProjects/my-setup/shell/zsh-custom.zsh" >/dev/null || exit; exec bun --no-env-file "$HOME/PhpstormProjects/my-setup/src/commands/agent-signoff-worker.ts"';
export const agentSignoffCommand = (host: string) => [...SIGNOFF_SSH_OPTIONS, host, worker];

/**
 * Among reachable spare Macs only: the queue's choice first, the least-loaded idle one under its load limit; else the one
 * least loaded for its size, preferring Macs no queue sign-off holds, once `agentSignoff` has waited for one under its limit.
 * main-mac never competes: it runs the sign-off only
 * when no spare Mac is reachable.
 */
export function chooseAgentSignoffHost(spares: HostLoad[]) {
  const ratio = (sample: HostLoad) =>
    Number.isFinite(sample.load) && sample.maxLoad > 0 ? sample.load / sample.maxLoad : Infinity;
  return (
    chooseSignoffHost(spares) ??
    [...spares].sort(
      (a, b) => Number(Boolean(a.busy)) - Number(Boolean(b.busy)) || ratio(a) - ratio(b),
    )[0]?.host
  );
}

export async function agentSignoff(
  request: AgentSignoffRequest,
  io: {
    /** Spare Macs to try; main-mac is never listed, it is `local`, used only when none is reachable. */
    spares: string[];
    /** Rejects when the host is unreachable. */
    probe: (host: string) => Promise<HostLoad>;
    /** Rejects when no completed run came back: SSH, checkout, or prepare failed. */
    remote: (host: string, request: AgentSignoffRequest) => Promise<RemoteSignoffRun>;
    local: (args: string[]) => Promise<SignoffRun>;
    /** Waits between probes while every spare Mac is over its load limit; tests pass a no-op. */
    pause?: (ms: number) => Promise<void>;
    /** How long to wait for a spare Mac under its load limit before taking the least loaded anyway. */
    waitMs?: number;
  },
): Promise<SignoffRun & { host: string; notes: string[]; logs?: Record<string, string> }> {
  const notes: string[] = [];
  const pause = io.pause ?? ((ms: number) => Bun.sleep(ms));
  const probeAll = () =>
    Promise.all(io.spares.map((host) => io.probe(host).catch(() => undefined)));

  // Timing gates fail falsely on an overloaded Mac, so wait for one under its limit before settling for the least loaded.
  let probed = await probeAll();
  for (
    let waited = 0;
    probed.some(Boolean) &&
    !chooseSignoffHost(probed.filter((sample): sample is HostLoad => Boolean(sample))) &&
    waited < (io.waitMs ?? 1_200_000);
    waited += 30_000
  ) {
    if (!waited) notes.push("waiting for a spare Mac under its load limit");
    await pause(30_000);
    probed = await probeAll();
  }

  io.spares.forEach((host, index) => {
    if (!probed[index]) notes.push(`${host} unreachable`);
  });
  const spares = probed.filter((sample): sample is HostLoad => Boolean(sample));

  while (true) {
    const host = chooseAgentSignoffHost(spares);
    if (!host) {
      if (io.spares.length && !probed.some(Boolean)) notes.push("no spare Mac reachable");
      return { ...(await io.local(request.args)), host: "main-mac", notes };
    }

    try {
      return { ...(await io.remote(host, request)), host, notes };
    } catch (error) {
      notes.push(`${host} failed: ${String(error).slice(0, 300)}`);
      spares.splice(
        spares.findIndex((sample) => sample.host === host),
        1,
      );
    }
  }
}

/** Rewrites the spare Mac's log paths to copies named `<prefix>-<n>.log`, so every path printed opens on this Mac. */
export function localizeLogs(output: string, logs: Record<string, string>, prefix: string) {
  const paths = new Map(Object.keys(logs).map((path, index) => [path, `${prefix}-${index}.log`]));
  const rewrite = (text: string) => {
    for (const [remote, local] of [...paths].sort((a, b) => b[0].length - a[0].length))
      text = text.replaceAll(remote, local);
    return text;
  };
  return {
    output: rewrite(output),
    files: [...paths].map(([remote, local]) => ({
      path: local,
      content: rewrite(logs[remote]!),
    })),
  };
}
