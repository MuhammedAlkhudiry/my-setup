import { join } from "node:path";

export const WORKER_TOOL_PROBE =
  'for tool in php composer bun mise gh; do resolved=$(command -v "$tool") || { print -r -- "missing tool: $tool"; exit 1; }; print -r -- "$tool=$resolved"; done';

// Source the managed shell explicitly: a noninteractive login shell does not read .zshrc.
export function workerShellArguments(rootDir: string, command: string[]) {
  return [
    "-lc",
    'source "$1" || exit; shift; exec "$@"',
    "merge-queue",
    join(rootDir, "shell/zsh-custom.zsh"),
    ...command,
  ];
}
