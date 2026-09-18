import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import { ACTIVE_PROJECTS } from "../../config/active-projects";
import { resolveProjectId } from "./plans";

const script = join(dirname(fileURLToPath(import.meta.url)), "plans-cli.ts");

function writePlan(
  root: string,
  project: string,
  file: string,
  title: string,
  status?: "pending" | "progress" | "done",
): void {
  const projectRoot = join(root, project);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, file),
    [
      "---",
      "created: 2026-06-01",
      "updated: 2026-06-02",
      `project: ${project}`,
      `description: ${title} summary`,
      ...(status ? [`status: ${status}`] : []),
      "---",
      "",
      `# ${title}`,
      "",
    ].join("\n"),
  );
}

describe("plans list", () => {
  test("returns stored and configured projects in the JSON contract", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "checkout");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "base.md", "Base Plan");
      writePlan(plansRoot, "other-project", "other.md", "Other Plan");

      const result = spawnSync(
        "bun",
        [script, "list", "--all", "--json", `--plans-root=${plansRoot}`],
        {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            LANES_CONFIG_PATH: join(fixture, "missing-lanes.json"),
            LANES_STATE_PATH: join(fixture, "missing-state.json"),
            LANES_STATE_LOCK_PATH: join(fixture, "missing-state.lock"),
          },
        },
      );
      const document = JSON.parse(result.stdout) as {
        contractVersion: number;
        plansRoot: string;
        projects: Array<{
          id: string;
          plans: Array<{
            title: string;
            path: string;
            status: "pending" | "progress" | "done";
          }>;
        }>;
      };

      expect(result.status).toBe(0);
      expect(document.contractVersion).toBe(2);
      expect(document.plansRoot).toBe(plansRoot);
      expect(document.projects.map((project) => project.id)).toEqual(
        expect.arrayContaining([
          "example-project",
          "other-project",
          ...ACTIVE_PROJECTS.map((project) => project.id),
        ]),
      );
      const example = document.projects.find((project) => project.id === "example-project");
      expect(example?.plans[0].title).toBe("Base Plan");
      expect(example?.plans[0].path).toBe(join(plansRoot, "example-project", "base.md"));
      expect(example?.plans[0].status).toBe("pending");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("lists configured projects before any plan directory exists", () => {
    const fixture = mkdtempSync(join(tmpdir(), "plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "checkout");

    try {
      mkdirSync(plansRoot, { recursive: true });
      mkdirSync(checkout, { recursive: true });

      const result = spawnSync(
        "bun",
        [script, "list", "--all", "--json", `--plans-root=${plansRoot}`],
        { cwd: checkout, encoding: "utf8" },
      );
      const document = JSON.parse(result.stdout) as {
        projects: Array<{ id: string; plans: unknown[] }>;
      };

      expect(result.status).toBe(0);
      expect(document.projects.map((project) => project.id)).toEqual(
        ACTIVE_PROJECTS.map((project) => project.id),
      );
      expect(document.projects.every((project) => project.plans.length === 0)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("falls back to the directory name outside a registered environment", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "unconfigured-checkout");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "unconfigured-checkout", "local.md", "Local Plan");

      const result = spawnSync("bun", [script, "list", `--plans-root=${plansRoot}`], {
        cwd: checkout,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("unconfigured-checkout plans");
      expect(result.stdout).toContain("local.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("keeps explicit project listing scoped to that project", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "base.md", "Base Plan");
      writePlan(plansRoot, "example-project-auth", "auth.md", "Auth Plan");

      const result = spawnSync(
        "bun",
        [script, "list", "--project=example-project", `--plans-root=${plansRoot}`],
        {
          cwd: checkout,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Projects:");
      expect(result.stdout).toContain("base.md");
      expect(result.stdout).not.toContain("auth.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("plans create", () => {
  test("creates the first saved plan and index in an empty plans root", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");
    const planPath = join(plansRoot, "example-project", "billing-brief.md");

    try {
      mkdirSync(checkout, { recursive: true });
      const body = [
        "## 🛠️ Technical Decisions",
        "",
        "- Store billing preferences on the account.",
        "",
        "## ✅ Acceptance Cases",
        "",
        "- As an owner, I can update the billing contact so invoices reach the right person.",
        "",
      ].join("\n");

      const result = spawnSync(
        "bun",
        [
          script,
          "create",
          "billing-brief",
          "--project=example-project",
          "--description=Define the billing preference contract",
          `--plans-root=${plansRoot}`,
        ],
        { cwd: checkout, encoding: "utf8", input: body },
      );
      const saved = readFileSync(planPath, "utf8");
      const index = readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8");

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(planPath);
      expect(saved).toMatch(/^created: \d{4}-\d{2}-\d{2}$/m);
      expect(saved).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
      expect(saved).toContain("project: example-project");
      expect(saved).toContain("description: Define the billing preference contract");
      expect(saved).toContain("status: pending");
      expect(saved).toContain("# Billing Brief");
      expect(saved).toContain(body.trim());
      expect(index).toContain("[Billing Brief](billing-brief.md) - pending");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("does not overwrite an existing plan", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");
    const planPath = join(plansRoot, "example-project", "billing-brief.md");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "billing-brief.md", "Existing Billing Brief");

      const result = spawnSync(
        "bun",
        [
          script,
          "create",
          "billing-brief",
          "--project=example-project",
          "--description=Replacement content",
          `--plans-root=${plansRoot}`,
        ],
        { cwd: checkout, encoding: "utf8", input: "## Replacement" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Plan already exists: ${planPath}`);
      expect(readFileSync(planPath, "utf8")).toContain("# Existing Billing Brief");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("plans save", () => {
  test("saves edited content, refreshes the updated date, and rewrites the index", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");
    const planPath = join(plansRoot, "example-project", "billing.md");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "billing.md", "Billing Plan");
      const edited = [
        "---",
        "created: 2026-06-01",
        "updated: 2020-01-01",
        "project: example-project",
        "description: Revised billing work",
        "---",
        "",
        "# Billing Plan",
        "",
        "Review the revised flow.",
        "",
      ].join("\n");

      const result = spawnSync(
        "bun",
        [
          script,
          "save",
          "billing.md",
          "--project=example-project",
          `--plans-root=${plansRoot}`,
        ],
        { cwd: checkout, encoding: "utf8", input: edited },
      );
      const saved = readFileSync(planPath, "utf8");
      const index = readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8");

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(planPath);
      expect(saved).toContain("Review the revised flow.");
      expect(saved).not.toContain("updated: 2020-01-01");
      expect(saved).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
      expect(saved).toContain("status: pending");
      expect(index).toContain("[Billing Plan](billing.md)");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("plans status", () => {
  test("sets the strict pending, progress, or done status and refreshes the index", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");
    const planPath = join(plansRoot, "example-project", "billing.md");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "billing.md", "Billing Plan");

      const progressResult = spawnSync(
        "bun",
        [script, "status", "billing.md", "--status=progress", `--plans-root=${plansRoot}`],
        { cwd: checkout, encoding: "utf8" },
      );
      const progressing = readFileSync(planPath, "utf8");
      const progressIndex = readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8");

      expect(progressResult.status).toBe(0);
      expect(progressing).toContain("status: progress");
      expect(progressIndex).toContain(" - progress - updated ");

      const result = spawnSync(
        "bun",
        [script, "status", "billing.md", "--status=done", `--plans-root=${plansRoot}`],
        { cwd: checkout, encoding: "utf8" },
      );
      const saved = readFileSync(planPath, "utf8");
      const index = readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8");

      expect(result.status).toBe(0);
      expect(saved).toContain("status: done");
      expect(index).toContain(" - done - updated ");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("plans archive", () => {
  test("archives the matching plan without changing frontmatter", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "example-project");
    const projectRoot = join(plansRoot, "example-project");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "billing.md", "Billing Plan");
      writePlan(plansRoot, "example-project", "editor.md", "Editor Plan");

      const result = spawnSync(
        "bun",
        [script, "archive", "billing", `--plans-root=${plansRoot}`],
        {
          cwd: checkout,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Archived 1 plan.");
      expect(result.stdout).toContain(join(projectRoot, "archive", "billing.md"));
      expect(result.stderr).toBe("");
      expect(existsSync(join(projectRoot, "billing.md"))).toBe(false);

      const archivedPlan = readFileSync(join(projectRoot, "archive", "billing.md"), "utf8");
      const index = readFileSync(join(projectRoot, "INDEX.md"), "utf8");

      expect(archivedPlan).not.toContain("status:");
      expect(index).toContain("editor.md");
      expect(index).not.toContain("billing.md");

      const list = spawnSync("bun", [script, "list", `--plans-root=${plansRoot}`], {
        cwd: checkout,
        encoding: "utf8",
      });

      expect(list.status).toBe(0);
      expect(list.stdout).toContain("editor.md");
      expect(list.stdout).not.toContain("billing.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("archives every done plan across projects and keeps pending and progress plans active", () => {
    const fixture = mkdtempSync(join(tmpdir(), "lanes-plans-"));
    const plansRoot = join(fixture, "plans");
    const checkout = join(fixture, "checkout");

    try {
      mkdirSync(checkout, { recursive: true });
      writePlan(plansRoot, "example-project", "done.md", "Done Plan", "done");
      writePlan(plansRoot, "example-project", "pending.md", "Pending Plan", "pending");
      writePlan(plansRoot, "example-project", "progress.md", "Progress Plan", "progress");
      writePlan(plansRoot, "other-project", "other.md", "Other Done Plan", "done");

      const result = spawnSync(
        "bun",
        [script, "archive-done", "--all", `--plans-root=${plansRoot}`],
        { cwd: checkout, encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Archived 2 plans.");
      expect(existsSync(join(plansRoot, "example-project", "archive", "done.md"))).toBe(true);
      expect(existsSync(join(plansRoot, "other-project", "archive", "other.md"))).toBe(true);
      expect(existsSync(join(plansRoot, "example-project", "pending.md"))).toBe(true);
      expect(existsSync(join(plansRoot, "example-project", "progress.md"))).toBe(true);
      expect(readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8")).toContain(
        "pending.md",
      );
      expect(readFileSync(join(plansRoot, "example-project", "INDEX.md"), "utf8")).toContain(
        "progress.md",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectId", () => {
  const projects = [
    {
      id: "example-project",
      remoteUrl: "https://example.com/example-project.git",
      canonicalRoot: "/does/not/exist/example-project",
    },
  ];

  test("uses the project that owns the checkout", () => {
    const fixture = mkdtempSync(join(tmpdir(), "plans-resolve-"));
    try {
      const canonicalRoot = join(fixture, "example-project");
      mkdirSync(join(canonicalRoot, "nested"), { recursive: true });

      expect(
        resolveProjectId(join(canonicalRoot, "nested"), [{ ...projects[0], canonicalRoot }]),
      ).toBe("example-project");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("matches a side clone or worktree through its origin remote", () => {
    const fixture = mkdtempSync(join(tmpdir(), "plans-resolve-"));
    try {
      const checkout = join(fixture, "example-project-compare");
      mkdirSync(checkout, { recursive: true });
      spawnSync("git", ["init", "--quiet"], { cwd: checkout });
      spawnSync("git", ["remote", "add", "origin", "git@example.com:example-project.git"], {
        cwd: checkout,
      });

      expect(resolveProjectId(checkout, projects)).toBe("example-project");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("falls back to the checkout directory name", () => {
    const fixture = mkdtempSync(join(tmpdir(), "plans-resolve-"));
    try {
      const checkout = join(fixture, "unconfigured-checkout");
      mkdirSync(checkout, { recursive: true });

      expect(resolveProjectId(checkout, projects)).toBe("unconfigured-checkout");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
