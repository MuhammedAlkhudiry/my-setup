import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { mergeMainIntoBranch } from "./merge-queue-update";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const mergiraf = await execa("mergiraf", ["languages", "--gitattributes"], {
  reject: false,
});

async function repository(files: {
  base: Record<string, string>;
  main?: Record<string, string>;
  branch?: Record<string, string>;
}) {
  const root = mkdtempSync(join(tmpdir(), "merge-queue-update-test-"));
  directories.push(root);
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const queue = join(root, "queue");
  const git = (cwd: string, ...args: string[]) =>
    execa("git", ["-c", "user.name=Author", "-c", "user.email=a@a", ...args], {
      cwd,
    }).then((result) => result.stdout.trim());
  const commit = async (changes: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(changes))
      writeFileSync(join(author, path), content);
    await git(author, "add", ".");
    await git(author, "commit", "-m", message);
  };

  await execa("git", ["init", "--bare", "-b", "main", origin]);
  await execa("git", ["clone", origin, author]);
  await git(author, "checkout", "-b", "main");
  await commit(files.base, "base");
  await git(author, "push", "origin", "main");
  await git(author, "checkout", "-b", "feature");
  await commit(files.branch ?? { "branch.txt": "branch\n" }, "author work");
  await git(author, "push", "origin", "feature");
  const head = await git(author, "rev-parse", "HEAD");
  if (files.main) {
    await git(author, "checkout", "main");
    await commit(files.main, "sibling landed");
    await git(author, "push", "origin", "main");
  }

  await execa("git", ["clone", origin, queue]);
  return {
    root,
    head,
    remote: (ref: string) => git(origin, "rev-parse", ref),
    show: (ref: string, path: string) => git(origin, "show", `${ref}:${path}`),
    update: (overrides: { head?: string; mergiraf?: boolean } = {}) =>
      mergeMainIntoBranch({
        git: (args) => execa("git", args, { cwd: queue, reject: false, all: true }),
        branch: "feature",
        head: overrides.head ?? head,
        log: join(root, "update.log"),
        mergiraf: overrides.mergiraf
          ? {
              attributesFile: join(root, "attributes"),
              patterns: mergiraf.stdout,
            }
          : undefined,
      }),
  };
}

test("a clean update pushes a merge on top of the author's untouched commits", async () => {
  const repo = await repository({
    base: { "a.txt": "a\n" },
    main: { "main.txt": "main\n" },
  });
  const result = await repo.update();
  expect(result.status).toBe("pushed");
  const head = await repo.remote("feature");
  expect(result).toMatchObject({ head });
  expect(await repo.remote(`${head}^1`)).toBe(repo.head);
  expect(await repo.remote(`${head}^2`)).toBe(await repo.remote("main"));
});
test("a real conflict reports its files and leaves the branch alone", async () => {
  const repo = await repository({
    base: { "wire.txt": "one\n", "a.txt": "a\n" },
    branch: { "wire.txt": "branch\n" },
    main: { "wire.txt": "main\n" },
  });
  expect(await repo.update()).toMatchObject({
    status: "conflict",
    files: ["wire.txt"],
  });
  expect(await repo.remote("feature")).toBe(repo.head);
});
test.skipIf(mergiraf.failed)(
  "mergiraf resolves parallel additions a line-based merge cannot",
  async () => {
    const imports = (...names: string[]) =>
      `${names.map((name) => `import { ${name} } from "./${name}";`).join("\n")}\n\nexport const x = 1;\n`;
    const files = {
      base: { "m.ts": imports("a", "b") },
      branch: { "m.ts": imports("a", "b", "c") },
      main: { "m.ts": imports("a", "b", "d") },
    };
    expect((await (await repository(files)).update()).status).toBe("conflict");
    const repo = await repository(files);
    expect(await repo.update({ mergiraf: true })).toMatchObject({
      status: "pushed",
    });
    expect(await repo.show("feature", "m.ts")).toContain("import { c }");
    expect(await repo.show("feature", "m.ts")).toContain("import { d }");
  },
);
test("a branch already containing main and a moved branch are left alone", async () => {
  const repo = await repository({ base: { "a.txt": "a\n" } });
  expect((await repo.update()).status).toBe("current");
  expect((await repo.update({ head: "0".repeat(40) })).status).toBe("moved");
  expect(await repo.remote("feature")).toBe(repo.head);
});
