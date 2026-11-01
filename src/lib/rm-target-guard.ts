// Decides whether a shell command removes a path built from a variable or command output, such as `rm -rf "$(dirname $d)"`.
// Claude Code's built-in safety check asks a person to approve such a removal even in bypass mode, which stalls unattended
// agents, so the hook blocks it first and tells the agent to remove the literal path instead.

import { invokedProgram, shellScript, simpleCommands } from "./device-pool-guard";

const REMOVERS = new Set(["rm", "rmdir"]);

/** The first removal with an unresolved target, such as `rm $dir`, or undefined when every target is literal. */
export function unresolvedRemoval(command: string): string | undefined {
  for (const words of simpleCommands(command)) {
    const invocation = invokedProgram(words);
    const script = shellScript(invocation);
    const found =
      script !== undefined
        ? unresolvedRemoval(script)
        : REMOVERS.has(invocation.name)
          ? invocation.args.find((word) => !word.startsWith("-") && word.includes("$"))
          : undefined;
    if (found) return script !== undefined ? found : `${invocation.name} ${found}`;
  }
  return undefined;
}

/** The first zsh expansion flag, such as `${(f)…}` or `${=list}`, outside heredoc bodies. */
export function zshExpansionFlag(command: string): string | undefined {
  const lines: string[] = [];
  let heredoc: { delimiter: string; indented: boolean } | undefined;
  for (const line of command.split("\n")) {
    if (heredoc) {
      if ((heredoc.indented ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) heredoc = undefined;
      continue;
    }
    lines.push(line);
    const start = line.match(/<<(-?)\s*['"]?([\w.-]+)['"]?/);
    if (start && !line.includes("<<<")) heredoc = { delimiter: start[2]!, indented: start[1] === "-" };
  }
  return lines.join("\n").match(/\$\{[(=~^](?:[^{}]|\{[^}]*\})*\}?/)?.[0];
}

// Claude Code's safety check cannot parse these flags, so it asks a person to approve the command even in bypass mode.
export const ZSH_FLAG_MESSAGE =
  "Claude Code asks a person to approve inline zsh expansion flags, such as ${(f)...} or ${=...}, even in bypass mode. Put the logic in a script file (bun or bash) and run that instead.";

export const RM_GUARD_MESSAGE =
  "Claude Code asks a person to approve rm on a target built from a variable or $(...), even in bypass mode. Print the path first, then remove it by its literal path, such as rm -rf /tmp/demo.Ab12.";
