#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve, sep } from "node:path";

import { ACTIVE_PROJECTS } from "../../config/active-projects";

type Plan = {
  name: string;
  path: string;
  project: string;
  relativePath: string;
  updated: string;
  title: string;
  description: string;
  status: PlanStatus;
};

type PlanStatus = "pending" | "progress" | "done";

type Options = {
  project: string;
  plansRoot: string;
  query: string;
  all: boolean;
  json: boolean;
  description?: string;
  status?: string;
  write: boolean;
};

const home = process.env.HOME || "";

/**
 * Resolves the plan folder for a checkout: an active project when the checkout belongs to one
 * (canonical clone, side clone, or worktree), otherwise the checkout directory name.
 */
export function resolveProjectId(
  cwd = process.cwd(),
  projects: Array<{ id: string; remoteUrl: string; canonicalRoot: string }> = ACTIVE_PROJECTS,
): string {
  const resolvedCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);

  const byRoot = projects.find((project) => {
    const root = existsSync(project.canonicalRoot)
      ? realpathSync(project.canonicalRoot)
      : resolve(project.canonicalRoot);
    return resolvedCwd === root || resolvedCwd.startsWith(`${root}${sep}`);
  });
  if (byRoot) return byRoot.id;

  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: resolvedCwd,
    encoding: "utf8",
  });
  const remoteUrl = remote.status === 0 ? remote.stdout.trim() : "";
  if (remoteUrl) {
    const byRemote = projects.find(
      (project) => normalizeRemote(project.remoteUrl) === normalizeRemote(remoteUrl),
    );
    if (byRemote) return byRemote.id;
  }

  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolvedCwd,
    encoding: "utf8",
  });
  const root = gitRoot.status === 0 ? gitRoot.stdout.trim() : "";
  return basename((root || resolvedCwd).replace(/\/$/, ""));
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .toLowerCase();
}

function parseOptions(args: string[]): Options {
  const cwdProject = resolveProjectId();
  const query: string[] = [];
  let project = cwdProject;
  let plansRoot = join(home, "plans");
  let all = false;
  let json = false;
  let description: string | undefined;
  let status: string | undefined;
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--write") {
      write = true;
      continue;
    }

    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
      continue;
    }

    if (arg.startsWith("--plans-root=")) {
      plansRoot = arg.slice("--plans-root=".length);
      continue;
    }

    if (arg.startsWith("--description=")) {
      description = arg.slice("--description=".length);
      continue;
    }

    if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
      continue;
    }

    query.push(arg);
  }

  return {
    project,
    plansRoot: resolve(plansRoot.replace(/^~/, home)),
    query: query.join(" ").trim(),
    all,
    json,
    description,
    status,
    write,
  };
}

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  return Object.fromEntries(
    match[1]
      .split(/\n/)
      .map((line) => line.match(/^([^:]+):\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1].trim(), match[2].trim()]),
  );
}

function title(text: string, fallback: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1].trim() || fallback.replace(/\.md$/, "");
}

function isPlanStatus(value: string): value is PlanStatus {
  return value === "pending" || value === "progress" || value === "done";
}

function planStatus(value: string | undefined, path?: string): PlanStatus {
  if (!value) return "pending";
  if (isPlanStatus(value)) return value;
  throw new Error(
    `Invalid plan status${path ? ` in ${path}` : ""}: ${value}. Use pending, progress, or done.`,
  );
}

