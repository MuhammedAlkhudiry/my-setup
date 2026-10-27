import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  deviceFilePath,
  readDeviceProfile,
  readRemoteClaudePoolUrl,
  readSetupMirrors,
} from "./device";

test("fails instead of guessing when the machine has no device profile", () => {
  const home = mkdtempSync(join(tmpdir(), "my-setup-device-"));
  try {
    expect(() => readDeviceProfile(home)).toThrow("No device profile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reads another Mac's Claude Pool URL and rejects non-HTTP ones", () => {
  const home = mkdtempSync(join(tmpdir(), "my-setup-device-"));
  const write = (device: object) => {
    mkdirSync(join(home, ".config/my-setup"), { recursive: true });
    writeFileSync(deviceFilePath(home), JSON.stringify(device));
  };
  try {
    write({ profile: "personal" });
    expect(readRemoteClaudePoolUrl(home)).toBeUndefined();

    write({ profile: "personal", claudePoolUrl: "http://main-mac.example.ts.net:18317/" });
    expect(readRemoteClaudePoolUrl(home)).toBe("http://main-mac.example.ts.net:18317");

    write({ profile: "personal", claudePoolUrl: "ftp://main-mac.example.ts.net" });
    expect(() => readRemoteClaudePoolUrl(home)).toThrow("Invalid device profile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reads the spare Macs that mirror this setup and rejects shell-unsafe hosts", () => {
  const home = mkdtempSync(join(tmpdir(), "my-setup-device-"));
  const write = (device: object) => {
    mkdirSync(join(home, ".config/my-setup"), { recursive: true });
    writeFileSync(deviceFilePath(home), JSON.stringify(device));
  };
  try {
    write({ profile: "personal" });
    expect(readSetupMirrors(home)).toEqual([]);

    write({ profile: "personal", mirrors: ["small-mac", "big-mac"] });
    expect(readSetupMirrors(home)).toEqual(["small-mac", "big-mac"]);

    write({ profile: "personal", mirrors: ["small-mac; rm -rf ~"] });
    expect(() => readSetupMirrors(home)).toThrow("Invalid device profile");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
