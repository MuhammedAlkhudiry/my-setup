# UI review gate

Before a PR that changes what users see is marked ready:

1. **Matrix:** running-app screenshots beside the approved mockup on the smallest supported iPhone (Android only for Android-specific
   work, per $browser-simulator-routing), RTL when the app supports it, keyboard open on any input, and every state that exists.
2. **Review:** one fresh Claude reviewer, never the builder and never Codex, gets a short brief: the matrix, the owner's complaint
   verbatim with its screenshot when there is one, and the weights below. No checklist; it judges by its own taste with $ux-ui and
   $product-taste, and scores each area out of 10 (owner, 2026-11-09).

   | Area                                                                                         | Weight |
   | -------------------------------------------------------------------------------------------- | ------ |
   | Fits the app's direction and ways: how its screens feel and behave, beyond the design system | 30%    |
   | UX/UI taste                                                                                  | 30%    |
   | Product taste, as a power user sees it; a new user must still get it                         | 20%    |
   | UI and visual bugs                                                                           | 20%    |

3. **Verdict:**
   - The owner's complaint is checked first: any part still visible is a reject, even when a recorded decision or shared component
     caused it; the builder raises that conflict to the owner instead of keeping the flaw.
   - Below 7 weighted: reject. The builder redoes the direction, not patches it; the reviewer may say plainly it is crap and propose
     other directions.
   - 7 or more with any bug left: a fix list; every bug is fixed. Otherwise pass.
   - A fix list or redo gets one recheck by a new fresh reviewer.
