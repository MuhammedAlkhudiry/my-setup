import { execa } from "execa";

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  command: string;
}

export interface ProcessRow extends ProcessIdentity {
  pgid: number;
  state: string;
}

export async function processSnapshot(): Promise<ProcessRow[]> {
  const snapshot = execa("/bin/ps", ["-axo", "pid=,pgid=,stat=,lstart=,command="], {
    env: { LC_ALL: "C" },
  });
  const { stdout } = await snapshot;

  return stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/);
    if (!match || Number(match[1]) === snapshot.pid) return [];

    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        state: match[3],
        startedAt: match[4],
        command: match[5],
      },
    ];
  });
}

export function matchesProcess(identity: ProcessIdentity, rows: ProcessRow[]): boolean {
  return rows.some(
    (row) =>
      row.pid === identity.pid &&
      !row.state.startsWith("Z") &&
      row.startedAt === identity.startedAt &&
      row.command === identity.command,
  );
}

export function groupIsAlive(identity: ProcessIdentity, rows: ProcessRow[]): boolean {
  const leader = rows.find((row) => row.pid === identity.pid);
  // A reused group leader is a different job. With the original leader gone,
  // its surviving members still reserve that PGID until the entire group dies.
  if (leader && (leader.startedAt !== identity.startedAt || leader.command !== identity.command))
    return false;

  return rows.some((row) => row.pgid === identity.pid && !row.state.startsWith("Z"));
}
