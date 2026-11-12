import { expect, test } from "bun:test";

import type { ProcessRow } from "./cpu-guard";
import {
  formatDuration,
  reaperMessage,
  recordingKind,
  recordingOwner,
  staleRecordings,
} from "./recording-reaper";

const UID = 501;

function row(pid: number, ppid: number, command: string, ageMinutes = 0, uid = UID): ProcessRow {
  return {
    pid,
    ppid,
    uid,
    rssMib: 10,
    cpuPercent: 0,
    cpuSeconds: 0,
    ageSeconds: ageMinutes * 60,
    started: "Mon Nov 2 10:00:00 2026",
    command,
  };
}

test("recognizes screen and simulator recordings, never ffmpeg conversions or Android screenrecord", () => {
  expect(
    recordingKind('/opt/homebrew/bin/ffmpeg -f avfoundation -i "1:none" -r 30 /tmp/demo.mp4'),
  ).toBe("ffmpeg screen recording");
  expect(recordingKind("xcrun simctl io 0CBC68FD recordVideo --codec h264 /tmp/qa.mp4")).toBe(
    "simulator recording",
  );
  expect(
    recordingKind(
      "/Applications/Xcode.app/Contents/Developer/usr/bin/simctl io booted recordVideo /tmp/a.mov",
    ),
  ).toBe("simulator recording");
  expect(recordingKind("screencapture -v /tmp/screen.mov")).toBe("screencapture recording");

  expect(recordingKind("ffmpeg -i in.oga -ar 16000 out.wav")).toBeUndefined();
  expect(recordingKind("ffmpeg -f image2 -i frame%03d.png out.mp4")).toBeUndefined();
  expect(recordingKind("screencapture -x /tmp/shot.png")).toBeUndefined();
  expect(recordingKind("adb -s emulator-5554 shell screenrecord /sdcard/a.mp4")).toBeUndefined();
  expect(recordingKind("rg avfoundation src")).toBeUndefined();
});

test("the owner is the nearest agent or agent-device daemon, and a merge-queue run above it wins", () => {
  const rows = [
    row(10, 1, "/Users/me/.local/bin/claude --resume"),
    row(11, 10, "/bin/zsh -c ffmpeg"),
    row(12, 11, "ffmpeg -f avfoundation -i 1 out.mp4", 45),
    row(
      20,
      1,
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code /Users/me/.t3/tools/agent-device/0.21.31/node_modules/agent-device/dist/src/internal/daemon.js",
    ),
    row(21, 20, "xcrun simctl io ABC recordVideo /tmp/a.mp4", 45),
    row(30, 1, "bun --no-env-file /Users/me/my-setup/src/commands/merge-queue-cli.ts run"),
    row(31, 30, "/Users/me/.local/bin/codex exec signoff"),
    row(32, 31, "xcrun simctl io DEF recordVideo /tmp/b.mp4", 45),
    row(40, 1, "ffmpeg -f avfoundation -i 1 orphan.mp4", 45),
  ];

  expect(recordingOwner(rows[2]!, rows)).toEqual({ kind: "agent", pid: 10, name: "claude" });
  expect(recordingOwner(rows[4]!, rows)).toEqual({ kind: "agent-device", pid: 20 });
  expect(recordingOwner(rows[7]!, rows)).toEqual({ kind: "merge-queue", pid: 30 });
  expect(recordingOwner(rows[8]!, rows)).toEqual({ kind: "none" });
});

test("a spare Mac's sign-off worker owns its recordings like a merge-queue run", () => {
  const rows = [
    row(50, 1, "bun --no-env-file /Users/me/my-setup/src/commands/merge-queue-signoff-worker.ts"),
    row(51, 50, "xcrun simctl io ABC recordVideo /tmp/a.mp4", 45),
    row(60, 1, "bun --no-env-file /Users/me/my-setup/src/commands/agent-signoff-worker.ts"),
    row(61, 60, "xcrun simctl io DEF recordVideo /tmp/b.mp4", 45),
  ];

  expect(recordingOwner(rows[1]!, rows)).toEqual({ kind: "merge-queue", pid: 50 });
  expect(recordingOwner(rows[3]!, rows)).toEqual({ kind: "merge-queue", pid: 60 });
});

test("only this user's recordings past 30 minutes are stale, and a merge-queue run's never are", () => {
  const rows = [
    row(10, 1, "claude"),
    row(11, 10, "ffmpeg -f avfoundation -i 1 old.mp4", 31),
    row(12, 10, "ffmpeg -f avfoundation -i 1 recent.mp4", 29),
    row(13, 1, "ffmpeg -f avfoundation -i 1 other-user.mp4", 120, 502),
    row(14, 1, "ffmpeg -i long-render.mov out.mp4", 120),
    row(30, 1, "bun merge-queue-cli.ts run"),
    row(31, 30, "xcrun simctl io DEF recordVideo /tmp/signoff.mp4", 120),
  ];

  expect(staleRecordings(rows, UID).map((recording) => recording.row.pid)).toEqual([11]);
});

test("the Housekeeper message is one line naming each stop, and nothing when nothing stopped", () => {
  expect(reaperMessage("main-mac", [], [])).toBeUndefined();

  const recording = row(12, 10, "ffmpeg -f avfoundation -i 1 out.mp4", 167);
  const message = reaperMessage(
    "main-mac",
    [{ name: "Harium_Main", platform: "android", unleasedMs: 165 * 60_000 }],
    [
      {
        row: recording,
        kind: "ffmpeg screen recording",
        owner: { kind: "agent", pid: 10, name: "claude" },
        stoppedBy: "SIGINT",
      },
    ],
  );
  expect(message).toBe(
    "leftover-reaper: main-mac stopped Harium_Main (android, unleased 2h45m); ffmpeg screen recording pid 12 (2h47m, claude pid 10, SIGINT)",
  );
  expect(message).not.toContain("\n");
  expect(formatDuration(12 * 60_000)).toBe("12m");
});
