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

export const RM_GUARD_MESSAGE =
  "Claude Code asks a person to approve rm on a target built from a variable or $(...), even in bypass mode. Print the path first, then remove it by its literal path, such as rm -rf /tmp/demo.Ab12.";
