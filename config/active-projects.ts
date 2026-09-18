import { join } from "node:path";

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
    canonicalRoot: join(projectsRoot, "awraq-project"),
  },
  {
    id: "harium",
    name: "Harium",
    remoteUrl: "https://github.com/MuhammedAlkhudiry/harium-project.git",
    baseBranch: "main",
    canonicalRoot: join(projectsRoot, "harium-project"),
  },
];

export function getActiveProject(projectId: string): ActiveProject {
  const project = ACTIVE_PROJECTS.find(({ id }) => id === projectId);
  if (!project) throw new Error(`No active project named ${projectId}`);
  return project;
}
