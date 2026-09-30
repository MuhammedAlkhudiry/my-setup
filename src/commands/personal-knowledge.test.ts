import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  personalKnowledgeCheck,
  personalKnowledgeFind,
  personalKnowledgeNew,
  personalKnowledgeSetup,
  type PersonalKnowledgeRunner,
} from "./personal-knowledge";

function note(title: string, body = ""): string {
  return `---
title: ${title}
type: profile
status: active
confidence: high
updated: 2026-07-23
tags: []
links: []
sources: [owner-confirmed]
---

# ${title}

${body}
`;
}

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "my-setup-personal-knowledge-"));
  try {
    mkdirSync(join(root, "templates"), { recursive: true });
    mkdirSync(join(root, "wiki", "profile"), { recursive: true });
    mkdirSync(join(root, "raw"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(root, "README.md"), "# Personal Knowledge\n");
    writeFileSync(
      join(root, "templates", "wiki-note.md"),
      `---
title:
type:
status: draft
confidence: low
updated: 2026-07-03
tags: []
links: []
sources: []
---

# Title
`,
    );
    writeFileSync(
      join(root, "wiki", "index.md"),
      note(
        "Personal Knowledge Index",
        `## Profile

- [[identity|Identity]]

## Work

## Life

## Tools

## Finance

## Projects

## Health

## Media

## Quotes

## Synthesis`,
      ),
    );
    writeFileSync(join(root, "wiki", "profile", "identity.md"), note("Identity"));
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function capture(run: () => Promise<void>): Promise<string[]> {
  const output: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    await run();
    return output;
  } finally {
    console.log = original;
  }
}

function recordingRunner(output = ""): { calls: string[][]; runner: PersonalKnowledgeRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: output };
    },
  };
}

describe("personal knowledge commands", () => {
  test("checks frontmatter and wikilinks", async () => {
    await withRepository(async (root) => {
      const output = await capture(() => personalKnowledgeCheck({ root }));
      expect(output).toEqual(["Personal knowledge check passed (2 wiki documents)."]);

      writeFileSync(join(root, "wiki", "profile", "identity.md"), note("Identity", "[[Missing]]"));
      await expect(personalKnowledgeCheck({ root })).rejects.toThrow(
        /references missing wikilink: \[\[Missing\]\]/,
      );
    });
  });

  test("creates a templated note and indexes it once", async () => {
    await withRepository(async (root) => {
      await capture(() => personalKnowledgeNew("profile", "Working Style", { root }));

      const path = join(root, "wiki", "profile", "working-style.md");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("title: Working Style");
      expect(readFileSync(path, "utf8")).toContain("type: profile");
      expect(readFileSync(join(root, "wiki", "index.md"), "utf8")).toContain(
        "[[working-style|Working Style]]",
      );
      await expect(personalKnowledgeNew("profile", "Working Style", { root })).rejects.toThrow(
        /already exists/,
      );
    });
  });

  test("routes find modes through the isolated qmd index", async () => {
    await withRepository(async (root) => {
      const { calls, runner } = recordingRunner();
      await personalKnowledgeFind(
        "communication preferences",
        { root, semantic: true, format: "json", limit: "8" },
        runner,
      );

      expect(calls).toEqual([
        [
          "qmd",
          "--index",
          "personal-knowledge",
          "vsearch",
          "communication preferences",
          "-c",
          "personal-knowledge",
          "--full-path",
          "-n",
          "8",
          "--format",
          "json",
        ],
      ]);
    });
  });

  test.skipIf(process.platform === "win32")(
    "runs qmd with its installation runtime first in PATH (POSIX shell fixture)",
    async () => {
      await withRepository(async (root) => {
        const commandRoot = await mkdtemp(join(tmpdir(), "my-setup-qmd-runtime-"));
        const conflictingBin = join(commandRoot, "conflicting-bin");
        const qmdBin = join(commandRoot, "qmd-bin");
        mkdirSync(conflictingBin);
        mkdirSync(qmdBin);
        writeFileSync(join(conflictingBin, "node"), "#!/bin/sh\nexit 1\n");
        writeFileSync(join(qmdBin, "node"), "#!/bin/sh\nexit 0\n");
        writeFileSync(
          join(qmdBin, "qmd"),
          `#!/bin/sh\n[ "$(command -v node)" = "${join(qmdBin, "node")}" ]\n`,
        );
        chmodSync(join(conflictingBin, "node"), 0o755);
        chmodSync(join(qmdBin, "node"), 0o755);
        chmodSync(join(qmdBin, "qmd"), 0o755);

        const originalPath = process.env.PATH;
        process.env.PATH = [conflictingBin, qmdBin, originalPath].filter(Boolean).join(":");
        try {
          await personalKnowledgeFind("runtime consistency", { root, keyword: true });
        } finally {
          process.env.PATH = originalPath;
          rmSync(commandRoot, { recursive: true, force: true });
        }
      });
    },
  );

  test("sets up only the maintained wiki collection", async () => {
    await withRepository(async (root) => {
      const calls: string[][] = [];
      const runner: PersonalKnowledgeRunner = async (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("show")) {
          throw new Error("Collection not found");
        }
        return { stdout: "" };
      };
      await capture(() => personalKnowledgeSetup({ root }, runner));

      expect(calls[1]).toEqual([
        "qmd",
        "--index",
        "personal-knowledge",
        "collection",
        "add",
        join(root, "wiki"),
        "--name",
        "personal-knowledge",
      ]);
      expect(calls.flat().join(" ")).not.toContain(join(root, "raw"));
      expect(calls.flat().join(" ")).not.toContain("private-vault");
    });
  });
});
