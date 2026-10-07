# Plans

Save plans, interview results, progress trackers, research notes, reviews, QA runs, and reports as `~/plans/<project>/<slug>.md`, never in a
repository. Use the project's lowercase name, not a worktree or clone folder name. When no writable location exists, return the complete
document and state that it was not saved.

Preserve the supplied content. Start each file with `created`, `updated`, `project`, `description`, `status`, and `type` frontmatter, and refresh
`updated` on every save.

## Types

- `plan` for work to do. This is the default.
- `interview` for a completed interview's decisions.
- `tracker` for progress through work that spans sessions, such as a review, walkthrough, or upgrade.
- `research` for findings that inform a later decision.
- `report` for a point-in-time result, such as a review, audit, QA run, or measurement.

## Status

- Use `pending` for work that has not started, `progress` for work underway, and `done` for completed work.
- A decision that already rules out a change goes into the repository's decisions when it is made, on the current branch or a new docs branch;
  the plan keeps only the build details.
- Before marking a document `done`, move its decisions, postponed work, rules, and open findings into their repository homes on the branch that
  ships the work. Then move the document into `~/plans/<project>/archive/`.
