# Plans

Save plans, interviews, trackers, research, reviews, QA runs, and reports in `~/plans/<project>/<slug>.md`, never a repository. Use the lowercase
project name, not a worktree or clone name. Without a writable location, return the complete document and say it was not saved.

Preserve the supplied content. Start each file with `created`, `updated`, `project`, `description`, `status`, and `type` frontmatter, and refresh
`updated` on every save.

## Types

- `plan` for work to do. This is the default.
- `interview` for interview results, including partial interviews.
- `tracker` for work spanning sessions.
- `research` for findings that inform a later decision.
- `report` for point-in-time reviews, audits, QA runs, or measurements.

## Status

- Use `pending` for work that has not started, `progress` for work underway, and `done` for completed work.
- A decision that already rules out a change goes into the repository's decisions when it is made, on the current branch or a new docs branch;
  the plan keeps only the build details.
- Before marking a document `done`, move its decisions, postponed work, rules, and open findings into their repository homes on the branch that
  ships the work. Then move the document into `~/plans/<project>/archive/`.
