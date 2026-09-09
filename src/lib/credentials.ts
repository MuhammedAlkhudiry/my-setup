import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { CREDENTIAL_FILES, CREDENTIALS_ROOT } from "../../config/credentials";

export async function secureManagedCredentials(home: string): Promise<void> {
  const root = join(home, CREDENTIALS_ROOT);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  for (const file of CREDENTIAL_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;

    let directory = root;
    for (const segment of relative(root, dirname(path)).split("/").filter(Boolean)) {
      directory = join(directory, segment);
      await chmod(directory, 0o700);
    }
    await chmod(path, 0o600);
  }
}
