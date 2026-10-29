import { describe, expect, test } from "bun:test";

import { indexedVolumes } from "./spotlight";

describe("indexedVolumes", () => {
  test("lists only volumes with indexing on", () => {
    const status = [
      "/:",
      "\tIndexing enabled. ",
      "/System/Volumes/Data:",
      "\tIndexing disabled.",
      "/Users/me/Library/Developer/CoreDevice/DeviceFS:",
      "\tIndexing and searching disabled.",
      "/Volumes/Backup Disk:",
      "\tIndexing enabled. ",
    ].join("\n");

    expect(indexedVolumes(status)).toEqual(["/", "/Volumes/Backup Disk"]);
  });

  test("is empty when every volume is off", () => {
    expect(indexedVolumes("/:\n\tIndexing disabled.\n")).toEqual([]);
  });
});
