import { mkdir, rm, readdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

// Replace the destination so removed source files cannot survive an installation.
// Copy regular files and directories only; skill symlinks are not installed.
// `transformMarkdown` rewrites each `.md` file on the way, for example to render profile blocks.
export async function replaceDirectory(
  src: string,
  dest: string,
  transformMarkdown?: (content: string, sourcePath: string) => string,
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  for (const entry of entries) {
    const sourcePath = join(src, entry.name);
    const destinationPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await replaceDirectory(sourcePath, destinationPath, transformMarkdown);
    } else if (entry.isFile() && transformMarkdown && entry.name.endsWith(".md")) {
      await writeFile(destinationPath, transformMarkdown(await readFile(sourcePath, "utf-8"), sourcePath));
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    }
  }
}
