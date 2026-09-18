---
name: translation
description: Use when translating or localizing interface copy, reviewing existing translations, or writing Arabic interface copy.
---

## Workflow

1. Inspect the product voice, locale files, UI context, placeholders, and plural rules.
2. Update every affected locale. Preserve dynamic placeholders, formatting, and content that must remain exact.
3. Read [references/arabic-ux-copy.md](references/arabic-ux-copy.md) for Arabic interface copy.
4. Return improved copy or specific review findings. State anything still unclear.

## Review

To save review progress, keep `.translations-review/<feature-or-file>/translation-review.md` with files and languages, progress, issues by severity,
and approved patterns. Read and update it on every continuation.

Report each finding as:

```text
`translation.key`
Current: "..."
Suggested: "..."
Issue: missing | literal | unnatural | tone | context | technical
Reason: ...
```

Group repeated patterns once and reference them from affected keys.
