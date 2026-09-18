# Arabic UX/UI Copy

Use this for Arabic interface copy across actions, forms, feedback, onboarding, settings, permissions, checkout, subscriptions, and terminology.

## Workflow and defaults

1. Write purposeful, concise, natural فصحى مبسطة; use a more formal register for legal, privacy, payment, government, and policy text.
2. Match the product's gender, currency, punctuation, terminology, and system-action voice.
3. Preserve variables, tags, links, product names, emails, filenames, codes, SKUs, API names, plan IDs, and ICU syntax exactly.
4. Check for literal English structure, broken placeholder order, plural errors, and mixed RTL/LTR rendering.

- Keep the product's gender strategy. If none exists, use masculine imperative for direct actions, masdar labels for neutral or formal menus, and
  personalized gender only with reliable data and rendering support.
- Always use Latin digits (`1,250`), never Eastern Arabic-Indic (`١٬٢٥٠`).
- Avoid diacritics unless needed for clarity. Use dialect only when the product voice intentionally does so.

## Arabic-specific corrections

- Avoid `تم` + مصدر, heavy passive, `قم بـ`, `القيام بـ`, `لقد قمت بـ`, `الخاص بك`, routine `يرجى`, unnecessary `هو/هي`, existential `هناك`, and
  `بشكل` + adjective. Prefer direct verbs, results, possessive suffixes, and front-loaded content.
- Remove filler such as `بنجاح`, `عملية`, `هذا/هذه`, `هنا`, and padded `الذي/التي` when meaning is unchanged.
- Use `لـ` instead of `من أجل` when it fits; use `أو` instead of slash alternatives.
- Use `إذا` for expected choices, `إن` for uncertain problems, and `عندما` for real time events.
- Prefer action-first Arabic over an English SVO skeleton.
- Catch common calques: `حقل` → `خانة`, `تحت المراجعة` → `قيد المراجعة`, `يشير إلى` → `يعني` or `يدل على`, `بناءً على` → `حسب` or `وفق`, `بسيط` for
  easy → `سهل` or `يسير`, subscription `الخطة` → `الباقة`, error `نأسف` → `عذرًا` or no apology, `ذات صلة` → `مناسبة` or `ملائمة`, compatibility
  `يدعم` → `يعمل على` or `متوافق مع`.
