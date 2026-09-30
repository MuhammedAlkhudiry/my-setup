import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { readDeviceProfile } from "./device";

test("fails instead of guessing when the machine has no device profile", () => {
  const home = mkdtempSync(join(tmpdir(), "my-setup-device-"));
  try {
    expect(() => readDeviceProfile(home)).toThrow("No device profile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
