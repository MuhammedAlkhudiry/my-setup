# Mockups

- Draw with the project's `mockup-kit/` classes (see its `README.md`); add a missing component to the kit, not the page.
- Build one working UI, not a screen per state: wire its taps, tabs, sheets, and inputs with inline script, and switch empty, loading, and
  error states in place. Show several static screens only when comparing them is the point: before and after, alternatives, or story steps.
- To change an existing screen, rebuild all of it from a screenshot of the running app, with header, navigation, and nearby sections at their
  real size and position. Draw untouched parts as the theme's `skel` blocks at the same size; never leave them out.
- Before handover, click through every state in a browser; `html-artifact check` captures only the first.
