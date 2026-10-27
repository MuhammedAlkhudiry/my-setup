// Decides whether a shell command waits by polling: a while or until loop that sleeps, a for loop that sleeps and breaks
// out, or a sleep of five seconds or more followed by a check. Agents spent hours a week in such loops, often on jobs that
// notify when they finish, so the hook points them at ending the turn or one blocking wait-for instead.

import { invokedProgram, shellScript, simpleCommands } from "./device-pool-guard";

/** Shell keywords that can start a simple command ahead of the program it runs. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "fi", "!", "{", "}"]);
const LOOPS = new Set(["while", "until", "for"]);
const LOOP_EXITS = new Set(["break", "exit", "return"]);
const TIMEOUTS = new Set(["timeout", "gtimeout"]);
// Shorter sleeps let a screen or animation settle before a screenshot; they are not waits on a job.
const SETTLE_SECONDS = 5;

type Loop = { keyword: string; readsInput: boolean; sleeps: boolean; exits: boolean };

const withoutKeywords = (words: string[]) => {
  let index = 0;
  while (index < words.length && KEYWORDS.has(words[index]!)) index++;
  return words.slice(index);
};

/** The program past `timeout <duration>`, which only bounds the command it runs. */
function unwrapped(words: string[]): { name: string; args: string[] } {
  const invocation = invokedProgram(words);
  if (!TIMEOUTS.has(invocation.name)) return invocation;

  const rest = [...invocation.args];
  while (rest[0]?.startsWith("-")) {
    const flag = rest.shift()!;
    if (["-s", "-k", "--signal", "--kill-after"].includes(flag)) rest.shift();
  }
  return unwrapped(rest.slice(1));
}

/** Total seconds a sleep waits; a duration it cannot read, such as $DELAY, counts as long. */
export function sleepSeconds(args: string[]): number {
  const units: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  return args
    .filter((arg) => !arg.startsWith("-"))
    .reduce((total, arg) => {
      const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(arg);
      return total + (match ? Number(match[1]) * units[match[2]!]! : Number.POSITIVE_INFINITY);
    }, 0);
}

/** The polling pattern a shell command runs, such as `until loop with sleep`, or undefined when it does not poll. */
export function sleepPoll(command: string): string | undefined {
  const commands = simpleCommands(command);
  const loops: Loop[] = [];

  for (const [index, raw] of commands.entries()) {
    let words = withoutKeywords(raw);
    const keyword = words[0];

    if (keyword === "done") {
      const loop = loops.pop();
      const polls = loop?.sleeps && !loop.readsInput && (loop.keyword !== "for" || loop.exits);
      if (polls) return `${loop.keyword} loop with sleep`;
      continue;
    }
    if (keyword && LOOPS.has(keyword)) {
      // A for loop's header is its word list, not a command; while and until run their condition.
      words = keyword === "for" ? [] : withoutKeywords(words.slice(1));
      loops.push({ keyword, readsInput: invokedProgram(words).name === "read", sleeps: false, exits: false });
    }
    if (!words.length) continue;

    const invocation = unwrapped(words);
    const script = shellScript(invocation);
    const loop = loops.at(-1);
    if (script !== undefined) {
      const found = sleepPoll(script);
      if (found) return found;
    } else if (LOOP_EXITS.has(invocation.name) && loop) {
      loop.exits = true;
    } else if (invocation.name === "sleep" && loop) {
      loop.sleeps = true;
    } else if (
      invocation.name === "sleep" &&
      index < commands.length - 1 &&
      sleepSeconds(invocation.args) >= SETTLE_SECONDS
    ) {
      return `sleep ${invocation.args.join(" ")} then a check`;
    }
  }
  return undefined;
}

export const SLEEP_POLL_MESSAGE =
  "Waiting by sleeping and checking again burns turns and hours. If the job notifies when it finishes (a run_in_background command, a subagent, a PR watch), start it and end the turn. Otherwise block once with a timeout: wait-for [--timeout <seconds>] <file|port|pid|url|cmd> <target>, such as wait-for port 3000 or wait-for --timeout 300 cmd 'gh run view 123 --exit-status'.";
