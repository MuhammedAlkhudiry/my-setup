---
name: translation
description: Use before writing user-facing copy, editing locale files, or reviewing translations.
---

For Arabic, read [Arabic UX copy](references/arabic-ux-copy.md).

Translate meaning, never words: write each string as a native speaker would say it in that moment, because a word-for-word calque reads as
a machine. This covers AI prompts and their examples, whose wording models copy.

Check product voice, UI context, locales, placeholders, and plural rules. Update every affected locale; preserve placeholders, ICU syntax,
formatting, and exact values. State unresolved context.

Always render Latin digits, including locale-formatted numbers.

## Review

Report each finding with the translation key, current copy, suggestion, issue (`missing`, `literal`, `unnatural`, `tone`, `context`, or
`placeholder`), and reason. Group repeated patterns and reference them from affected keys.

Save reviews spanning sessions through $project-docs as type `tracker`.