function today(): string {
  const now = new Date();
  return [
    now.getFullYear().toString().padStart(4, "0"),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function setFrontmatterField(text: string, field: string, value: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return text;
  const pattern = new RegExp(`^${field}:\\s*.*$`, "m");
  const metadata = pattern.test(match[1])
    ? match[1].replace(pattern, `${field}: ${value}`)
    : `${match[1]}\n${field}: ${value}`;
  return `---\n${metadata}\n---${text.slice(match[0].length)}`;
}

function readPlan(projectRoot: string, project: string, entry: string): Plan | undefined {
  const full = join(projectRoot, entry);
  const stat = statSync(full);
  const main = stat.isDirectory() ? join(full, "PLAN.md") : full;
  if (!existsSync(main) || !main.endsWith(".md")) return undefined;

  const text = readFileSync(main, "utf8");
  const meta = frontmatter(text);
  const relativePath = stat.isDirectory() ? `${entry}/PLAN.md` : entry;

  return {
    name: entry,
    path: main,
    project,
    relativePath,
    updated: meta.updated || "missing",
    title: title(text, entry),
    description: meta.description || "",
    status: planStatus(meta.status, main),
  };
}

function activePlans(projectRoot: string, project: string): Plan[] {
  if (!existsSync(projectRoot)) return [];

  return readdirSync(projectRoot)
    .filter((entry) => entry !== "INDEX.md" && entry !== "archive")
    .map((entry) => readPlan(projectRoot, project, entry))
    .filter((plan): plan is Plan => Boolean(plan))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

function indexBody(project: string, plans: Plan[]): string {
  return [
    `# ${project} Plans`,
    "",
    ...plans.map(
      (plan) =>
        `- [${plan.title}](${plan.relativePath}) - ${plan.status} - updated ${plan.updated}`,
    ),
    "",
  ].join("\n");
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}

function relatedProjectNames(options: Options): string[] {
  if (options.all) {
    const configuredProjects = ACTIVE_PROJECTS.map((project) => project.id);
    const storedProjects = existsSync(options.plansRoot)
      ? readdirSync(options.plansRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name)
      : [];

    return [...new Set([...configuredProjects, ...storedProjects])].sort();
  }

  return [options.project];
}

function activePlansForList(options: Options): Plan[] {
  return relatedProjectNames(options)
    .flatMap((project) => activePlans(join(options.plansRoot, project), project))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

function groupPlansByProject(projects: string[], plans: Plan[]): Map<string, Plan[]> {
  const grouped = new Map(projects.map((project) => [project, [] as Plan[]]));

  for (const plan of plans) {
    grouped.get(plan.project)?.push(plan);
  }

  return grouped;
}

function matches(plan: Plan, query: string): boolean {
  const normalized = query.toLowerCase();

  return [plan.name, plan.relativePath, plan.title, plan.description].some((value) =>
    value.toLowerCase().includes(normalized),
  );
}

function findPlan(options: Options): Plan | undefined {
  const plans = activePlans(join(options.plansRoot, options.project), options.project);
  if (!options.query) return plans[0];

  const exact = plans.find(
    (plan) =>
      plan.name === options.query ||
      plan.relativePath === options.query ||
      plan.title.toLowerCase() === options.query.toLowerCase(),
  );

  return exact || plans.find((plan) => matches(plan, options.query));
}

function requirePlan(options: Options): Plan {
  const projectRoot = join(options.plansRoot, options.project);
  const plan = findPlan(options);

  if (plan) return plan;

  if (options.query) {
    console.error(`No plan matched "${options.query}" in ${projectRoot}.`);
  } else {
    console.error(`No active plans found in ${projectRoot}.`);
  }
  process.exit(1);
}

function printPlansTable(plans: Plan[]): void {
  if (plans.length === 0) {
    return;
  }

  const titleWidth = Math.min(
    48,
    Math.max("Title".length, ...plans.map((plan) => plan.title.length)),
  );
  const updatedWidth = Math.max("Updated".length, ...plans.map((plan) => plan.updated.length));
  const statusWidth = Math.max("Status".length, ...plans.map((plan) => plan.status.length));
  const descriptionWidth = Math.min(
    56,
    Math.max("Description".length, ...plans.map((plan) => plan.description.length)),
  );

  console.log(
    `${pad("Updated", updatedWidth)}  ${pad("Status", statusWidth)}  ${pad("Title", titleWidth)}  ${pad("Description", descriptionWidth)}  File`,
  );
  console.log(
    `${"-".repeat(updatedWidth)}  ${"-".repeat(statusWidth)}  ${"-".repeat(titleWidth)}  ${"-".repeat(descriptionWidth)}  ${"-".repeat(4)}`,
  );

  for (const plan of plans) {
    const displayTitle =
      plan.title.length > titleWidth ? `${plan.title.slice(0, titleWidth - 3)}...` : plan.title;
    const displayDescription =
      plan.description.length > descriptionWidth
        ? `${plan.description.slice(0, descriptionWidth - 3)}...`
        : plan.description;
    console.log(
      `${pad(plan.updated, updatedWidth)}  ${pad(plan.status, statusWidth)}  ${pad(displayTitle, titleWidth)}  ${pad(displayDescription, descriptionWidth)}  ${plan.relativePath}`,
    );
  }
}

function listPlans(options: Options): void {
  const projectRoot = join(options.plansRoot, options.project);
  const projectNames = relatedProjectNames(options);
  const plans = activePlansForList(options);
  const multipleProjects = projectNames.length > 1;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          contractVersion: 2,
          plansRoot: options.plansRoot,
          projects: projectNames.map((project) => ({
            id: project,
            plans: plans.filter((plan) => plan.project === project),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${options.project} plans`);
  console.log(multipleProjects ? options.plansRoot : projectRoot);
  if (multipleProjects) {
    console.log(`Projects: ${projectNames.join(", ")}`);
  }
  console.log("");

  if (plans.length === 0) {
    console.log("No active plans found.");
    return;
  }

  if (!multipleProjects) {
    printPlansTable(plans);
    return;
  }

  const groupedPlans = groupPlansByProject(projectNames, plans);
  let printedAnyProject = false;

  for (const project of projectNames) {
    const projectPlans = groupedPlans.get(project) || [];
    if (projectPlans.length === 0) continue;

    if (printedAnyProject) console.log("");
    console.log(`${project}`);
    printPlansTable(projectPlans);
    printedAnyProject = true;
  }
}

function showPlan(options: Options): void {
  const plan = requirePlan(options);

  console.log(readFileSync(plan.path, "utf8"));
}

function showPath(options: Options): void {
  console.log(requirePlan(options).path);
}

function createPlan(options: Options): void {
  const description = options.description?.trim();
  if (!description) {
    console.error("--description is required when creating a plan.");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.project)) {
    console.error(`Invalid plan project: ${options.project}. Use a lowercase hyphenated id.`);
    process.exit(1);
  }

  const name = options.query.endsWith(".md") ? options.query : `${options.query}.md`;
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) {
    console.error("Plan name must be a lowercase hyphenated filename or slug.");
    process.exit(1);
  }

  const projectRoot = join(options.plansRoot, options.project);
  const path = join(projectRoot, name);
  const archivedPath = join(projectRoot, "archive", name);
  if (existsSync(path) || existsSync(archivedPath)) {
    console.error(`Plan already exists: ${existsSync(path) ? path : archivedPath}`);
    process.exit(1);
  }

  const body = readFileSync(0, "utf8").trim();
  if (!body) {
    console.error("Plan body cannot be empty.");
    process.exit(1);
  }

  const status = planStatus(options.status);
  const date = today();
  const planTitle = name
    .replace(/\.md$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const contents = [
    "---",
    `created: ${date}`,
    `updated: ${date}`,
    `project: ${options.project}`,
    `description: ${description}`,
    `status: ${status}`,
    "---",
    "",
    `# ${planTitle}`,
    "",
    body,
    "",
  ].join("\n");

  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path, contents);
  writeFileSync(
    join(projectRoot, "INDEX.md"),
    indexBody(options.project, activePlans(projectRoot, options.project)),
  );
  console.log(path);
}

function savePlan(options: Options): void {
  const plan = requirePlan(options);
  const contents = readFileSync(0, "utf8");

  if (!contents.trim()) {
    console.error("Plan content cannot be empty.");
    process.exit(1);
  }

  const metadata = frontmatter(contents);
  const requiredFields = ["created", "updated", "project", "description"];
  const missingFields = requiredFields.filter((field) => !metadata[field]);
  if (missingFields.length > 0) {
    console.error(`Plan frontmatter is missing: ${missingFields.join(", ")}.`);
    process.exit(1);
  }
  if (metadata.project !== plan.project) {
    console.error(`Plan project must remain ${plan.project}.`);
    process.exit(1);
  }

  const status = planStatus(metadata.status);
  let savedContents = setFrontmatterField(contents, "status", status);
  savedContents = setFrontmatterField(savedContents, "updated", today());
  writeFileSync(plan.path, savedContents);

  const projectRoot = join(options.plansRoot, options.project);
  writeFileSync(
    join(projectRoot, "INDEX.md"),
    indexBody(options.project, activePlans(projectRoot, options.project)),
  );
  console.log(plan.path);
}

function archivePlans(plansRoot: string, plans: Plan[]): void {
  for (const plan of plans) {
    const target = join(plansRoot, plan.project, "archive", plan.name);
    if (existsSync(target)) {
      console.error(`Archived plan already exists: ${target}`);
      process.exit(1);
    }
  }

  for (const plan of plans) {
    const projectRoot = join(plansRoot, plan.project);
    const archiveRoot = join(projectRoot, "archive");
    mkdirSync(archiveRoot, { recursive: true });
    renameSync(join(projectRoot, plan.name), join(archiveRoot, plan.name));
  }

  for (const project of new Set(plans.map((plan) => plan.project))) {
    const projectRoot = join(plansRoot, project);
    writeFileSync(
      join(projectRoot, "INDEX.md"),
      indexBody(project, activePlans(projectRoot, project)),
    );
  }

  console.log(`Archived ${plans.length} plan${plans.length === 1 ? "" : "s"}.`);
  for (const plan of plans) {
    console.log(join(plansRoot, plan.project, "archive", plan.name));
  }
}

function archivePlan(options: Options): void {
  const projectRoot = join(options.plansRoot, options.project);
  const plans = activePlans(projectRoot, options.project);
  let selectedPlans: string[] = [];

  if (options.query) {
    selectedPlans = [requirePlan(options).name];
  } else {
    if (plans.length === 0) {
      console.log("No active plans found.");
      return;
    }

    const selectionLines = [
      "Plan\tDescription",
      ...plans.map((plan) => `${plan.name}\t${plan.description}`),
    ];

    const selection = spawnSync(
      "fzf",
      [
        "--height=40%",
        "--multi",
        "--reverse",
        "--border=rounded",
        "--header-lines=1",
        "--prompt=Plans > ",
        "--header=Select plans to archive with Tab, then Enter",
        "--exit-0",
      ],
      {
        input: selectionLines.join("\n"),
        encoding: "utf8",
      },
    );

    if (selection.error) {
      console.error("fzf is required for interactive selection.");
      process.exit(1);
    }

    selectedPlans = selection.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[0]);
  }

  if (selectedPlans.length === 0) {
    process.exit(1);
  }

  const selected = plans.filter((plan) => selectedPlans.includes(plan.name));
  archivePlans(options.plansRoot, selected);
}

function archiveDonePlans(options: Options): void {
  const plans = activePlansForList(options).filter((plan) => plan.status === "done");
  if (plans.length === 0) {
    console.log("No done plans to archive.");
    return;
  }
  archivePlans(options.plansRoot, plans);
}

function setPlanStatus(options: Options): void {
  const plan = requirePlan(options);
  if (!options.status) {
    throw new Error("--status must be pending, progress, or done.");
  }
  const status = planStatus(options.status);
  let contents = readFileSync(plan.path, "utf8");
  contents = setFrontmatterField(contents, "status", status);
  contents = setFrontmatterField(contents, "updated", today());
  writeFileSync(plan.path, contents);

  const projectRoot = join(options.plansRoot, options.project);
  writeFileSync(
    join(projectRoot, "INDEX.md"),
    indexBody(options.project, activePlans(projectRoot, options.project)),
  );
  console.log(`${plan.path}\t${status}`);
}

function indexPlans(options: Options): void {
  const projectRoot = join(options.plansRoot, options.project);
  const plans = activePlans(projectRoot, options.project);

  console.log(`# Plan index for ${options.project}`);
  console.log(`Root: ${projectRoot}`);
  console.log(`Active plans: ${plans.length}`);
  for (const plan of plans) {
    console.log(`- ${plan.name}: ${plan.status}, updated ${plan.updated}`);
  }

  if (options.write) {
    if (!existsSync(projectRoot)) {
      console.error(`Plan project folder does not exist: ${projectRoot}`);
      process.exit(1);
    }
    writeFileSync(join(projectRoot, "INDEX.md"), indexBody(options.project, plans));
    console.log("\nINDEX.md updated.");
  } else {
    console.log("\nRun with --write to update INDEX.md.");
  }
}

export function runPlansCommand(command: string, rawOptions: string[]): void {
  const options = parseOptions(rawOptions);

  if (command === "list") {
    listPlans(options);
  } else if (command === "show" || command === "latest") {
    showPlan(options);
  } else if (command === "path") {
    showPath(options);
  } else if (command === "create") {
    createPlan(options);
  } else if (command === "save") {
    savePlan(options);
  } else if (command === "status") {
    setPlanStatus(options);
  } else if (command === "archive-done") {
    archiveDonePlans(options);
  } else if (
    command === "archive" ||
    command === "delete" ||
    command === "remove" ||
    command === "rm"
  ) {
    archivePlan(options);
  } else if (command === "index") {
    indexPlans(options);
  } else {
    throw new Error(`Unknown plans operation: ${command}`);
  }
}
