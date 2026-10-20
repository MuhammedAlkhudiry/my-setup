---
name: show-me
description: Use when the user asks to visualize something or prose is getting long.
---

Pick the smallest view that makes the point clear. Skip the preamble and keep prose brief.

## Views

- Logic or algorithm: pseudocode.
- Runtime control flow: call tree.
- UI structure: component tree with relevant state, module boundaries, and source paths.
- File responsibilities or broad refactor: shallow file tree.
- Component interaction or data flow: Mermaid when supported; a text tree in a plain terminal.
- Proposed code shape: types and signatures.

## Changes

Use `diff` when the surrounding shape exists and the point is what changes. Apply it to the chosen view.

Show the whole block instead when most of it is new, when omitted context would hide ownership or order, or when the user needs a copyable target
shape.

## HTML

For a visual UI, layout, state comparison, or concept too dense for text and Mermaid, build one focused page with $html-artifacts: a diagram, an
infographic, or a short slide deck. Match the product's colors, type, spacing, and components, and use real labels and data.

## Guidance

- Place each visual next to the short text it supports.
- Include only the calls, files, props, states, and boundaries needed for the question.
- Add another view only when it explains something new.
