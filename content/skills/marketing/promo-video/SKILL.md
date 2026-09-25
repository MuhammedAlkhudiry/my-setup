---
name: promo-video
description: Use when making or revising a narrated promo, ad, or explainer video for a product as code-rendered animation.
---

A film is a canvas animation rendered frame by frame in headless Chrome, with AI voice-over and effects, mixed with FFmpeg. It lives in the
product's repository so it can read brand fonts, art, and sounds in place.

## Layout

Copy `scripts/` from this skill into the film folder as `tools/`, and add `playwright-core` to the film's `package.json`.

- `src/`: `index.html` (brand `@font-face`), `film.js` exporting a pure `render(ctx, t)`, and `timeline.js` with word cues. The page exposes
  `window.FILM` as described in `render.ts`. `canvas/lib.js` and `canvas/fx.js` are starter helpers to copy and adapt.
- `assets/`: pinned files the approved cut depends on: edited art, the final narration, and third-party sounds with their licences. Store images
  as lossless WebP and audio as FLAC.
- `tmp/` (gitignored): generated effects, catalogues, renders, and the full-quality master. Commit a compressed delivery copy.

Needs Bun, FFmpeg, ImageMagick, uv, Google Chrome, and an OpenRouter key capped to the job's budget.

## Process

1. **Story.** One person, one concrete situation, a turning point through the product, and a visible payoff. Open on the person in frame one.
   Land the product name last. Check every claim against the released product.
2. **Voice.** Record several takes and voices with `tts.ts`, then pick by listening and with `ask.ts`. Align words with `align.py`, then write
   `timeline.js` with `word-cues.py`. Every animation beat keys off a word, so a new take needs new cues.
3. **Picture.** Build scenes in `film.js` from the brand's real art and UI components. Generate only missing art, with `image-edit.ts`, in the
   same style.
4. **Review.** Render stills with `render.ts frames` and tile them with `contact-sheet.sh`. Review motion around every transition as slowed
   clips, not only stills. Get a second model's review with `ask.ts`. Reject any finding the rendered frames disprove.
5. **Sound.** Build the cue list from the film's own timing, synthesize missing effects with `sfx.py`, and mix with `mix.ts`.
6. **Deliver.** Render the video, mux it with the mix, and keep revision notes as separate briefs so each change stays traceable.

## Checks

- Render every Arabic string in Chrome before trusting a font; shaping bugs, such as a final «ة» without its dots, show only there.
- Keep one protagonist identical in every scene; replace any character baked into background art.
- Scale pixel art by whole numbers with nearest-neighbour sampling, and pre-resample backgrounds so push-ins do not shimmer.
- Show every spoken line on screen, so the film works with sound off.
- Quote religious text in the source's exact wording with its full attribution, and play only ambience under it.
- Use no music unless it is licensed for the target platforms.
