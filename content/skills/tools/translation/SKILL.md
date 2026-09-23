---
name: translation
description: Use when translating or localizing interface copy, reviewing existing translations, or writing Arabic interface copy.
---

For Arabic copy, also read [Arabic UX copy](references/arabic-ux-copy.md).

## Workflow

1. Inspect the product voice, locale files, UI context, placeholders, and plural rules.
2. Update every affected locale. Keep placeholders, ICU syntax, formatting, and exact values unchanged.
3. Return improved copy or specific review findings. State anything still unclear.

## Numerals

Always render Latin digits, including numbers produced by locale formatters.

## Review

For a review that spans sessions, save progress with $saved-work as type `tracker`.

Report each finding as:

```text
`translation.key`
Current: "..."
Suggested: "..."
Issue: missing | literal | unnatural | tone | context | placeholder
Reason: ...
```

Group repeated patterns once and reference them from affected keys.
