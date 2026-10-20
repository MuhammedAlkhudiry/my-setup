// A detached supervisor waits for the parent to persist its identity before
// starting any work. If the parent crashes before the handshake, stdin closes.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

import { processSnapshot } from "../lib/process-identity";

const send = (value: unknown) => writeSync(3, `${JSON.stringify(value)}\n`);
let killTimer: ReturnType<typeof setTimeout> | undefined;

function terminateGroup() {
  killTimer ??= setTimeout(() => process.kill(-process.pid, "SIGKILL"), 1000);
}

process.on("SIGTERM", terminateGroup);
process.on("SIGINT", terminateGroup);
process.on("SIGHUP", terminateGroup);
send({ ready: true });

const input = await Bun.stdin.text();
if (!input) process.exit(0);
const { argv, deferred, uncapped, cliPath, owner, waitSeconds } = JSON.parse(input) as {
  argv: string[];
  deferred: boolean;
  uncapped: boolean;
  cliPath: string;
  owner: string;
  waitSeconds: number;
};
const env = { ...process.env };
delete env.HEAVY_RUN_DEFERRED;
delete env.HEAVY_RUN_RESERVATION_ID;
delete env.HEAVY_RUN_UNCAPPED;
if (uncapped) env.HEAVY_RUN_UNCAPPED = "1";
if (deferred) {
  env.HEAVY_RUN_DEFERRED = "1";
  env.HEAVY_RUN_CLI = cliPath;
  env.HEAVY_RUN_OWNER = owner;
  env.HEAVY_RUN_WAIT_SECONDS = String(waitSeconds);
} else {
  env.HEAVY_RUN_RESERVATION_ID = process.argv[2];
}
const child = spawn(argv[0], argv.slice(1), {
  stdio: ["ignore", "inherit", "inherit"],
  env,
});
const result = await new Promise<{
  exitCode: number | null;
  signal: string | null;
  error?: string;
}>((resolve) => {
  child.on("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
  child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
});

try {
  send(result);
} catch {
  /* The wrapper may have crashed; cleanup still belongs to this supervisor. */
}

// A successful command must not leave background descendants consuming the slot.
// Keep the supervisor alive while cleaning them, including after a wrapper crash.
terminateGroup();
process.kill(-process.pid, "SIGTERM");
while (
  (await processSnapshot()).some(
    (row) => row.pgid === process.pid && row.pid !== process.pid && !row.state.startsWith("Z"),
  )
) {
  await Bun.sleep(25);
}

clearTimeout(killTimer);
process.exit(0);
