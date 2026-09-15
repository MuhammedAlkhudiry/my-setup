import { describe, expect, test } from "bun:test";

import {
  adsProjects,
  adsStats,
  adsStatus,
  parseCampaign,
  parsePeriod,
  parsePlatform,
  parseProject,
  zonedMidnightIso,
} from "./ads";

describe("ads CLI contract inputs", () => {
  test("normalizes supported platform aliases", () => {
    expect(parsePlatform("Google Ads")).toBe("google");
    expect(parsePlatform("facebook")).toBe("meta");
    expect(parsePlatform("Snap")).toBe("snapchat");
    expect(parsePlatform("TikTok Ads")).toBe("tiktok");
  });

  test("rejects unknown platforms and reporting periods", () => {
    expect(() => parsePlatform("linkedin")).toThrow("Unknown platform");
    expect(() => parsePeriod("14d")).toThrow('Period must be "7d" or "30d".');
  });

  test("exposes explicit project mappings and rejects unknown projects", () => {
    expect(adsProjects().projects.map(({ id }) => id)).toEqual(["awraq", "harium"]);
    expect(parseProject("all")).toBeUndefined();
    expect(parseProject("awraq")).toBe("awraq");
    expect(() => parseProject("unknown")).toThrow("Unknown project");
  });

  test("accepts provider campaign IDs and rejects unsafe filters", () => {
    expect(parseCampaign(123456789)).toBe("123456789");
    expect(parseCampaign("123456789")).toBe("123456789");
    expect(parseCampaign("2d3798dd-26c2-4e4e-b750-c246cfe8a36d")).toBe(
      "2d3798dd-26c2-4e4e-b750-c246cfe8a36d",
    );
    expect(parseCampaign("all")).toBeUndefined();
    expect(() => parseCampaign("123 OR 1=1")).toThrow("Campaign ID may contain only");
  });

  test("converts local midnight across DST transitions", () => {
    expect(zonedMidnightIso("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnightIso("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(zonedMidnightIso("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedMidnightIso("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
  });

  test("requires a platform when filtering stats by campaign", async () => {
    await expect(adsStats({ period: "7d", campaign: "123456789" })).rejects.toThrow(
      "requires one platform",
    );
  });

  test("represents browser-only project access accurately", async () => {
    const [awraqApple, hariumApple] = await Promise.all([
      adsStatus({ platform: "apple", project: "awraq", refresh: true }),
      adsStatus({ platform: "apple", project: "harium", refresh: true }),
    ]);

    expect(awraqApple.platforms[0]).toMatchObject({
      state: "browser",
      configured: false,
      account: { id: "22534290" },
    });
    expect(hariumApple.platforms[0]).toMatchObject({
      state: "browser",
      configured: false,
      account: { id: "22534290" },
      message: expect.stringContaining("Harium App Store ID 6752504683"),
    });
  });
});
