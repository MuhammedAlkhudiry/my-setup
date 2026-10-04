# Visual prototype

- Render every item as a realistic mockup of the real product screen, in the frames of the project's `mockup-kit/` for the platforms it
  affects, with real copy and text direction. Without a kit, match the product's design system by hand.
- Once a project gets prototypes repeatedly, give it a `mockup-kit/` in its repo instead of rebuilding styles per page:
  - `kit.json`: `css` (files in `mockup-kit/`), optional `fonts` (`dir` and `files`, from the repo root), and optional `images` (`dir` and
    resize `width`). `html-artifact new` copies them to `kit/`, `kit/fonts/`, and `kit/images/<name>.webp`.
  - `kit.css`: device frames and the product's components, every class under one prefix, using `fonts/<file>`.
  - `example.html` showing every component, and a `README.md` listing the classes.
- Mark what is new with one to three short callouts on the mockup. Put the item's title and one-line detail beside it.
- Put each item in a `card` with ID, title, and chips in its header. Show before and after with `pair`; use `shot-empty` for a missing capture.
- For more than a few items, give each subagent a range of items, one fragment file per item, then assemble one page.
- Check the `html-artifact check` screenshots for clipping, overlap, and wrong text direction before handing the page over.
