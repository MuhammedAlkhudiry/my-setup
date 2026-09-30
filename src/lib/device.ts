import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { DEVICE_PROFILE_NAMES, DEVICE_PROFILES, type DeviceProfile } from "../../config/devices";
import type { RemoteSkillSource } from "../../config/skills";

export function deviceFilePath(home: string): string {
  return join(home, ".config/my-setup/device.json");
}

const deviceFileSchema = z.object({ profile: z.enum(DEVICE_PROFILE_NAMES) });

/** Reads this machine's profile. There is no default, so a new machine never installs the wrong profile silently. */
export function readDeviceProfile(home: string): DeviceProfile {
  const path = deviceFilePath(home);
  const example = `{ "profile": "${DEVICE_PROFILE_NAMES.join('" | "')}" }`;

  if (!existsSync(path)) {
    throw new Error(`No device profile at ${path}. Create it with ${example}, then rerun mise run install.`);
  }

  const parsed = deviceFileSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new Error(`Invalid device profile at ${path}. Expected ${example}.`);
  }

  return DEVICE_PROFILES[parsed.data.profile];
}

/** Keeps only the remote skills this profile installs, dropping sources left with none. */
export function selectRemoteSkillSources(
  sources: RemoteSkillSource[],
  profile: DeviceProfile,
): RemoteSkillSource[] {
  const excluded = new Set(profile.excludedSkills);
  return sources
    .map((source) => ({ ...source, skills: source.skills.filter((skill) => !excluded.has(skill.name)) }))
    .filter((source) => source.skills.length > 0);
}
