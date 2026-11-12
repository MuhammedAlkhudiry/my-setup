import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type LedgerRow, validate } from "./validate-ledger";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "validate-ledger-"));
  writeFileSync(join(root, "a.ts"), "export function load() {\n  return fetch('/api/items');\n}\n");
  writeFileSync(join(root, "b.ts"), "try {\n  save();\n} catch {}\n");

  return root;
}

const okRows: LedgerRow[] = [
  {
    item: "a.ts",
    dimension: "errors",
    verdict: "issue",
    file: "a.ts",
    line: 2,
    quote: "return fetch('/api/items')",
    slice: 0,
  },
  {
    item: "a.ts",
    dimension: "types",
    verdict: "ok",
    file: "a.ts",
    line: 1,
    quote: "export function load()",
    slice: 0,
  },
  {
    item: "b.ts",
    dimension: "errors",
    verdict: "issue",
    file: "b.ts",
    line: 3,
    quote: "} catch {}",
    slice: 1,
  },
  {
    item: "b.ts",
    dimension: "types",
    verdict: "na",
    note: "no types in a plain call site",
    slice: 1,
  },
];

test("passes a complete ledger whose quotes exist", () => {
  const root = repo();
  const result = validate(["a.ts", "b.ts"], ["errors", "types"], okRows, root);
  rmSync(root, { recursive: true });

  expect(result.problems).toEqual([]);
  expect(result.cells).toBe(4);
});

test("fails missing cells, invented quotes, and bare na", () => {
  const root = repo();
  const rows: LedgerRow[] = [
    { ...okRows[0], quote: "return cachedItems()" },
    { ...okRows[2] },
    { ...okRows[3], note: "" },
  ];
  const result = validate(["a.ts", "b.ts"], ["errors", "types"], rows, root);
  rmSync(root, { recursive: true });

  expect(result.problems.map((problem) => problem.reason).sort()).toEqual([
    "missing cell",
    "na needs a note saying why",
    "quote not found near a.ts:2",
  ]);
  expect(result.reopenSlices).toEqual([0, 1]);
});

test("flags a note pasted across items", () => {
  const root = repo();
  const items = ["a.ts", "b.ts", "c.ts"];
  const rows = items.map((item) => ({
    item,
    dimension: "types",
    verdict: "na" as const,
    note: "not applicable here",
    slice: 0,
  }));
  const result = validate(items, ["types"], rows, root);
  rmSync(root, { recursive: true });

  expect(
    result.problems.filter((problem) => problem.reason === "note pasted across items"),
  ).toHaveLength(3);
});
