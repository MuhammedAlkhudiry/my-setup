# Demo media

Capture through $browser-simulator-routing and edit with tools of your choice. Reviewers must understand the change without running the branch.

- Start where the change begins; cut setup, page loads, typing, navigation, retries, and idle time. Speed up and label necessary waits.
- Caption each step, crop or zoom for readability, and label before/after states side by side or in sequence.
- Use video for flows (under 30 seconds and 10 MB); use cropped, marked screenshots for static states.
- Check the final cut for wrong text, stale states, and private data.

Include media only when reviewers need it. Put all media on one $html-artifacts demo page: labeled blocks per changed surface (platform,
theme, RTL), before/after side by side, captions above media. Follow the parent skill's inline-preview preference for chat review.
Never upload media to GitHub or ask the user to upload it.

<!-- profile:personal -->

Publish PR demos as separate artifacts through $html-artifacts. Link the shareable URL under 🎬 Demo with a label naming what it covers.

<!-- /profile -->
<!-- profile:work -->

Keep $html-artifacts demos local and link the file in the reply. In the MR, use an existing reviewer-accessible demo link or state that a
shareable demo is unavailable.

<!-- /profile -->
