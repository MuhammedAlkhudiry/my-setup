import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { HostJob } from "./host-capacity";
import { groupIsAlive, matchesProcess, type ProcessRow } from "./process-identity";

const markerName = ".heavy-run-owner.json";

export function writeLegacyOwner(target: string, job: HostJob): void {
  const path = join(target, markerName);
  writeFileSync(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function acquireLegacyLock(path: string, target: string, job: HostJob): boolean {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeLegacyOwner(target, job);

  try {
    // Pre-populate ownership, then publish atomically. Old mkdir callers see
    // EEXIST, with no crash window leaving a lock that has no owner metadata.
    symlinkSync(target, path, "dir");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

export function releaseLegacyLock(path: string, target: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink() && readlinkSync(path) === target)
    rmSync(path);
  rmSync(target, { recursive: true, force: true });
}

export function recoverLegacyLock(path: string, rows: ProcessRow[], active: HostJob | null): void {
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) return;
  const target = readlinkSync(path);
  let recorded: HostJob;

  try {
    recorded = JSON.parse(readFileSync(join(target, markerName), "utf8"));
  } catch {
    return;
  }
  if (!recorded.reservationId || !recorded.holder) return;
  const job = active?.reservationId === recorded.reservationId ? active : recorded;
  if (job.processGroup ? groupIsAlive(job.processGroup, rows) : matchesProcess(job.holder, rows))
    return;

  releaseLegacyLock(path, target);
}
