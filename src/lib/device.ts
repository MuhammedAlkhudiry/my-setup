import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DEVICE_PROFILE_NAMES, DEVICE_PROFILES, type DeviceProfile } from "../../config/devices";
import type { RemoteSkillSource } from "../../config/skills";

export function deviceFilePath(home: string): string {
  return join(home, ".config/my-setup/device.json");
}

const deviceFileSchema = z.object({
  profile: z.enum(DEVICE_PROFILE_NAMES),
  // Another Mac's Claude Pool over Tailscale, such as "http://main-mac.<tailnet>.ts.net:18317".
  // This Mac then runs no pool of its own and uses that Mac's accounts with its copied client key.
  claudePoolUrl: z.url({ protocol: /^https?$/ }).optional(),
  // SSH hosts of spare Macs, such as "small-mac". Install on this Mac copies the setup checkout to each and installs it there.
  mirrors: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/)).optional(),
});

type DeviceFile = z.infer<typeof deviceFileSchema>;

function readDeviceFile(home: string): DeviceFile {
  const path = deviceFilePath(home);
  const example = `{ "profile": "${DEVICE_PROFILE_NAMES.join('" | "')}" }`;

  if (!existsSync(path)) {
    throw new Error(
      `No device profile at ${path}. Create it with ${example}, then rerun mise run install.`,
    );
  }

  const parsed = deviceFileSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new Error(`Invalid device profile at ${path}. Expected ${example}.`);
  }

  return parsed.data;
}

/** Reads this machine's profile. There is no default, so a new machine never installs the wrong profile silently. */
export function readDeviceProfile(home: string): DeviceProfile {
  return DEVICE_PROFILES[readDeviceFile(home).profile];
}

/** The remote Claude Pool this Mac uses instead of its own, if any. */
export function readRemoteClaudePoolUrl(home: string): string | undefined {
  return readDeviceFile(home).claudePoolUrl?.replace(/\/+$/, "");
}

/** Spare Macs that mirror this Mac's setup checkout. */
export function readSetupMirrors(home: string): string[] {
  return readDeviceFile(home).mirrors ?? [];
}

/** Keeps only the remote skills this profile installs, dropping sources left with none. */
export function selectRemoteSkillSources(
  sources: RemoteSkillSource[],
  profile: DeviceProfile,
): RemoteSkillSource[] {
  const excluded = new Set(profile.excludedSkills);
  return sources
    .map((source) => ({
      ...source,
      skills: source.skills.filter((skill) => !excluded.has(skill.name)),
    }))
    .filter((source) => source.skills.length > 0);
}
