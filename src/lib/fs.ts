import { mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

// Replace the destination so removed source files cannot survive an installation.
// Copy regular files and directories only; skill symlinks are not installed.
export async function replaceDirectory(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  for (const entry of entries) {
    const sourcePath = join(src, entry.name);
    const destinationPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await replaceDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    }
  }
}
