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
  files: ["scripts/check.ts", ".github/scripts/changed-files.sh", ".github/scripts/test-mysql.sh"],
  tasks: ["check", "signoff", "premerge", "hooks:install"],
};
