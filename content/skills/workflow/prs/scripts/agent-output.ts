import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// process.exit drops queued pipe writes past ~64 KB; write synchronously instead.
function writeAll(fd: number, text: string) {
  let buffer = Buffer.from(text);
  while (buffer.length) {
    try {
      buffer = buffer.subarray(writeSync(fd, buffer));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

interface OutputOptions {
  nativeJson?: boolean;
  summary?: (output: string) => string;
  failures?: (output: string, errors: string) => string[];
}

// Run the command once with its full output captured. Keep failure logs private and
// remove successful logs; existing JSON stdout passes through byte for byte.
export function agentOutput(name: string, options: OutputOptions = {}): void {
  const script = process.argv[1];
  if (process.env.MY_SETUP_OUTPUT_CHILD === script) return;

  const argv = process.argv.slice(2);
  const json =
    argv.includes("--json") ||
    argv.includes("--format=json") ||
    (argv.includes("--format") &&
      argv[argv.indexOf("--format") + 1] === "json");
  const verbose = argv.includes("--verbose");
  const help = argv.includes("--help") || argv.includes("-h");
  const args = argv.filter(
    (arg) => arg !== "--verbose" && (options.nativeJson || arg !== "--json"),
  );
  const parentLog = process.env.MY_SETUP_OUTPUT_LOG_ROOT;
  const directory = mkdtempSync(
    join(
      parentLog && existsSync(parentLog) ? parentLog : tmpdir(),
      `${name}-log-`,
    ),
  );
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  const log = join(directory, "full.log");
  const stdoutFd = openSync(stdoutPath, "w", 0o600);
  const stderrFd = openSync(stderrPath, "w", 0o600);
  let result;

  try {
    result = spawnSync(process.execPath, [script, ...args], {
      stdio: ["inherit", stdoutFd, stderrFd],
      env: {
        ...process.env,
        MY_SETUP_OUTPUT_CHILD: script,
        MY_SETUP_OUTPUT_LOG_ROOT: directory,
        MY_SETUP_OUTPUT: verbose ? "verbose" : "compact",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  const output = readFileSync(stdoutPath, "utf8");
  const errors = readFileSync(stderrPath, "utf8");
  const code = result.status ?? 1;
  const success = code === 0;
  writeFileSync(
    log,
    `${output}${errors}${result.error ? `\n${result.error.message}\n` : ""}`,
    {
      mode: 0o600,
    },
  );
  rmSync(stdoutPath);
  rmSync(stderrPath);

  if (json && options.nativeJson) {
    writeAll(1, output);
  } else if (json) {
    writeAll(
      1,
      `${JSON.stringify({
        command: name,
        status: success ? "success" : "failed",
        exitCode: code,
        output: output.trim().split("\n").filter(Boolean),
        ...(success ? {} : { log }),
      })}\n`,
    );
  } else if (verbose || help) {
    writeAll(1, output);
    writeAll(2, errors);
  } else if (success) {
    console.log(options.summary?.(output) ?? `${name}: ok`);
  }

  if (!success) {
    let failures = options.failures?.(output, errors) ?? [];
    if (!options.failures) {
      try {
        const receipt = JSON.parse(output);
        failures =
          receipt.failedStages?.map(
            (stage: { name: string; conclusion: string }) =>
              `${stage.name}: ${stage.conclusion}`,
          ) ?? [];
        if (!failures.length && receipt.error) failures = [receipt.error];
      } catch {
        const lines = errors.trim().split("\n").filter(Boolean);
        const message =
          lines.find((line) => /^(?:error:|\w*Error:)/.test(line)) ?? lines[0];
        if (message) failures = [message];
      }
    }
    for (const item of failures.length
      ? failures
      : [`${name}: ${code === 75 ? "pending" : "failed"} (exit ${code})`]) {
      console.error(`${item.replace(/\s+/g, " ").trim()}; log: ${log}`);
    }
  }
  if (success) rmSync(directory, { recursive: true, force: true });

  process.exit(code);
}
