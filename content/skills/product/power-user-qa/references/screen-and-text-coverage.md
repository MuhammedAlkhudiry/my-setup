# Screen and Text Coverage

For each platform in scope, start with four size/text combinations: typical/default, compact/default, compact/enlarged, and larger/default. Choose
supported devices or viewports, including short screens. Expand the matrix for breakpoints, orientations, intermediate text sizes, or combinations
only when the scope or a failure warrants it.

Record original device/simulator, viewport, orientation, locale, and font/display settings before changing them. On native apps, enlarge text through
the largest OS accessibility text setting:
[iOS Dynamic Type, including accessibility sizes](https://developer.apple.com/design/human-interface-guidelines/typography), or
[Android font scaling](https://developer.android.com/about/versions/14/features#non-linear-font-scaling). Confirm the setting took effect in the app;
investigate unchanged text. On web, check [200% text enlargement](https://www.w3.org/WAI/WCAG21/Understanding/resize-text) and
[reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) using browser text resizing/zoom.

Keep an app's font preference separate from OS accessibility sizing. If present, check its default and largest setting on the compact size with OS
text at default, then combine the largest app and OS settings when they can coexist. Record display scaling and browser zoom separately.

## Usability checks

On the affected journeys in each selected configuration:

- Scroll to the first and last list items. Verify content and actions remain readable and reachable around headers, safe areas, and fixed/floating
  composers or other overlays.
- Show and hide the software keyboard. Enter and edit multiline text; verify the focused field, caret, and submit action remain reachable as the
  composer grows, and content remains reachable after keyboard dismissal.
- Use long, realistic content. Check wrapping, clipping, overlap, and unintended horizontal scrolling. Labels may wrap or layouts may adapt; required
  text must remain available. Tap controls to confirm usable targets and spacing after reflow.
- When supported, repeat the compact/enlarged-text case in English and Arabic RTL. Check reading order, alignment, and mixed-direction content.

## Evidence and restoration

Report tested journeys, platform/OS version, device/viewport dimensions with units, orientation, locale, exact OS/app font and zoom settings, results,
and evidence. List untested coverage and why. One platform's screenshot does not verify another.

Restore the recorded settings before handoff, including after failed checks. Verify restoration and report any settings left changed.
