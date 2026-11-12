#!/usr/bin/env bun

// Gate for an exhaustive run: every inventory item has every dimension, every verdict carries evidence
// that exists in the repository, and no cell looks pasted. Exit 0 only when the ledger is complete.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface LedgerRow {
  item: string;
  dimension: string;
  verdict: "issue" | "ok" | "na";
  file?: string;
  line?: number;
  quote?: string;
  note?: string;
  slice?: number;
}

export interface Problem {
  item: string;
  dimension: string;
  slice?: number;
  reason: string;
}

export interface Result {
  items: number;
  dimensions: number;
  cells: number;
  problems: Problem[];
  reopenSlices: number[];
}

const USAGE = `Usage: validate-ledger.ts --inventory <file> --dimensions <a,b,c> --ledger <file.json> [--root <dir>] [--json]

  --inventory   One item per line, the fixed list taken before any judgment.
  --dimensions  Comma-separated dimensions every item must be judged on.
  --ledger      JSON array of rows {item, dimension, verdict: issue|ok|na, file, line, quote, note, slice}.
  --root        Repository root that row files resolve against (default: current directory).
  --json        Print the full result as JSON.

Exit 0 when complete, 1 when problems remain, 2 on bad input.`;

const QUOTE_WINDOW = 2;
const MIN_QUOTE = 8;
const MIN_NOTE = 10;
const PASTE_LIMIT = 3;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function validate(
  inventory: string[],
  dimensions: string[],
  rows: LedgerRow[],
  root: string,
): Result {
  const problems: Problem[] = [];
  const known = new Set(inventory);
  const cells = new Map<string, LedgerRow>();
  const fileLines = new Map<string, string[] | null>();

  const readLines = (file: string) => {
    if (!fileLines.has(file)) {
      const path = resolve(root, file);
      fileLines.set(
        file,
        existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8").split("\n") : null,
      );
    }

    return fileLines.get(file) ?? null;
  };

  for (const row of rows) {
    const cell = { item: row.item, dimension: row.dimension, slice: row.slice };
    if (!known.has(row.item)) problems.push({ ...cell, reason: "item is not in the inventory" });
    if (!dimensions.includes(row.dimension))
      problems.push({ ...cell, reason: "dimension is not in the list" });
    cells.set(`${row.item}\u0000${row.dimension}`, row);

    if (row.verdict === "na") {
      if (normalize(row.note ?? "").length < MIN_NOTE)
        problems.push({ ...cell, reason: "na needs a note saying why" });
      continue;
    }
    if (row.verdict !== "issue" && row.verdict !== "ok") {
      problems.push({ ...cell, reason: `unknown verdict ${JSON.stringify(row.verdict)}` });
      continue;
    }

    const quote = normalize(row.quote ?? "");
    if (!row.file || !Number.isInteger(row.line) || quote.length < MIN_QUOTE) {
      problems.push({
        ...cell,
        reason: `${row.verdict} needs file, line, and a quote of at least ${MIN_QUOTE} characters`,
      });
      continue;
    }

    const lines = readLines(row.file);
    if (!lines) {
      problems.push({ ...cell, reason: `file not found: ${row.file}` });
      continue;
    }

    const line = row.line as number;
    const window = normalize(
      lines.slice(Math.max(0, line - 1 - QUOTE_WINDOW), line + QUOTE_WINDOW).join(" "),
    );
    if (!window.includes(quote))
      problems.push({ ...cell, reason: `quote not found near ${row.file}:${line}` });
  }

  for (const item of inventory) {
    for (const dimension of dimensions) {
      if (!cells.has(`${item}\u0000${dimension}`))
        problems.push({ item, dimension, reason: "missing cell" });
    }
  }

  // Pasted reasoning: one note reused across several items, or one quote standing in for several dimensions of an item.
  const byNote = new Map<string, LedgerRow[]>();
  const byQuote = new Map<string, LedgerRow[]>();
  for (const row of cells.values()) {
    const note = normalize(row.note ?? "");
    if (note.length >= MIN_NOTE) byNote.set(note, [...(byNote.get(note) ?? []), row]);
    const quote = normalize(row.quote ?? "");
    if (quote)
      byQuote.set(`${row.item}\u0000${quote}`, [
        ...(byQuote.get(`${row.item}\u0000${quote}`) ?? []),
        row,
      ]);
  }
  for (const group of byNote.values()) {
    if (new Set(group.map((row) => row.item)).size < PASTE_LIMIT) continue;
    for (const row of group) {
      problems.push({
        item: row.item,
        dimension: row.dimension,
        slice: row.slice,
        reason: "note pasted across items",
      });
    }
  }
  for (const group of byQuote.values()) {
    if (group.length < PASTE_LIMIT) continue;
    for (const row of group) {
      problems.push({
        item: row.item,
        dimension: row.dimension,
        slice: row.slice,
        reason: "one quote reused for several dimensions",
      });
    }
  }

  // A slice whose issue rate falls far below the median was probably skimmed.
  const slices = new Map<number, { cells: number; issues: number }>();
  for (const row of cells.values()) {
    if (row.slice === undefined) continue;
    const stats = slices.get(row.slice) ?? { cells: 0, issues: 0 };
    stats.cells += 1;
    if (row.verdict === "issue") stats.issues += 1;
    slices.set(row.slice, stats);
  }
  const rates = [...slices.values()]
    .map((stats) => stats.issues / stats.cells)
    .sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  const lowSlices = [...slices.entries()]
    .filter(
      ([, stats]) => median > 0 && stats.cells >= 10 && stats.issues / stats.cells < median / 3,
    )
    .map(([slice]) => slice);
  for (const slice of lowSlices) {
    problems.push({
      item: "*",
      dimension: "*",
      slice,
      reason: "issue rate under a third of the median slice",
    });
  }

  const sliceOf = new Map(rows.map((row) => [row.item, row.slice]));
  const reopen = new Set<number>();
  for (const problem of problems) {
    const slice = problem.slice ?? sliceOf.get(problem.item);
    if (slice !== undefined) reopen.add(slice);
  }

  return {
    items: inventory.length,
    dimensions: dimensions.length,
    cells: cells.size,
    problems,
    reopenSlices: [...reopen].sort((a, b) => a - b),
  };
}

function main(argv: string[]) {
  const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`);

    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const inventoryPath = flag("inventory");
  const dimensionList = flag("dimensions");
  const ledgerPath = flag("ledger");
  if (!inventoryPath || !dimensionList || !ledgerPath) {
    console.error(USAGE);
    return 2;
  }

  let rows: LedgerRow[];
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
    rows = Array.isArray(parsed) ? parsed : parsed.rows;
    if (!Array.isArray(rows)) throw new Error("ledger must be an array of rows or {rows: [...]}");
  } catch (error) {
    console.error(`validate-ledger: cannot read ledger: ${(error as Error).message}`);
    return 2;
  }

  const inventory = [
    ...new Set(
      readFileSync(inventoryPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const dimensions = dimensionList
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const result = validate(inventory, dimensions, rows, resolve(flag("root") ?? "."));

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.problems.length === 0) {
    console.log(
      `ledger complete: ${result.items} items × ${result.dimensions} dimensions, ${result.cells} cells`,
    );
  } else {
    for (const problem of result.problems) {
      console.log(
        `${problem.item} [${problem.dimension}]${problem.slice === undefined ? "" : ` slice ${problem.slice}`}: ${problem.reason}`,
      );
    }
    console.log(
      `reopen slices: ${result.reopenSlices.join(", ") || "none (fix cells without a slice)"}`,
    );
  }

  return result.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
