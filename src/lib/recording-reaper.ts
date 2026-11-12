// Finds screen and device recordings agents left running. An ffmpeg screen capture or a simulator recording keeps a
// core busy for as long as it runs, so one forgotten for hours holds the Mac's load up for everyone. The Mac watcher's
// guard stops them gracefully, so the file is finalized, and never touches a merge-queue run's processes.

import type { ProcessRow } from "./cpu-guard";

export const RECORDING_REAPER = {
  /** A recording running this long has been forgotten; agent clips last minutes. */
  maxAgeMinutes: 30,
  /** After SIGINT, a recording gets this long to write its file before SIGTERM and then SIGKILL. */
  finalizeMs: 15_000,
};

/**
 * Recordings that run as a long-lived Mac process: ffmpeg capturing the screen or a camera through AVFoundation, a
 * simulator recording (`simctl io <device> recordVideo`, which agent-device also runs), and `screencapture -v`. ffmpeg
 * conversions and renders read files, not a capture device, and never match. Android's `screenrecord` runs on the
 * device and stops itself after three minutes, so it never needs reaping.
 */
export function recordingKind(command: string): string | undefined {
  const words = command.split(/\s+/);
  const program = words[0]?.slice(words[0].lastIndexOf("/") + 1);

  if (program === "ffmpeg" && /(^|\s)-f\s+avfoundation(\s|$)/.test(command))
    return "ffmpeg screen recording";
  if (/(^|[\s/])simctl\s+io\s+\S+\s+recordVideo(\s|$)/.test(command)) return "simulator recording";
  if (program === "screencapture" && words.some((word) => /^-\w*[vV]/.test(word)))
    return "screencapture recording";
  return undefined;
}

export type RecordingOwner =
  | { kind: "merge-queue"; pid: number }
  | { kind: "agent"; pid: number; name: string }
  | { kind: "agent-device"; pid: number }
  | { kind: "none" };

/** The queue worker on the main Mac, or the sign-off worker it or `verify signoff` starts on a spare Mac. */
const MERGE_QUEUE_RUN = /merge-queue(-cli\.ts)?\s+run(\s|$)|(merge-queue|agent)-signoff-worker\.ts/;
const AGENT_CLI = /(^|\/)(claude|codex|opencode)(\s|$)/;
const AGENT_DEVICE_DAEMON = /agent-device\/.*daemon\.js/;

/**
 * The nearest process that started the recording, walking up its parents: a merge-queue run anywhere above it wins,
 * since its sign-off may record on purpose; otherwise the closest agent CLI or agent-device daemon.
 */
export function recordingOwner(row: ProcessRow, rows: ProcessRow[]): RecordingOwner {
  const byPid = new Map(rows.map((candidate) => [candidate.pid, candidate]));
  let owner: RecordingOwner = { kind: "none" };

  for (let pid = row.ppid, depth = 0; pid > 1 && depth < 40; depth++) {
    const parent = byPid.get(pid);
    if (!parent) break;
    if (MERGE_QUEUE_RUN.test(parent.command)) return { kind: "merge-queue", pid };
    if (owner.kind === "none") {
      const agent = parent.command.match(AGENT_CLI);
      if (agent) owner = { kind: "agent", pid, name: agent[2]! };
      else if (AGENT_DEVICE_DAEMON.test(parent.command)) owner = { kind: "agent-device", pid };
    }
    pid = parent.ppid;
  }
  return owner;
}

export function describeOwner(owner: RecordingOwner): string {
  if (owner.kind === "agent") return `${owner.name} pid ${owner.pid}`;
  if (owner.kind === "agent-device") return `agent-device daemon pid ${owner.pid}`;
  if (owner.kind === "merge-queue") return `merge-queue run pid ${owner.pid}`;
  return "no live owner";
}

export interface StaleRecording {
  row: ProcessRow;
  kind: string;
  owner: RecordingOwner;
}

/** This user's recordings older than `maxAgeMinutes`, except those a live merge-queue run owns. */
export function staleRecordings(
  rows: ProcessRow[],
  uid: number,
  maxAgeMinutes: number = RECORDING_REAPER.maxAgeMinutes,
): StaleRecording[] {
  return rows.flatMap((row) => {
    const kind = recordingKind(row.command);
    if (!kind || row.uid !== uid || row.ageSeconds < maxAgeMinutes * 60) return [];
    const owner = recordingOwner(row, rows);
    return owner.kind === "merge-queue" ? [] : [{ row, kind, owner }];
  });
}

/** Rounds a duration to the unit a person reads it in, such as "45m" or "2h47m". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export interface StoppedDevice {
  name: string;
  platform: string;
  unleasedMs: number;
}

/** One Housekeeper line for everything a guard pass stopped, or undefined when it stopped nothing. */
export function reaperMessage(
  host: string,
  devices: StoppedDevice[],
  recordings: Array<StaleRecording & { stoppedBy: string }>,
): string | undefined {
  const parts = [
    ...devices.map(
      (device) =>
        `${device.name} (${device.platform}, unleased ${formatDuration(device.unleasedMs)})`,
    ),
    ...recordings.map(
      ({ row, kind, owner, stoppedBy }) =>
        `${kind} pid ${row.pid} (${formatDuration(row.ageSeconds * 1000)}, ${describeOwner(owner)}, ${stoppedBy})`,
    ),
  ];
  return parts.length ? `leftover-reaper: ${host} stopped ${parts.join("; ")}` : undefined;
}
