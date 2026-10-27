# Tech debt

Use `docs/tech-debt/<slug>.md` for one postponed task or follow-up, including known failures and post-release monitoring. State:

- what remains and where it applies;
- why it is postponed;
- the trigger that makes it due, such as a minimum app version, a date, or an outside event;
- how to complete it, and the evidence that shows it is safe;
- `Revisit by: YYYY-MM-DD`, at most three months ahead.

## Pruning

Keep an entry only when the work is worth doing and has a clear trigger. Delete it when:

- the work is done, or the problem no longer reproduces;
- it affects vanishingly rare cases, unless it risks security, data loss, or incorrect persisted data;
- nobody would schedule it: no trigger, or a cost above its benefit.

A past revisit date forces a choice: delete the entry, or confirm it still passes and set a new date.
