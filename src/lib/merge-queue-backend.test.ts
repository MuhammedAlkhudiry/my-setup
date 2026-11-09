import { deadlineRunner } from "../commands/merge-queue-signoff-worker";
import { QueueTransientError } from "./merge-queue";
import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubBackend as createBackend } from "./merge-queue-backend";

const githubBackend: typeof createBackend = (repo, execute, options = {}) =>
  createBackend(repo, execute, { hosts: null, ...options });

test("candidate construction, gate, conflict and crash cleanup without remote writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-backend-test-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: { command: string; args: string[]; tag?: string }[] = [];
  let conflict = false;
  let prepareFailure = 0;
  let prepareAlwaysFails = false;
  let prepareTimeouts = 0;
  let prepares = 0;
  let dirty = "";
  let dirtyOnPrepare = "";
  let dirtyAfterSignoff = false;
  let signoffFailures = 0;
  let signoffRuns = 0;
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args, options) => {
      calls.push({
        command,
        args,
        tag: options.env?.VERIFY_RUN_TAG,
      });
      if (args.includes("prepare")) prepares++;
      if (command === "git" && args[0] === "reset") dirty = "";
      if (args.includes("prepare") && dirtyOnPrepare) dirty = dirtyOnPrepare;
      let stdout = "";
      if (args.includes("prepare") && prepares <= prepareTimeouts)
        stdout = "Composer dependencies: bun failed (timeout after 180s)";
      if (args.includes("signoff")) {
        signoffRuns++;
        if (signoffRuns <= signoffFailures)
          stdout = `FAIL mobile:test log=/stage-${signoffRuns}.log`;
      }
      if (command === "git" && args[0] === "status") stdout = dirty;
      if (command === "git" && args[0] === "diff" && dirty.includes("public/js/filament"))
        stdout = "backend/public/js/filament/app.js\0";
      if (command === "git" && args[0] === "restore") dirty = "";
      if (dirtyAfterSignoff && args.includes("signoff")) dirty = "?? generated.tmp";
      if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!);
      if (command === "git" && args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]);
      if (command === "git" && args[0] === "rev-parse")
        stdout = args[1] === "origin/main" ? "base" : "head";
      if (command === "gh" && args[0] === "pr")
        stdout = JSON.stringify({
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          baseRefName: "main",
          headRefOid: "head",
          reviewDecision: "APPROVED",
          changedFiles: 1,
        });
      if (command === "gh" && args[0] === "api")
        stdout = JSON.stringify([[{ filename: "src/app.ts" }]]);
      return {
        stdout,
        all: stdout,
        failed:
          (conflict && command === "git" && args.includes("merge")) ||
          (args.includes("signoff") && signoffRuns <= signoffFailures) ||
          (args.includes("prepare") && prepares <= prepareTimeouts) ||
          (args.includes("prepare") && (prepareAlwaysFails || prepares === prepareFailure)),
      };
    },
    {
      admission: { readLoad: () => 0 },
      readLog: async () => "Exceeded timeout of 5000 ms",
    },
  );
  const entry = {
    repo: "MuhammedAlkhudiry/harium-project",
    pr: 1,
    head: "head",
    status: "queued",
    enqueuedAt: "now",
  } as const;
  try {
    expect(await backend.inspect(entry)).toMatchObject({
      files: [{ path: "src/app.ts" }],
    });
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    const signoff = calls.find((row) => row.command === "mise" && row.args.includes("signoff"));
    expect(signoff).toBeDefined();
    expect(signoff!.args).toContain("--no-post");
    const worktree = calls.find(
      (row) => row.command === "git" && row.args[0] === "worktree" && row.args[1] === "add",
    )!.args[3];
    expect(existsSync(worktree)).toBe(true);
    expect(signoff!.args).not.toContain("--full");

    mkdirSync(join(worktree, "scripts"));
    writeFileSync(join(worktree, "scripts/check.ts"), 'const flags = ["--full", "--base"];');
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    const scoped = calls.findLast((call) => call.args.includes("signoff"))!;
    expect(scoped.args).not.toContain("--full");
    expect(scoped.args.join(" ")).toContain("--no-post --base base");
    const beforeNightly = calls.length;
    expect(await backend.nightly!("base")).toMatchObject({ ok: true });
    const nightly = calls.slice(beforeNightly);
    expect(nightly.find((call) => call.args.includes("signoff"))!.args).toContain("--full");
    expect(nightly.find((call) => call.args.includes("signoff"))!.tag).toBe("nightly");
    expect(signoff!.tag).toBeUndefined();
    expect(nightly.filter((call) => call.args.includes("--base"))).toHaveLength(0);
    expect(nightly.filter((call) => call.args.includes("prepare"))).toHaveLength(1);
    const beforeFull = calls.length;
    expect(await backend.candidate([entry], "base", undefined, { full: true })).toMatchObject({
      ok: true,
    });
    const full = calls.slice(beforeFull);
    expect(full.find((call) => call.args.includes("signoff"))!.args).toContain("--full");
    expect(full.filter((call) => call.args.includes("Queue PR #1"))).toHaveLength(1);
    // One prepare, of the constructed candidate.
    expect(full.filter((call) => call.args.includes("prepare"))).toHaveLength(1);
    const beforeRetry = calls.length;
    signoffFailures = 1;
    signoffRuns = 0;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
      runs: [{ attempt: 1 }, { attempt: 2 }],
    });
    const retried = calls.slice(beforeRetry);
    expect(retried.filter((call) => call.args[0] === "clone")).toHaveLength(0);
    expect(
      retried.filter((call) => call.args[0] === "worktree" && call.args[1] === "add"),
    ).toHaveLength(0);
    expect(retried.some((call) => call.args[0] === "reset" && call.args.includes("base"))).toBe(
      true,
    );
    expect(retried.some((call) => call.args[0] === "clean" && call.args.includes("-fd"))).toBe(
      true,
    );
    expect(retried.filter((call) => call.args.includes("Queue PR #1"))).toHaveLength(1);
    // The retry reuses the first run's remembered passes, rerunning only what failed.
    expect(retried.filter((call) => call.args.includes("--fresh"))).toHaveLength(0);
    expect(retried.filter((call) => call.args.includes("prepare"))).toHaveLength(1);
    signoffFailures = 2;
    signoffRuns = 0;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: false,
      runs: [{ attempt: 1 }, { attempt: 2 }],
    });
    signoffFailures = 0;
    dirtyOnPrepare = " M backend/public/js/filament/app.js";
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    expect(
      calls.some(
        (call) =>
          call.args[0] === "restore" && call.args.includes("backend/public/js/filament/app.js"),
      ),
    ).toBe(true);
    dirtyOnPrepare = "?? linked env";
    const beforeDirty = calls.filter((call) => call.args.includes("signoff")).length;
    await expect(backend.candidate([entry], "base")).rejects.toThrow(
      "Dirty candidate before verification",
    );
    expect(calls.filter((call) => call.args.includes("signoff")).length).toBe(beforeDirty);
    dirty = "";
    dirtyOnPrepare = "";
    dirtyAfterSignoff = true;
    await expect(backend.candidate([entry], "base")).rejects.toThrow(
      "Dirty candidate after sign-off",
    );
    dirtyAfterSignoff = false;
    dirty = "";
    // Plain main fails to prepare too: the environment, not the PR.
    prepares = 0;
    prepareAlwaysFails = true;
    await expect(backend.candidate([entry], "base")).rejects.toThrow("environment broken");
    prepareAlwaysFails = false;
    // Only the candidate fails to prepare: the PR's failure, found with one extra prepare of plain main.
    prepares = 0;
    prepareFailure = 1;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: false,
    });
    expect(prepares).toBe(2);
    prepareFailure = 0;
    prepares = 0;
    prepareTimeouts = 1;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    expect(prepares).toBe(2);
    prepares = 0;
    prepareTimeouts = 2;
    await expect(backend.candidate([entry], "base")).rejects.toThrow("prepare timed out twice");
    prepareTimeouts = 0;
    conflict = true;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: false,
      conflict: 1,
    });
    const stale = join(root, "stale");
    mkdirSync(stale);
    writeFileSync(
      join(root, "merge-queue/candidate-MuhammedAlkhudiry-harium-project.json"),
      JSON.stringify({ root: stale }),
    );
    await backend.recover?.();
    expect(existsSync(stale)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy runs the project's deploy task at the merged SHA and parses its result line", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-deploy-test-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: string[] = [];
  let result = `deploying\ndeployed ${"a".repeat(40)}`;
  let tree = "same";
  let tasks = ["deploy", "deploy:ssh"];
  const backend = githubBackend("MuhammedAlkhudiry/harium-project", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    let stdout = "";
    if (args[0] === "rev-parse") stdout = args[1] === "HEAD^{tree}" ? "same" : tree;
    if (args[0] === "tasks") stdout = JSON.stringify(tasks.map((name) => ({ name })));
    if (args.includes("deploy")) stdout = result;
    return {
      stdout,
      all: stdout,
      failed: args.includes("deploy") && result === "",
    };
  });
  try {
    expect(await backend.deploy("sha")).toMatchObject({
      ok: false,
      error: expect.stringContaining("No candidate worktree"),
    });
    mkdirSync(join(root, "merge-queue/candidates/muhammedalkhudiry-harium-project/candidate"), {
      recursive: true,
    });
    expect(await backend.deploy("sha")).toMatchObject({
      ok: true,
      deployedSha: "a".repeat(40),
    });
    expect(calls).toContain("git reset --hard sha");
    expect(calls).toContain("mise run deploy -- --sha sha");
    expect(calls.some((call) => call.includes("run prepare"))).toBe(false);
    result = `deployed ${"b".repeat(40)}; Forge script unchanged`;
    expect(await backend.deploy("sha")).toMatchObject({
      ok: true,
      deployedSha: "b".repeat(40),
    });
    tree = "other";
    result = "skipped docs only";
    expect(await backend.deploy("sha")).toMatchObject({
      ok: true,
      skipped: "docs only",
    });
    expect(calls.some((call) => call.includes("run prepare"))).toBe(true);
    result = "";
    expect(await backend.deploy("sha")).toMatchObject({ ok: false });
    tasks = ["deploy:ssh"];
    result = "ssh deploy verified";
    expect(await backend.deploy("sha")).toMatchObject({
      ok: true,
      deployedSha: "other",
    });
    expect(calls).toContain("mise run deploy:ssh");
    tasks = [];
    expect(await backend.deploy("sha")).toMatchObject({
      ok: true,
      skipped: expect.stringContaining("no deploy"),
    });
    tasks = ["deploy"];
    result = "all done";
    expect(await backend.deploy("sha")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no result line"),
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check failing twice on the batch and also on main lands the batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-main-broken-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  let mainFails = true;
  let main = "base";
  const onMain: string[] = [];
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args) => {
      if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!);
      if (command === "git" && args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!);
      let stdout = "";
      if (command === "git" && args[0] === "rev-parse")
        stdout = args[1] === "origin/main" ? main : "head";
      const signoff = args.includes("signoff");
      if (signoff) stdout = "FAIL scripts:test-images log=/images.log";
      const check = args.at(-1) === "scripts:test-images";
      if (check) onMain.push(args.at(-1)!);
      return { stdout, all: stdout, failed: signoff || (check && mainFails) };
    },
    {
      admission: { readLoad: () => 0 },
      readLog: async () => "timed out after 30000 ms",
    },
  );
  const entry = {
    repo: "MuhammedAlkhudiry/harium-project",
    pr: 1,
    head: "head",
    status: "queued",
    enqueuedAt: "now",
  } as const;
  try {
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
      brokenOnMain: ["scripts:test-images"],
    });
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    expect(onMain).toHaveLength(1);
    // A full candidate on a held main must pass on its own; main's breakage is no excuse.
    expect(await backend.candidate([entry], "base", undefined, { full: true })).toMatchObject({
      ok: false,
    });
    expect(onMain).toHaveLength(1);
    mainFails = false;
    main = "other";
    expect(await backend.candidate([entry], "other")).toMatchObject({
      ok: false,
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-only candidates run just the named checks, not sign-off", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-check-only-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: string[] = [];
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!);
      if (command === "git" && args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!);
      const stdout =
        command === "git" && args[0] === "rev-parse"
          ? args[1] === "origin/main"
            ? "base"
            : "head"
          : "";
      return { stdout, all: stdout, failed: args.at(-1) === "desktop:test" };
    },
    {
      admission: { readLoad: () => 0 },
      readLog: async () => "assertion failed",
    },
  );
  const entry = {
    repo: "MuhammedAlkhudiry/harium-project",
    pr: 1,
    head: "head",
    status: "queued",
    enqueuedAt: "now",
  } as const;
  try {
    expect(await backend.candidate([entry], "base", ["scripts:test-images"])).toMatchObject({
      ok: true,
    });
    expect(calls.some((call) => call.includes("run signoff"))).toBe(false);
    expect(calls).toContain("mise run scripts:test-images");
    expect(await backend.candidate([entry], "base", ["desktop:test"])).toMatchObject({
      ok: false,
      runs: [{ failures: [{ name: "desktop:test" }] }],
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("update merges main in the PR's own branch, and merge signs the queue's merge commit first", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-update-backend-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "git" && args[0] === "clone")
        mkdirSync(join(args.at(-1)!, ".git"), { recursive: true });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!);
      let stdout = "";
      if (command === "gh" && args[0] === "pr") stdout = "feature-branch\n";
      if (command === "git" && args.includes("--git-common-dir"))
        stdout = join(root, "canonical.git");
      if (command === "git" && args[0] === "rev-parse") stdout = "head";
      return { stdout, all: stdout, failed: command === "mergiraf" };
    },
  );
  const entry = {
    repo: "MuhammedAlkhudiry/harium-project",
    pr: 7,
    head: "head",
    status: "queued",
    enqueuedAt: "now",
  } as const;
  try {
    expect(await backend.update!(entry)).toMatchObject({ status: "current" });
    const fetch = calls.find((call) => call.args.includes("refs/heads/feature-branch"))!;
    expect(fetch.cwd).toEndWith("/update");
    expect(existsSync(join(root, "canonical.git/rr-cache"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "push")).toBe(false);

    await backend.merge({ ...entry, signedHead: "signed1234" });
    const posted = calls.findIndex((call) => call.args.includes("context=signoff"));
    const merged = calls.findIndex((call) => call.args[1] === "merge");
    expect(calls[posted]!.args).toContain("repos/MuhammedAlkhudiry/harium-project/statuses/head");
    expect(posted).toBeLessThan(merged);
    calls.length = 0;
    await backend.merge(entry);
    expect(calls.some((call) => call.args.includes("context=signoff"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("reuse, docs-only admission and sign-off receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-reuse-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: string[] = [];
  let clock = 0;
  let headTree = "candidate-tree";
  let changed = "docs/guide.md";
  const receipt = {
    version: 1,
    checks: [
      { task: "docs:check", status: "passed", seconds: 1.234, reused: false, log: "/docs.log" },
      { task: "format:check", status: "passed", seconds: 0, reused: true, log: null },
    ],
    errors: [],
  };
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!);
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(join(args[3]!, "scripts"), { recursive: true });
        writeFileSync(join(args[3]!, "scripts/check.ts"), 'options: ["--base", "--json"]');
        writeFileSync(join(args[3]!, "scripts/areas.sh"), "");
      }
      if (command.endsWith("scripts/areas.sh")) {
        const backendChange = options.input?.includes("harium/");
        return { stdout: `backend=${backendChange}\nformat=true\n` };
      }
      if (command === "gh")
        return { stdout: JSON.stringify({ statuses: [{ context: "signoff", state: "success" }] }) };
      let stdout = "";
      if (command === "git" && args[0] === "rev-parse")
        stdout =
          args[1] === "origin/main"
            ? "base"
            : args[1] === "HEAD^{tree}"
              ? "candidate-tree"
              : args[1] === "head^{tree}"
                ? headTree
                : "head";
      if (command === "git" && args[0] === "diff" && args.includes("--no-renames"))
        stdout = changed;
      if (args.includes("signoff")) stdout = `mise signoff\n${JSON.stringify(receipt)}`;
      return { stdout, all: stdout };
    },
    {
      // Load stays far above the limit: only a docs-only batch may start without waiting.
      policy: { maxLoad: 1, waitSeconds: 1 },
      admission: {
        readLoad: () => 50,
        now: () => (clock += 500),
        pause: async () => {},
        lock: () => () => {},
      },
    },
  );
  const entry = {
    repo: "MuhammedAlkhudiry/harium-project",
    pr: 1,
    head: "head",
    status: "queued",
    enqueuedAt: "now",
  } as const;
  try {
    // The candidate's tree equals the signed PR head's: land on that sign-off, with no prepare or sign-off run.
    expect(await backend.candidate([entry], "base", undefined, { reuse: true })).toMatchObject({
      ok: true,
      reusedFrom: "head",
    });
    expect(calls.some((call) => call.includes("mise run"))).toBe(false);
    // Without the trusted-main reuse flag the same candidate signs off.
    calls.length = 0;
    const docs = await backend.candidate([entry], "base");
    expect(docs).toMatchObject({
      ok: true,
      runs: [
        {
          checks: [
            { name: "docs:check", status: "passed", seconds: 1.2, reused: false },
            { name: "format:check", status: "passed", seconds: 0, reused: true },
          ],
        },
      ],
    });
    expect(docs.reusedFrom).toBeUndefined();
    expect(calls.some((call) => call.includes("signoff -- --no-post --base base --json"))).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(docs.runs![0]!.receipt!, "utf8"))).toEqual(receipt);
    expect(docs.runs![0]!.receipt).toBe(`${docs.log}.run-1.receipt.json`);
    // A different tree is not covered by the PR's sign-off; a backend change waits for load and times out.
    headTree = "other-tree";
    changed = "harium/app/Models/User.php\ndocs/guide.md";
    await expect(backend.candidate([entry], "base", undefined, { reuse: true })).rejects.toThrow(
      "host busy",
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote worker verifies the transferred commit and treats candidate and main recheck deadlines as transient", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-remote-test-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: { command: string; args: string[] }[] = [];
  const sha = "a".repeat(40);
  let head = "base";
  let timeoutAt = "";
  let missingBase = false;
  try {
    const backend = githubBackend(
      "MuhammedAlkhudiry/harium-project",
      deadlineRunner(async (command, args) => {
        calls.push({ command, args });
        if (command === "git" && args[0] === "clone") mkdirSync(args.at(-1)!);
        if (command === "git" && args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!);
        if (command === "git" && args[0] === "reset") head = args[2]!;
        const stdout =
          command === "git" && args[0] === "rev-parse"
            ? args[1] === "origin/main"
              ? "base"
              : args[1] === "FETCH_HEAD"
                ? sha
                : head
            : "";
        const signoff = args.includes("signoff");
        const recheck = args.at(-1) === "api:test";
        const timedOut = timeoutAt === "candidate" ? signoff : timeoutAt === "main" && recheck;
        const output = timeoutAt === "main" && signoff ? "FAIL api:test log=/api.log" : stdout;
        return {
          stdout: output,
          all: output,
          failed:
            timedOut ||
            (timeoutAt === "main" && signoff) ||
            (missingBase && args[0] === "cat-file"),
          timedOut,
        };
      }, Date.now() + 60_000),
      {
        hosts: null,
        preparedCandidate: { sha, bundle: "/transfer.bundle" },
        admission: { readLoad: () => 0 },
        readLog: async () => "timed out after 30000 ms",
      },
    );
    const result = await backend.candidate(
      [
        {
          repo: "MuhammedAlkhudiry/harium-project",
          pr: 42,
          head: "pr-head",
          status: "queued",
          enqueuedAt: "now",
        },
      ],
      "base",
    );
    for (const scenario of ["candidate", "main"]) {
      timeoutAt = scenario;
      await expect(
        backend.candidate(
          [
            {
              repo: "MuhammedAlkhudiry/harium-project",
              pr: 42,
              head: "pr-head",
              status: "queued",
              enqueuedAt: "now",
            },
          ],
          "base",
        ),
      ).rejects.toBeInstanceOf(QueueTransientError);
    }
    timeoutAt = "";
    expect(result.ok).toBe(true);
    expect(head).toBe("base");
    expect(
      calls
        .filter((call) => call.command === "git" && call.args[0] === "fetch")
        .map((call) => call.args)
        .filter((_args, i) => i === 0),
    ).toEqual([["fetch", "/transfer.bundle", "refs/heads/merge-queue-transfer"]]);
    expect(calls.some((call) => call.command === "gh" || call.args.includes("--squash"))).toBe(
      false,
    );
    expect(
      calls.some((call) => call.command === "mise" && call.args.includes("signoff")),
    ).toBe(true);
    missingBase = true;
    await backend.candidate([], "base");
    expect(
      calls.some((call) => call.command === "git" && call.args.join(" ") === "fetch origin base"),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("main dispatch transfers a delta and forces local prepare before deploy after remote success", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-dispatch-test-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: string[][] = [];
  let head = "base";
  let prepared = false;
  try {
    const backend = githubBackend(
      "MuhammedAlkhudiry/harium-project",
      async (command, args, options) => {
        calls.push([command, ...args]);
        let stdout = "";
        if (command === "git") {
          if (args[0] === "clone") mkdirSync(args.at(-1)!);
          if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!);
          if (args[0] === "reset") head = args[2]!;
          if (args.includes("commit")) head = "candidate";
          if (args[0] === "bundle") writeFileSync(args[2]!, "delta");
          if (args[0] === "rev-parse")
            stdout =
              args[1] === "origin/main"
                ? "base"
                : args[1]!.endsWith("^{tree}")
                  ? "same-tree"
                  : head === "base"
                    ? "pr-head"
                    : head;
        }
        if (command === "ssh") {
          if (args.at(-1)!.includes("--probe")) stdout = JSON.stringify({ load: 0, maxLoad: 10 });
          else {
            const request = JSON.parse(options.input!);
            expect(request).toMatchObject({
              base: "base",
              sha: "candidate",
              bundle: Buffer.from("delta").toString("base64"),
            });
            stdout = JSON.stringify({
              result: { ok: true, log: "/remote/candidate.log" },
              logs: { "/remote/candidate.log": "passed" },
            });
          }
        }
        if (args.includes("prepare")) prepared = true;
        if (args[0] === "tasks") stdout = JSON.stringify([{ name: "deploy" }]);
        if (args.includes("deploy")) {
          expect(prepared).toBe(true);
          stdout = `deployed ${"a".repeat(40)}`;
        }
        return { stdout, all: stdout, failed: false };
      },
      { hosts: ["small-mac"] },
    );
    const result = await backend.candidate(
      [
        {
          repo: "MuhammedAlkhudiry/harium-project",
          pr: 1,
          head: "pr-head",
          status: "queued",
          enqueuedAt: "now",
        },
      ],
      "base",
    );
    expect(result.ok).toBe(true);
    expect(prepared).toBe(false);
    expect(head).toBe("candidate");
    const candidateRoot = join(root, "merge-queue/candidates/muhammedalkhudiry-harium-project");
    expect(existsSync(join(candidateRoot, "unprepared"))).toBe(true);
    expect(existsSync(join(candidateRoot, "transfer.bundle"))).toBe(false);
    expect(calls.find((call) => call[1] === "bundle")?.at(-1)).toBe(
      "base..refs/heads/merge-queue-transfer",
    );
    expect(await backend.deploy("a".repeat(40))).toMatchObject({ ok: true });
    expect(prepared).toBe(true);
    expect(existsSync(join(candidateRoot, "unprepared"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trusted-main candidate signs off only areas changed on both sides, and a held main only those since it was trusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-areas-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const canonical = join(root, "canonical.git");
  const calls: string[] = [];
  // Paths each diff changes, by its two ends.
  let diffs: Record<string, string> = {};
  let ancestor = true;
  let fetched = "";
  const backend = githubBackend(
    "MuhammedAlkhudiry/harium-project",
    async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "clone")
        mkdirSync(join(args.at(-1)!, ".git/check-stamps"), { recursive: true });
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        mkdirSync(join(args[3]!, "scripts"), { recursive: true });
        writeFileSync(
          join(args[3]!, "scripts/check.ts"),
          'options: ["--base", "--areas", "--full"]',
        );
        writeFileSync(join(args[3]!, "scripts/areas.sh"), "");
      }
      if (command.endsWith("scripts/areas.sh")) {
        const paths = options.input!.split("\n");
        return {
          stdout: [
            `backend=${paths.some((path) => path.startsWith("harium/"))}`,
            `mobile=${paths.some((path) => path.startsWith("harium-app/"))}`,
          ].join("\n"),
        };
      }
      if (command === "gh") return { stdout: JSON.stringify({ statuses: [] }) };
      const pull = args.at(-1)?.match(/^refs\/pull\/(\d+)\/head$/);
      if (pull) fetched = `head${pull[1]}`;
      let stdout = "";
      if (command === "git" && args[1] === "FETCH_HEAD") stdout = fetched;
      else if (command === "git" && args.includes("--git-common-dir")) stdout = canonical;
      else if (command === "git" && args[0] === "rev-parse")
        stdout =
          args[1] === "origin/main"
            ? "base"
            : args[1] === "HEAD^{tree}"
              ? "candidate-tree"
              : "head";
      if (command === "git" && args[0] === "merge-base" && args[1] !== "--is-ancestor")
        stdout = `mb-${args[1]}`;
      if (command === "git" && args[0] === "diff" && args.includes("--name-only"))
        stdout = diffs[`${args.at(-2)}..${args.at(-1)}`] ?? "";
      return {
        stdout,
        all: stdout,
        failed: command === "git" && args[1] === "--is-ancestor" && !ancestor,
      };
    },
    { admission: { readLoad: () => 0 } },
  );
  const entry = (pr: number, head: string, signedHead?: string) =>
    ({
      repo: "MuhammedAlkhudiry/harium-project",
      pr,
      head,
      ...(signedHead ? { signedHead } : {}),
      status: "queued",
      enqueuedAt: "now",
    }) as const;
  const signoff = () => calls.findLast((call) => call.includes("run signoff"));
  try {
    // Main moved only in mobile since the PR's signed base, and the PR changed only the backend: nothing to recheck.
    diffs = {
      "mb-signed1..signed1": "harium/app/Models/User.php",
      "mb-signed1..base": "harium-app/app/index.tsx",
    };
    expect(
      await backend.candidate([entry(1, "head1", "signed1")], "base", undefined, { reuse: true }),
    ).toMatchObject({ ok: true, areas: [] });
    expect(calls.some((call) => call.includes("mise run"))).toBe(false);
    // The candidate clone shares the canonical clone's remembered check passes.
    const stamps = join(
      root,
      "merge-queue/candidates/muhammedalkhudiry-harium-project/repo/.git/check-stamps",
    );
    expect(lstatSync(stamps).isSymbolicLink()).toBe(true);
    expect(readlinkSync(stamps)).toBe(join(canonical, "check-stamps"));

    // Main also changed the backend: only the backend signs off again, with one prepare.
    diffs["mb-signed1..base"] += "\nharium/routes/api.php";
    calls.length = 0;
    expect(
      await backend.candidate([entry(1, "head1", "signed1")], "base", undefined, { reuse: true }),
    ).toMatchObject({ ok: true, areas: ["backend"] });
    expect(signoff()).toContain("--no-post --areas backend");
    expect(calls.filter((call) => call.includes("prepare"))).toHaveLength(1);

    // Two PRs in one batch on unchanged main: each one's areas the other changed too.
    diffs = {
      "mb-head1..head1": "harium-app/app/index.tsx",
      "mb-head2..head2": "harium-app/app/other.tsx\nharium/app/Models/User.php",
    };
    expect(
      await backend.candidate([entry(1, "head1"), entry(2, "head2")], "base", undefined, {
        reuse: true,
      }),
    ).toMatchObject({ ok: true, areas: ["mobile"] });
    expect(signoff()).toContain("--areas mobile");

    // Without the trusted-main flag, the batch signs off every area it changed.
    expect(await backend.candidate([entry(1, "head1")], "base")).not.toHaveProperty("areas");
    expect(signoff()).toContain("--no-post --base base");

    // A held main signs off the areas changed since the last trusted main, or every area if that is not an ancestor.
    await backend.nightly!("base", { since: "trusted" });
    expect(signoff()).toContain("--no-post --base trusted");
    await backend.candidate([entry(1, "head1")], "base", undefined, { since: "trusted" });
    expect(signoff()).toContain("--no-post --base trusted");
    ancestor = false;
    await backend.nightly!("base", { since: "trusted" });
    expect(signoff()).toContain("--no-post --full");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
