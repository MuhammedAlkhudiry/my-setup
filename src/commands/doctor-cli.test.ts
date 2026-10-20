import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("doctor exposes nonfatal warnings and required failures while keeping clean output compact", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-test-"));
  const logs = new Set<string>();
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/zsh"),
    '#!/bin/sh\ncat "$MY_SETUP_ROOT/report"\nexit "${DOCTOR_TEST_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  const run = (report: string, code = 0, args: string[] = []) => {
    writeFileSync(join(root, "report"), report);
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "doctor-cli.ts"), ...args],
      {
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          MY_SETUP_ROOT: root,
          DOCTOR_TEST_EXIT: String(code),
        },
      },
    );
    const output = child.stdout.toString();
    const errors = child.stderr.toString();
    for (const match of `${output}${errors}`.matchAll(/; log: (.+)/g)) logs.add(match[1]);

    return { output, errors, code: child.exitCode };
  };

  try {
    const report =
      "[ok] bun installed\n[optional] glab install with brew install glab\n[optional] hygiene stale report; run worktree-cleanup\n";
    const warnings = run(report);
    expect(warnings.code).toBe(0);
    expect(warnings.errors).toBe("");
    expect(warnings.output).toContain("warning: glab: install with brew install glab; log:");
    expect(warnings.output).toContain("warning: hygiene: stale report; run worktree-cleanup; log:");
    expect(warnings.output.trim().split("\n")).toHaveLength(3);
    expect(warnings.output).toContain("doctor: 0 failed, 2 warnings");
    for (const log of logs) expect(readFileSync(log, "utf8")).toContain(report);

    const json = run(report, 0, ["--json"]);
    expect(
      JSON.parse(json.output).checks.filter(
        (item: { status: string }) => item.status === "optional",
      ),
    ).toHaveLength(2);
    expect(json.code).toBe(0);
    expect(json.errors).toBe("");
    expect(run(report, 0, ["--verbose"]).output).toBe(report);

    const failed = run(`${report}[required] bun install bun\n`, 1);
    expect(failed.code).toBe(1);
    expect(failed.output).toBe("");
    expect(failed.errors).toContain("required: bun: install bun; log:");
    expect(failed.errors).toContain("warning: glab:");
    expect(failed.errors).toContain("doctor: 1 failed, 2 warnings");

    const clean = run("[ok] bun installed\n");
    expect(clean).toEqual({ output: "doctor: ok\n", errors: "", code: 0 });
  } finally {
    for (const log of logs) rmSync(dirname(log), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
