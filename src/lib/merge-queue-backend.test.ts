import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubBackend } from "./merge-queue-backend";

test("candidate construction, uncapped gate, conflict and crash cleanup without remote writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-backend-test-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const calls: { command: string; args: string[]; uncapped?: string }[] = [];
  let conflict = false;
  let prepareFailure = 0;
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
      calls.push({ command, args, uncapped: options.env?.HEAVY_RUN_UNCAPPED });
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
          (args.includes("prepare") && prepares === prepareFailure),
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
    const signoff = calls.find(
      (row) => row.command === "heavy-run" && row.args.includes("signoff"),
    );
    expect(signoff).toMatchObject({ uncapped: "1" });
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
    expect(nightly.filter((call) => call.args.includes("--base"))).toHaveLength(0);
    expect(nightly.filter((call) => call.args.includes("prepare"))).toHaveLength(1);
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
    expect(retried.filter((call) => call.args.includes("--fresh"))).toHaveLength(1);
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
      "Dirty candidate after plain main prepare",
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
    prepares = 0;
    prepareFailure = 1;
    await expect(backend.candidate([entry], "base")).rejects.toThrow("environment broken");
    prepares = 0;
    prepareFailure = 2;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: false,
    });
    prepareFailure = 0;
    prepares = 0;
    prepareTimeouts = 1;
    expect(await backend.candidate([entry], "base")).toMatchObject({
      ok: true,
    });
    expect(prepares).toBe(3);
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
    expect(calls).toContain("heavy-run --class checks --wait 3600 -- mise run scripts:test-images");
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
