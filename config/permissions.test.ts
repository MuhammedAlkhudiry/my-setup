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
  expect(claude).toContain("Edit(~/PhpstormProjects/*)");
  expect(claude).toContain("Read(**/.env*)");
  expect(claude).not.toContain("Bash(ddev *)");

  const rules = renderCodexRules(profile);
  expect(rules).toContain('prefix_rule(pattern=["git"], decision="allow")');
  expect(rules).toContain('prefix_rule(pattern=["herd"], decision="allow")');
  expect(rules.startsWith("# Managed by my-setup")).toBe(true);
});
