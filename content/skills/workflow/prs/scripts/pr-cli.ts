import { spawnSync } from "node:child_process";

export class Stop extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function options(
  argv: string[],
  values: string[],
  flags: string[],
): { target: string; values: Record<string, string>; flags: Set<string> } {
  const parsed = { target: "", values: {} as Record<string, string>, flags: new Set<string>() };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (flags.includes(arg)) {
      parsed.flags.add(arg);
    } else if (values.includes(arg)) {
      const value = argv[++index];

      if (!value || value.startsWith("--") || parsed.values[arg])
        throw new Stop(2, `Missing or repeated ${arg}`);
      parsed.values[arg] = value;
    } else if (!arg.startsWith("-") && !parsed.target) {
      parsed.target = arg;
    } else {
      throw new Stop(2, `Unexpected argument: ${arg}`);
    }
  }

  for (const key of values) if (!parsed.values[key]) throw new Stop(2, `Required: ${key}`);
  if (!parsed.target) throw new Stop(2, "A target is required");

  return parsed;
}

export function prTarget(value: string): { repo: string; number: number } {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(value);

  if (!match) throw new Stop(2, "Expected a github.com pull request URL");

  return { repo: match[1], number: Number(match[2]) };
}

export function remoteRepo(value: string): string | null {
  return (
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      value,
    )?.[1] ?? null
  );
}

export function command(cwd: string, argv: string[], timeout?: number) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

export function finish(receipt: object, code: number, json: boolean): void {
  console.log(json ? JSON.stringify(receipt) : JSON.stringify(receipt, null, 2));
  process.exitCode = code;
}
