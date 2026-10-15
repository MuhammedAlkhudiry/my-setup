import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./pr-refresh.ts", import.meta.url));

function fixture(conflict = false) {
  const root = mkdtempSync(join(tmpdir(), "pr-refresh-test-"));
  const source = join(root, "source");
  const cwd = join(root, "checkout");
  const bin = join(root, "bin");
  const git = (at: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: at });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    return result.stdout.toString().trim();
  };
  mkdirSync(source);
  mkdirSync(bin);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.com");
  writeFileSync(join(source, "app.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(source, "checkout", "-b", "feature");
  writeFileSync(join(source, "app.txt"), "feature\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "feature");
  const head = git(source, "rev-parse", "HEAD");
  git(source, "update-ref", "refs/pull/1/head", head);
  git(source, "checkout", "main");
  writeFileSync(join(source, conflict ? "app.txt" : "base.txt"), "new base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base moved");
  git(root, "clone", "--branch", "feature", source, cwd);
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.com");
  // Keep the declared identity real while redirecting Git's transport to a local fixture.
  git(cwd, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
  git(cwd, "config", `url.${source}.insteadOf`, "https://github.com/owner/repo.git");
  const realGit = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE: root,
    FIXTURE_GIT: realGit,
  };
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, existsSync } = require('node:fs');
const root = process.env.FIXTURE;
const git = (...args) => spawnSync(process.env.FIXTURE_GIT, args, {cwd: root + '/source', encoding:'utf8'}).stdout.trim();
const a = process.argv.slice(2);
if (a[0] === 'pr') { git('update-ref','refs/pull/1/head',git('rev-parse','feature')); console.log(JSON.stringify({id:'PR1',state:'OPEN',baseRefName:'main',headRefName:'feature',headRefOid:git('rev-parse','feature'),isCrossRepository:false,isDraft:true,url:'https://github.com/owner/repo/pull/1'})); }
else process.exit(9);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "mise"),
    `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync, unlinkSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = process.env.FIXTURE;
const a = process.argv.slice(2);
if (a[0] === 'tasks') console.log(JSON.stringify(['check','signoff'].map(name=>({name,source:process.cwd()+'/mise.toml'}))));
else { appendFileSync(root+'/calls',a[1]+'\\n');
if(a[1]==='signoff' && existsSync(root+'/behind-main')) {
  const mode = readFileSync(root+'/behind-main','utf8');
  const git = (...args) => spawnSync(process.env.FIXTURE_GIT,args,{cwd:root+'/source'});
  writeFileSync(root+'/source/'+(mode==='conflict'?'app.txt':'queued.txt'), 'main moved '+Date.now());
  git('add','.'); git('commit','-m','main moved while queued');
  if(mode!=='always') unlinkSync(root+'/behind-main');
  console.log(JSON.stringify({command:'signoff',errors:[{item:'signoff-behind-main'}]})); process.exit(1);
}
console.log(a[1]==='signoff' ? JSON.stringify({command:'signoff',errors:[]}) : 'check output');
if(a[1]==='check' && existsSync(root+'/move-base')) spawnSync(process.env.FIXTURE_GIT,['update-ref','refs/heads/main','refs/heads/feature'],{cwd:root+'/source'});
if(existsSync(root+'/fail-'+a[1])) process.exit(1); }
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "heavy-run"),
    `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const a=process.argv.slice(2); const result=spawnSync(a[a.indexOf('--')+1],a.slice(a.indexOf('--')+2),{encoding:'utf8'});
if(a.includes('--json')) { const log=process.env.FIXTURE+'/heavy.log'; require('node:fs').writeFileSync(log,result.stdout+result.stderr); console.log(JSON.stringify({log,childExitCode:result.status})); } else { process.stdout.write(result.stdout); process.stderr.write(result.stderr); } process.exit(result.status);
`,
    { mode: 0o755 },
  );
  const invoke = (...extra: string[]) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        script,
        "https://github.com/owner/repo/pull/1",
        "--repo",
        cwd,
        "--expected-head",
        head,
        "--json",
        ...extra,
      ],
      { cwd: tmpdir(), env },
    );

    return {
      code: result.exitCode,
      receipt: JSON.parse(result.stdout.toString()),
      stderr: result.stderr.toString(),
    };
  };

  return {
    root,
    source,
    cwd,
    git,
    head,
    invoke,
    calls: () => (existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : ""),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("dry-run is read-only; a real refresh merges, pushes normally, certifies the new head", () => {
  const f = fixture();

  try {
    expect(f.invoke("--dry-run").code).toBe(0);
    expect(f.git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.cwd, "for-each-ref", "refs/triage-prs")).toBe("");
    expect(f.calls()).toBe("");
    const result = f.invoke();
    expect(result.code).toBe(0);
    expect(result.receipt.status).toBe("certified");
    expect(result.receipt.draft).toBe(true);
    const pushed = f.git(f.source, "rev-parse", "feature");
    expect(pushed).not.toBe(f.head);
    expect(result.receipt.checkReceipt.head).toBe(pushed);
    expect(f.git(f.cwd, "rev-parse", "HEAD")).toBe(pushed);
    expect(f.calls()).toBe("check\nsignoff\n");
    expect(existsSync(join(f.cwd, ".git", "pr-refresh-state.json"))).toBe(false);
    expect(result.stderr).toBe("");
    expect(
      result.receipt.stages.some((stage: { output?: string }) =>
        stage.output?.includes("check output"),
      ),
    ).toBe(true);
  } finally {
    f.cleanup();
  }
}, 20000);

test("dirty, stale and locked checkouts stop before any checks or push", () => {
  const f = fixture();

  try {
    writeFileSync(join(f.cwd, "untracked"), "dirty");
    expect(f.invoke().code).toBe(3);
    rmSync(join(f.cwd, "untracked"));
    writeFileSync(join(f.cwd, ".git", "pr-refresh.lock"), "other owner");
    expect(f.invoke().code).toBe(3);
    expect(readFileSync(join(f.cwd, ".git", "pr-refresh.lock"), "utf8")).toBe("other owner");
    rmSync(join(f.cwd, ".git", "pr-refresh.lock"));
    f.git(f.source, "update-ref", "refs/heads/feature", f.git(f.source, "rev-parse", "main"));
    expect(f.invoke().code).toBe(4);
    expect(f.calls()).toBe("");
    expect(f.git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
  } finally {
    f.cleanup();
  }
}, 20000);

test("conflict preserves the merge; rerunning after an explicit resolution resumes using the original expected head", () => {
  const f = fixture(true);

  try {
    const conflict = f.invoke();
    expect(conflict.code).toBe(3);
    expect(conflict.receipt.resume.conflicts).toEqual(["app.txt"]);
    expect(f.git(f.cwd, "rev-parse", "MERGE_HEAD")).toBe(f.git(f.source, "rev-parse", "main"));
    expect(f.calls()).toBe("");
    writeFileSync(join(f.cwd, "app.txt"), "resolved\n");
    f.git(f.cwd, "add", "app.txt");
    f.git(f.cwd, "commit", "-m", "resolve");
    expect(f.invoke().code).toBe(0);
    expect(f.calls()).toBe("check\nsignoff\n");
  } finally {
    f.cleanup();
  }
}, 20000);

test("failed checks never push, failed sign-off preserves resume state, and both can resume", () => {
  const f = fixture();

  try {
    writeFileSync(join(f.root, "fail-check"), "fail");
    const failed = f.invoke();
    expect(failed.code).toBe(1);
    expect(failed.receipt.resume.phase).toBe("checks");
    expect(f.git(f.source, "rev-parse", "feature")).toBe(f.head);
    rmSync(join(f.root, "fail-check"));
    writeFileSync(join(f.root, "fail-signoff"), "fail");
    expect(f.invoke().code).toBe(1);
    rmSync(join(f.root, "fail-signoff"));
    expect(f.invoke().code).toBe(0);
    expect(f.calls()).toBe("check\ncheck\nsignoff\nsignoff\n");
  } finally {
    f.cleanup();
  }
}, 20000);

test("invalid input and help each keep --json stdout to a single object from any working directory", () => {
  for (const args of [
    ["--help", "--json"],
    ["bad", "--json"],
  ]) {
    const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: tmpdir() });
    expect(() => JSON.parse(result.stdout.toString())).not.toThrow();
    expect(result.exitCode).toBe(args.includes("--help") ? 0 : 2);
  }
}, 20000);

test("base movement during checks stops with exit 4 before push or certification", () => {
  const f = fixture();

  try {
    writeFileSync(join(f.root, "move-base"), "move");
    const result = f.invoke();
    expect(result.code).toBe(4);
    expect(result.receipt.resume.phase).toBe("checks");
    expect(f.git(f.source, "rev-parse", "feature")).toBe(f.head);
    expect(f.calls()).toBe("check\n");
  } finally {
    f.cleanup();
  }
}, 20000);

test("main moving while sign-off waits is refreshed and pushed; retries are bounded and conflicts stop", () => {
  for (const mode of ["once", "always", "conflict"]) {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "behind-main"), mode);
      const result = f.invoke();
      expect(result.code).toBe(mode === "once" ? 0 : mode === "conflict" ? 3 : 1);
      expect(f.calls().split("signoff\n").length - 1).toBe(
        mode === "always" ? 3 : mode === "once" ? 2 : 1,
      );
      if (mode === "once") {
        expect(
          f.git(f.cwd, "merge-base", "--is-ancestor", f.git(f.source, "rev-parse", "main"), "HEAD"),
        ).toBe("");
        expect(f.git(f.source, "rev-parse", "feature")).toBe(result.receipt.checkReceipt.head);
      }
      if (mode === "conflict") {
        expect(result.receipt.resume.conflicts).toEqual(["app.txt"]);
        writeFileSync(join(f.cwd, "app.txt"), "resolved after queued main moved\n");
        f.git(f.cwd, "add", "app.txt");
        f.git(f.cwd, "commit", "-m", "resolve retry conflict");
        expect(f.invoke().code).toBe(0);
      }
    } finally {
      f.cleanup();
    }
  }
}, 30000);
