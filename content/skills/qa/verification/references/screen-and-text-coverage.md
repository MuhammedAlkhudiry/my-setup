# Screen and Text Coverage

Start with one typical phone size on iOS; Android needs the owner's approval (see $browser-simulator-routing). Add compact screens,
enlarged text, other breakpoints, or orientations only when the change affects layout or text size, or a failure warrants them. Capture
affected screens once; do not repeat before/after sets for unchanged screens.

Record device/simulator, viewport, orientation, locale, and font/display settings before changing them. Use common enlarged text, never the largest:
iOS [Dynamic Type](https://developer.apple.com/design/human-interface-guidelines/typography) xxLarge (two steps above default, below accessibility
sizes), Android [font scale](https://developer.android.com/about/versions/14/features#non-linear-font-scaling) 1.3×, or web browser zoom 150%.
Confirm the app reflects the setting; investigate unchanged text.

When testing text size, check any app font preference at default and one common larger step on compact screens with OS text at default.
Record app font size, OS text size, display scaling, and browser zoom separately.

## Usability checks

For affected journeys in each selected configuration:

- Scroll to first and last list items; check readability and access around headers, safe areas, composers, and overlays.
- Show/hide the software keyboard and edit multiline text. Keep the focused field, caret, and submit action reachable as the composer grows,
  and content reachable after dismissal.
- Use long, realistic content to check wrapping, clipping, overlap, and unintended horizontal scrolling. Required text must stay available.
  Tap controls to verify targets and spacing after reflow.
- When supported, repeat compact/enlarged in English and Arabic RTL; check reading order, alignment, and mixed-direction content.

## Evidence and restoration

Report journeys, platform/OS version, dimensions with units, orientation, locale, exact font/display/zoom settings, results, evidence, and untested
coverage with reasons. One platform's screenshot does not verify another.

Restore and verify recorded settings before handoff, even after failures. Report any left changed.
