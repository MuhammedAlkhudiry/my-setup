import { posix } from "node:path";

const projectsRoot = "/Users/muhammed/PhpstormProjects";

export interface ActiveProject {
  id: string;
  name: string;
  remoteUrl: string;
  baseBranch: string;
  canonicalRoot: string;
}

export const ACTIVE_PROJECTS: ActiveProject[] = [
  {
    id: "awraq",
    name: "Awraq",
    remoteUrl: "https://github.com/MuhammedAlkhudiry/awraq-project.git",
    baseBranch: "main",
    canonicalRoot: posix.join(projectsRoot, "awraq-project"),
  },
  {
    id: "harium",
    name: "Harium",
    remoteUrl: "https://github.com/MuhammedAlkhudiry/harium-project.git",
    baseBranch: "main",
    canonicalRoot: posix.join(projectsRoot, "harium-project"),
  },
];

/**
 * Active projects verify changes the same way: these files match byte for byte on each base branch, and these mise tasks
 * carry the same description. `doctor` reports any drift. Only each project's areas and checks differ.
 */
export const SHARED_VERIFICATION = {
  files: [
    "scripts/check.ts",
    "scripts/test-hooks.ts",
    "scripts/check-tests/fixture.ts",
    "scripts/check-tests/cache.test.ts",
    "scripts/check-tests/failures.test.ts",
    "scripts/check-tests/full.test.ts",
    "scripts/check-tests/invalidation.test.ts",
    "scripts/check-tests/merge-safeguards.test.ts",
    "scripts/check-tests/merge.test.ts",
    "scripts/check-tests/output.test.ts",
    "scripts/check-tests/refusal.test.ts",
    "scripts/check-tests/retention.test.ts",
    "scripts/check-tests/reuse.test.ts",
    "scripts/check-tests/runtime.test.ts",
    "scripts/check-tests/tracking.test.ts",
    ".github/scripts/changed-files.sh",
    ".github/scripts/test-mysql.sh",
    "scripts/lint/test-order-oxlint-plugin.mjs",
    "scripts/test-order-lint.test.ts",
  ],
  tasks: ["check", "signoff", "premerge", "hooks:install"],
};
