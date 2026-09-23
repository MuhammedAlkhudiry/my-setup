---
name: ux-ui
description: Use when designing, implementing, or reviewing an interface, or when the user asks for visual options to compare.
---

## Design workflow

- Inspect the user's goal, complete journey, platform conventions, design system, realistic content, and relevant states.
- Follow the established design system, theme, and visual character. Add components, tokens, or patterns for authorized work when they preserve those
  conventions.
- Favor calm, rich, professional, distinctive minimalism: clear hierarchy, balanced spacing, restrained color, and subtle depth.
- Make the next useful action clear at each stage of the journey. For example, offer resource creation in an empty state and contextual editing in a
  resource list.

## Requested options

- By default, create five substantially different options plus several more labeled **Wild**. Use the wild options to explore beyond the brief's
  design constraints and avoid settling for minor variations of the current approach.
- Present options in a new HTML preview or visualization by default. If the user requests options inside the app or website, present them there. In
  either format, include an option switcher.
- Loop animated previews when repetition helps compare the options.
- When the user selects an option without requesting implementation, acknowledge the selection and ask whether to integrate it.
- When the user selects multiple options or parts of different options, revise the design to combine the selected elements.
- Keep the HTML file minimal, focusing only on options.
- When the user asks for changes, create a new HTML file instead of editing the previous one.
- When the user points to one or more options, treat them as the chosen direction and generate new options from them.

## Design checks

After each design revision, inspect the rendered result and address each applicable item below. In the final response, summarize completed checks with
a green verification emoji. Identify any checks that could not be completed.

- Correct inconsistent spacing, gaps, padding, and margins.
- Check text contrast against each background and correct poor contrast.
- Clarify hierarchy and group related information and controls. Break up dense, undifferentiated content.
- Separate distinct areas with sections or containers where useful, without excessive nesting or visual boundaries.
- Refine visual appeal with purposeful icons, restrained color, and subtle, smooth microanimations. Keep these touches proportionate.
- Check every UI element against the design system and correct inconsistencies.
- Use the screen and text coverage in $power-user-qa to check responsive layouts and accessibility text sizing.
- Check loading, error, and recovery states. Make progress clear and provide a useful retry or recovery action when a flow fails.
- Keep button and label text readable; allow wrapping or layout changes at larger text sizes.

## Animation

- Include subtle micro-animations by default where they support the interaction. Keep them unobtrusive.
- Avoid distracting bounce, exaggerated motion, and flashy effects.
- Follow existing animation tokens.
