import { expect, test } from "bun:test";

import { DEVICE_PROFILES } from "./devices";
import {
  createClaudePermissionAllowList,
  createOpencodePermission,
  renderCodexRules,
} from "./permissions";

test("renders one allowlist into every agent permission surface", () => {
  const profile = DEVICE_PROFILES.personal;

  const opencode = createOpencodePermission(profile, "/Users/example");
  expect(opencode.bash["git *"]).toBe("allow");
  expect(opencode.bash["herd *"]).toBe("allow");
  expect(opencode.external_directory["/Users/example/PhpstormProjects/*"]).toBe("allow");
  expect(opencode.external_directory["*"]).toBe("ask");
  expect(opencode.read["**/.env*"]).toBe("allow");

  const claude = createClaudePermissionAllowList(profile);
  expect(claude).toContain("Bash(git *)");
  expect(claude).toContain("Edit(~/PhpstormProjects/**)");
  expect(claude).toContain("Read(**/.env*)");
  expect(claude).not.toContain("Bash(ddev *)");

  const rules = renderCodexRules(profile);
  expect(rules).toContain('prefix_rule(pattern=["git"], decision="allow")');
  expect(rules).toContain('prefix_rule(pattern=["herd"], decision="allow")');
  expect(rules.startsWith("# Managed by my-setup")).toBe(true);
});

test("renders recursive directory grants with harness-specific anchors without adding roots", () => {
  for (const profile of Object.values(DEVICE_PROFILES)) {
    const claude = createClaudePermissionAllowList(profile);
    const expected = profile.allowedDirectories.flatMap((directory) => {
      const path = `${directory.startsWith("/") ? "/" : ""}${directory}*`;

      return [`Edit(${path})`, `Read(${path})`];
    });

    expect(
      claude.filter(
        (rule) =>
          rule.startsWith("Edit(") || rule.startsWith("Read(~") || rule.startsWith("Read(//"),
      ),
    ).toEqual(expected);
    expect(claude).not.toContain("Edit(~/plans/**)");
    expect(claude).not.toContain("Bash(*)");
  }

  const profile = {
    allowedDirectories: ["~/plans/**", "/tmp/*", "/private/tmp/**"],
    allowedCommands: [],
  };
  expect(createClaudePermissionAllowList(profile)).toEqual([
    "Edit(~/plans/**)",
    "Read(~/plans/**)",
    "Edit(//tmp/**)",
    "Read(//tmp/**)",
    "Edit(//private/tmp/**)",
    "Read(//private/tmp/**)",
    "Read(**/.env*)",
  ]);
  expect(createOpencodePermission(profile, "/Users/example").external_directory).toEqual({
    "*": "ask",
    "/Users/example/plans/**": "allow",
    "/tmp/*": "allow",
    "/private/tmp/**": "allow",
  });
});
