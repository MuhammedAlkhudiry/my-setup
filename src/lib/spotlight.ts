import { execa } from "execa";

// Spotlight indexing a project's node_modules held a spare Mac's load above 30 and starved its Android emulator. Spare Macs
// never need Spotlight search, so install keeps indexing off there and doctor flags it if it comes back.

/** Volumes that `mdutil -sa` reports with indexing on. */
export function indexedVolumes(status: string): string[] {
  const volumes: string[] = [];
  let volume = "";
  for (const line of status.split("\n")) {
    if (line.endsWith(":") && !line.startsWith("\t")) {
      volume = line.slice(0, -1);
    } else if (line.trim().startsWith("Indexing enabled")) {
      volumes.push(volume);
    }
  }
  return volumes;
}

export async function readIndexedVolumes(): Promise<string[]> {
  const { stdout } = await execa("mdutil", ["-sa"], { reject: false });
  return indexedVolumes(stdout);
}

/** Turns indexing off on every volume; returns the volumes it changed, or throws when passwordless sudo is missing. */
export async function disableSpotlightIndexing(): Promise<string[]> {
  const indexed = await readIndexedVolumes();
  if (indexed.length === 0) return [];

  await execa("sudo", ["-n", "mdutil", "-a", "-i", "off"]);
  return indexed;
}
