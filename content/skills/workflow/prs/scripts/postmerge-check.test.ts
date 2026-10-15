import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./postmerge-check.ts", import.meta.url));
const sha = "a".repeat(40);

function invoke(scenario: string, target = "https://github.com/owner/repo/pull/1", timeout = "0") {
  const root = mkdtempSync(join(tmpdir(), "postmerge-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const root=process.env.FIXTURE, scenario=process.env.SCENARIO, sha='${sha}', a=process.argv.slice(2);
appendFileSync(root+'/calls',JSON.stringify(a)+'\\n');
const send=x=>console.log(JSON.stringify(x));
if(a[0]==='pr') send({state:scenario==='unmerged'?'OPEN':'MERGED', mergeCommit:{oid:sha},url:'https://github.com/owner/repo/pull/1'});
else if(a[0]==='run' && a[1]==='list') send(scenario==='absent'?[]:[
{databaseId:999,headSha:'b'.repeat(40),event:'push',createdAt:'2027-01-01'},
{databaseId:100,headSha:sha,event:'pull_request',createdAt:'2027-01-01'},
{databaseId:7,headSha:sha,event:'push',createdAt:'2026-10-13'},
{databaseId:8,headSha:sha,event:'push',createdAt:'2026-10-13'}]);
else if(a[0]==='run' && a[1]==='watch') {writeFileSync(root+'/watched','yes'); console.log('watch diagnostics'); process.exit(scenario==='failure'?1:0);}
else if(a[0]==='api' && a[1].includes('/commits/')) {if(scenario==='missing'){console.error('HTTP 404');process.exit(1);} console.log(sha);}
else if(a[0]==='api' && a[1].includes('/jobs?')) send([{jobs:[]},{jobs:scenario==='failure'?[{name:'backend',conclusion:'failure',html_url:'https://github.com/owner/repo/actions/runs/8/job/2',started_at:'start',completed_at:'end',steps:[{name:'setup',conclusion:'success',number:1},{name:'tests',conclusion:'failure',number:2}]}]:[]}]);
else if(a[0]==='api' && a[1].endsWith('/8')) {
const pending=scenario==='pending'||(scenario==='watch'&&!existsSync(root+'/watched'));
send({id:8,run_attempt:3,head_sha:sha,event:'push',status:pending?'in_progress':'completed',conclusion:pending?null:scenario==='failure'?'failure':'success',html_url:'https://github.com/owner/repo/actions/runs/8',created_at:'queued',run_started_at:'started',updated_at:'ended'});
} else {console.error('Unexpected command: '+JSON.stringify(a));process.exit(9);}
`,
    { mode: 0o755 },
  );

  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        script,
        target,
        "--repo",
        "owner/repo",
        "--workflow",
        "CI",
        "--timeout",
        timeout,
        "--json",
      ],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE: root,
          SCENARIO: scenario,
        },
      },
    );

    return {
      code: result.exitCode,
      receipt: JSON.parse(result.stdout.toString()),
      stderr: result.stderr.toString(),
      calls: readFileSync(join(root, "calls"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("exact commit and push workflow selects the latest run, reporting its exact attempt and timestamps", () => {
  const result = invoke("success");

  expect(result.code).toBe(0);
  expect(result.receipt.mergedSha).toBe(sha);
  expect(result.receipt.run).toMatchObject({
    id: 8,
    attempt: 3,
    queuedAt: "queued",
    startedAt: "started",
    endedAt: "ended",
    conclusion: "success",
  });
  expect(result.receipt.failedStages).toEqual([]);
  expect(result.calls).toContain("/attempts/3/jobs");
  expect(result.calls).not.toContain("/runs/999");
});

test("failed CI reports failed stages and step links across all pages without reverting", () => {
  const result = invoke("failure", sha);

  expect(result.code).toBe(1);
  expect(result.receipt.status).toBe("failed");
  expect(result.receipt.failedStages[0]).toMatchObject({
    name: "backend",
    conclusion: "failure",
    steps: [
      {
        name: "tests",
        conclusion: "failure",
        url: "https://github.com/owner/repo/actions/runs/8/job/2#step:2:1",
      },
    ],
  });
  expect(result.calls).not.toContain("revert");
  expect(result.receipt.nextAction).toContain("nothing was reverted");
});

test("unmerged and absent commits are exit 2; undiscovered or pending runs are exit 75", () => {
  for (const scenario of ["unmerged", "missing"]) expect(invoke(scenario).code).toBe(2);
  for (const scenario of ["absent", "pending"]) {
    const result = invoke(scenario);
    expect(result.code).toBe(75);
    expect(result.receipt.status).toBe("pending");
    expect(result.calls).not.toContain('"watch"');
  }
});

test("CLI watcher diagnostics are quiet and the final receipt uses the completed run", () => {
  const result = invoke("watch", sha, "10");

  expect(result.code).toBe(0);
  expect(result.calls).toContain('"watch","8"');
  expect(result.stderr).toBe("");
  expect(result.receipt.run.status).toBe("completed");
});

test("help and invalid arguments emit one JSON object without needing a checkout", () => {
  for (const args of [
    ["--help", "--json"],
    ["bad", "--json"],
    [sha, "--repo", "owner/repo", "--workflow", "CI", "--timeout", "NaN", "--json"],
  ]) {
    const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: tmpdir() });
    expect(() => JSON.parse(result.stdout.toString())).not.toThrow();
    expect(result.exitCode).toBe(args.includes("--help") ? 0 : 2);
  }
});
