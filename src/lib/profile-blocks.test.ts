import { describe, expect, test } from "bun:test";

import { renderProfileBlocks } from "./profile-blocks";

const template = [
  "## Tools",
  "",
  "- shared",
  "  <!-- profile:personal -->",
  "- personal only",
  "  <!-- /profile -->",
  "  <!-- profile:work -->",
  "- work only",
  "  <!-- /profile -->",
  "",
  "<!-- profile:personal -->",
  "",
  "## Personal section",
  "",
  "<!-- /profile -->",
  "",
  "## End",
].join("\n");

describe("renderProfileBlocks", () => {
  test("keeps only the selected profile's blocks without leaving marker gaps", () => {
    expect(renderProfileBlocks(template, "personal")).toBe(
      "## Tools\n\n- shared\n- personal only\n\n## Personal section\n\n## End",
    );
    expect(renderProfileBlocks(template, "work")).toBe("## Tools\n\n- shared\n- work only\n\n## End");
  });

  test("rejects unknown profiles and unclosed blocks", () => {
    expect(() => renderProfileBlocks("<!-- profile:home -->\n<!-- /profile -->", "work")).toThrow(
      'Unknown profile "home"',
    );
    expect(() => renderProfileBlocks("<!-- profile:work -->\ntext", "work")).toThrow("Unclosed profile block");
  });
});
