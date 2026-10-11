# Screen and Text Coverage

For each platform in scope, start with four size/text combinations: typical/default, compact/default, compact/enlarged, and larger/default. Choose
supported devices or viewports, including short screens. Expand the matrix for breakpoints, orientations, other common text sizes, or
combinations only when the scope or a failure warrants it.

Record original device/simulator, viewport, orientation, locale, and font/display settings before changing them. Enlarge text to a common setting,
never the largest: on iOS, [Dynamic Type](https://developer.apple.com/design/human-interface-guidelines/typography) xxLarge, two steps above
default and below the accessibility sizes; on Android, [font scale](https://developer.android.com/about/versions/14/features#non-linear-font-scaling)
1.3×; on web, 150% browser zoom. Confirm the setting took effect in the app; investigate unchanged text.

Keep an app's font preference separate from OS text size. If present, check its default and one common larger step on the compact size with OS text
at default. Record display scaling and browser zoom separately.

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
