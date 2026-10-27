// Decides whether a shell command creates or clones a simulator or emulator outside the device pool. Only commands that
// would run are checked: quoted text, arguments, and search patterns that merely mention a device tool pass.

/** Splits shell text into simple commands, each a list of words with quotes removed. */
export function simpleCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  // The word after a redirection is a file name or heredoc delimiter, not an argument.
  let redirect: "file" | "heredoc" | "indented-heredoc" | undefined;
  const heredocs: Array<{ delimiter: string; indented: boolean }> = [];
  const endWord = () => {
    if (redirect && (word || quoted)) {
      if (redirect !== "file") heredocs.push({ delimiter: word, indented: redirect === "indented-heredoc" });
      redirect = undefined;
    } else if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    redirect = undefined;
    if (words.length) commands.push(words);
    words = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;

    if (char === "\\") {
      word += text[++index] ?? "";
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      word += text.slice(index + 1, end < 0 ? undefined : end);
      quoted = true;
      index = end < 0 ? text.length : end;
    } else if (char === '"') {
      // Command substitutions inside double quotes still run, so they are parsed as commands of their own.
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end++;
        else if (text.startsWith("$(", end)) {
          const close = matchingParen(text, end + 1);
          commands.push(...simpleCommands(text.slice(end + 2, close)));
          end = close;
        }
        end++;
      }
      word += text.slice(index + 1, end);
      quoted = true;
      index = end;
    } else if (char === "#" && !word && !quoted) {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end - 1;
    } else if (/\s/.test(char) && char !== "\n") {
      endWord();
    } else if (char === "\n") {
      // Heredoc bodies are data: skip each one through its delimiter line.
      endCommand();
      for (const { delimiter, indented } of heredocs.splice(0)) {
        let start = index + 1;
        while (start < text.length) {
          const end = text.indexOf("\n", start);
          const line = text.slice(start, end < 0 ? undefined : end);
          start = end < 0 ? text.length : end + 1;
          if ((indented ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
        index = start - 1;
      }
    } else if (char === "$" && text[index + 1] === "(") {
      // A substitution runs as commands of its own and stays a word of this command, so `rm -rf $(…)` keeps its target.
      const close = matchingParen(text, index + 1);
      commands.push(...simpleCommands(text.slice(index + 2, close)));
      word += text.slice(index, close + 1);
      index = close;
    } else if (";&|\n()`".includes(char)) {
      endCommand();
    } else if ("<>".includes(char)) {
      endWord();
      if (text.startsWith("<<", index) && !text.startsWith("<<<", index)) {
        index++;
        redirect = text[index + 1] === "-" ? "indented-heredoc" : "heredoc";
        if (redirect === "indented-heredoc") index++;
      } else {
        while ("<>&|".includes(text[index + 1] ?? "x")) index++;
        redirect = "file";
      }
    } else {
      word += char;
    }
  }
  endCommand();
  return commands;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return text.length;
}

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice", "caffeinate", "heavy-run"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const operands = (words: string[]) => words.filter((word) => !word.startsWith("-"));

/** The program a simple command runs, past variable assignments and wrappers such as `sudo`, and its arguments. */
export function invokedProgram(words: string[]): { name: string; args: string[] } {
  let rest = words;
  while (rest.length) {
    const [first, ...tail] = rest;
    if (/^[A-Za-z_]\w*=/.test(first!)) rest = tail;
    else if (WRAPPERS.has(basename(first!)))
      rest = tail.includes("--") ? tail.slice(tail.indexOf("--") + 1) : tail.filter((word) => !word.startsWith("-"));
    else break;
  }
  const [program = "", ...args] = rest;
  return { name: basename(program), args };
}

/** The script a `bash -c`, `sh -c`, or `zsh -c` invocation runs, or undefined for any other program. */
export function shellScript({ name, args }: { name: string; args: string[] }): string | undefined {
  if (!SHELLS.has(name)) return undefined;
  const script = args.findIndex((word) => /^-\w*c\w*$/.test(word));
  return script < 0 ? undefined : (args[script + 1] ?? "");
}

/** The device tool invocation a simple command runs, such as `simctl create`, if it creates or clones a device. */
function deviceCreation(words: string[]): string | undefined {
  const invocation = invokedProgram(words);
  const { name, args } = invocation;
  const script = shellScript(invocation);

  if (script !== undefined) return blockedInvocation(script);
  if (name === "xcrun" || name === "simctl") {
    const simctl = name === "simctl" ? args : args.slice(args.indexOf("simctl") + 1);
    const [subcommand] = operands(simctl);
    return (name === "simctl" || args.includes("simctl")) && (subcommand === "create" || subcommand === "clone")
      ? `simctl ${subcommand}`
      : undefined;
  }
  if (name === "avdmanager") {
    const [subcommand, target] = operands(args);
    return subcommand === "create" && target === "avd" ? "avdmanager create avd" : undefined;
  }
  if (name === "avdslim") return operands(args)[0] === "create" ? "avdslim create" : undefined;
  return undefined;
}

/** The first device-creating invocation in a shell command, or undefined when it creates none. */
export function blockedInvocation(command: string): string | undefined {
  for (const words of simpleCommands(command)) {
    const found = deviceCreation(words);
    if (found) return found;
  }
  return undefined;
}

export const GUARD_MESSAGE =
  'Devices come from the pool: run device-queue acquire <project> <ios|android> [--kind <kind>] --owner "<thread title>" instead of creating or cloning one.';
