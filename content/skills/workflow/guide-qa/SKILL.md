---
name: guide-qa
description: Use when the user asks to be guided through implemented work to inspect or QA it, one step at a time.
---

- Understand the change and prepare a working target with $browser-simulator-routing before guiding the user.
- Present one useful action at a time: what to do, the exact linked target or mobile screen, required account and starting state, and the
  observable result to expect. Skip trivial changes.
- On confirmation, continue to the next action. If something fails, investigate it before continuing.
- Keep progress in the conversation; resume from the last confirmed action and recheck any part changed since then.
- End with what passed and any remaining issues.
