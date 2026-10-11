# Demo media

Capture with the tool chosen by $browser-simulator-routing, then edit the capture into a demo that a reviewer understands without running the
branch. Choose the editing tools yourself.

- Setup never appears: the demo starts on the screen where the change begins.
- Only the change remains: page loads, typing, navigation, retries, and idle time are cut. A wait the flow needs is sped up and labeled.
- A short caption at each step names what changes on screen.
- The changed region is readable: crop or zoom when it is small on the full screen.
- Before and after appear side by side, or in sequence with a label for each.
- A video shows a flow, lasts under 30 seconds, and stays under 10 MB. A screenshot shows a static state, cropped to the changed region with the
  change marked.
- The final cut is checked for wrong text, stale states, and private data.

Include media only when it shows something a reviewer needs, such as a UI change, a visual bug, or output that is hard to read as text. Put
every media file on one demo page built with $html-artifacts: one labeled block per changed surface, such as web or mobile, light or dark, and
RTL, with before and after side by side and each video or screenshot under its caption. For chat review, follow the parent skill's inline
preview preference. Never upload media to GitHub or ask the user to upload it.

<!-- profile:personal -->

A demo linked from a PR needs a shareable URL: publish it as a separate artifact through $html-artifacts. Under 🎬 Demo, link the URL with a
label naming what it covers.

<!-- /profile -->
<!-- profile:work -->

Keep demo artifacts local under $html-artifacts. Link the local file in the reply. In the MR, use an existing reviewer-accessible demo link
when available; otherwise state that a shareable demo is unavailable.

<!-- /profile -->
