import { DEVICE_PROFILE_NAMES, type DeviceProfileName } from "../../config/devices";

const START_MARKER = /^<!-- profile:([a-z-]+) -->$/;
const END_MARKER = "<!-- /profile -->";

/**
 * Keeps Markdown between `<!-- profile:<name> -->` and `<!-- /profile -->` only for the given profile.
 * Markers must sit on their own line and blocks cannot nest; the marker lines are always removed.
 */
export function renderProfileBlocks(content: string, profile: DeviceProfileName, source = "content"): string {
  const kept: string[] = [];
  let blockProfile: string | undefined;
  // Set after a marker so the blank lines around a removed marker or block collapse into one.
  let collapseBlank = false;

  for (const [index, line] of content.split("\n").entries()) {
    const trimmed = line.trim();
    const start = trimmed.match(START_MARKER);
    const where = `${source}:${index + 1}`;

    if (start) {
      if (blockProfile) throw new Error(`Nested profile block at ${where}`);
      if (!DEVICE_PROFILE_NAMES.includes(start[1] as DeviceProfileName)) {
        throw new Error(`Unknown profile "${start[1]}" at ${where}`);
      }
      blockProfile = start[1];
      collapseBlank = true;
      continue;
    }

    if (trimmed === END_MARKER) {
      if (!blockProfile) throw new Error(`Profile block end without a start at ${where}`);
      blockProfile = undefined;
      collapseBlank = true;
      continue;
    }

    if (blockProfile && blockProfile !== profile) continue;

    if (trimmed === "" && collapseBlank && kept.at(-1)?.trim() === "") continue;
    if (trimmed !== "") collapseBlank = false;
    kept.push(line);
  }

  if (blockProfile) throw new Error(`Unclosed profile block in ${source}`);

  return kept.join("\n");
}
