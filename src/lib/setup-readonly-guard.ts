// Decides whether a Claude tool call writes into the setup checkout. Spare Macs hold a read-only copy that main-mac's
// mirror overwrites, so changes made there are lost; the hook blocks them early with the way to send the change instead.
// The mirror also leaves the copy non-writable, so this only has to catch the usual forms, not every possible write.

import { homedir } from "node:os";
import { resolve } from "node:path";

import { invokedProgram, shellScript, simpleCommands } from "./device-pool-guard";

export const SETUP_READONLY_MESSAGE =
  "my-setup is read-only on spare Macs; send the change to the Housekeeper with `ssh main-mac-inbox send`";

export interface ToolCall {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Programs that write every operand. */
const WRITE_ALL = new Set([
  "rm",
  "rmdir",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chflags",
  "tee",
  "truncate",
  "unlink",
]);
/** Programs that write only their last operand. */
const WRITE_LAST = new Set(["cp", "mv", "ln", "rsync", "install", "ditto"]);
/** Git subcommands that change the working tree or repository. */
const GIT_WRITES = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
]);

function expand(path: string, cwd: string, home: string): string {
  return resolve(cwd, path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home));
}

/** The first written path inside the setup root, or undefined. `cd` within the command moves the working directory. */
function shellWrite(
  command: string,
  start: string,
  root: string,
  home: string,
): string | undefined {
  let cwd = start;
  const visited = [cwd];
  const inside = (path: string, from = cwd) => {
    const target = expand(path, from, home);
    return target === root || target.startsWith(`${root}/`) ? target : undefined;
  };

  for (const words of simpleCommands(command)) {
    const invocation = invokedProgram(words);
    const script = shellScript(invocation);
    if (script !== undefined) {
      const found = shellWrite(script, cwd, root, home);
      if (found) return found;
      continue;
    }
    const { name, args } = invocation;
    const operands = args.filter((word) => word && !word.startsWith("-"));
    if (name === "cd" || name === "pushd") {
      cwd = expand(operands[0] ?? home, cwd, home);
      visited.push(cwd);
      continue;
    }

    let written: string[] = [];
    // The first operand of these is a mode, owner, flag or inline script, not a path.
    const paths = ["chmod", "chown", "chflags"].includes(name) ? operands.slice(1) : operands;
    if (WRITE_ALL.has(name)) written = paths;
    else if (WRITE_LAST.has(name)) written = operands.slice(-1);
    else if ((name === "sed" || name === "perl") && args.some((word) => /^-[^-]*i/.test(word)))
      written = args.includes("-e") ? operands : operands.slice(1);
    else if (name === "git") {
      const at = args.indexOf("-C");
      const repo = at >= 0 && args[at + 1] ? args[at + 1]! : ".";
      const subcommand = args.filter(
        (word, index) => !word.startsWith("-") && args[index - 1] !== "-C",
      )[0];
      if (subcommand && GIT_WRITES.has(subcommand)) written = [repo];
    }
    for (const path of written) {
      const found = inside(path);
      if (found) return found;
    }
  }

  // simpleCommands drops redirection targets, so they are read from the text without quoted strings, relative to any
  // directory the command moved into.
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  for (const [, target] of unquoted.matchAll(/(?<![<>&\d])\d?>>?\|?\s*([^\s;&|<>()]+)/g)) {
    if (target!.startsWith("&") || target === "/dev/null") continue;
    const found = visited.map((from) => inside(target!, from)).find(Boolean);
    if (found) return found;
  }
  return undefined;
}

/** The setup path a tool call would write, or undefined when it writes nothing there. */
export function blockedSetupWrite(
  call: ToolCall,
  root: string,
  home = homedir(),
): string | undefined {
  const input = call.tool_input ?? {};
  const cwd = call.cwd ?? home;
  if (call.tool_name === "Bash")
    return typeof input.command === "string"
      ? shellWrite(input.command, cwd, root, home)
      : undefined;

  const path = input.file_path ?? input.notebook_path;
  if (typeof path !== "string") return undefined;
  const target = expand(path, cwd, home);
  return target === root || target.startsWith(`${root}/`) ? target : undefined;
}
