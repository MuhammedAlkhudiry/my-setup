# hq pages

A page is one JSON file. Check it with `hq push page <file.json> --dry-run`, then push it with `hq push page <file.json>`, which prints
the URL and, for options blocks, their letters and keys (`--json` for both). Pushing the same `slug` again updates the page in place.

```json
{
  "slug": "onboarding-drop",
  "title": "Why onboarding dropped",
  "description": "One line on what the page is for.",
  "projects": ["setup"],
  "blocks": [{ "type": "verdict", "rating": "bad", "headline": "…", "findings": [{ "text": "…" }] }]
}
```

`projects` takes the project names `hq ask --project` takes. A `rating` is a RATINGS level in words: `very bad`, `bad`, `normal`, `good`, or `very good`; hq draws its emoji.

## Blocks

| `type`    | Fields                                                                                                                           | Use                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `verdict` | `rating`, `headline`, `findings[]` (up to 3: `text`, optional `rating`, `project`)                                               | The first screen                                            |
| `stats`   | `items[]`: `label`, `value`, optional `before`, `rating`, `reference`, `project`                                                 | A row of stat cards; `before` draws before → after          |
| `chart`   | `kind` (`line`, `bar`, `area`), `x[]`, `series[]` (`label`, `values[]`, optional `project`), optional `title`, `caption`, `unit` | A trend or comparison; a `project` series takes its color   |
| `table`   | `columns[]`, `rows[]` (`emoji`, `cells[]`), optional `title`, `caption`                                                          | Several values per item; a cell is text or `{text, rating}` |
| `prs`     | `items[]`: `state`, `number`, `title`, `url`, `context`, `risk`, `riskReason`, `opinion`                                         | PR status cards                                             |
| `options` | `id`, `title`, optional `context`, `multiple` (default true), `options[]`                                                        | A choice the owner picks on the page                        |
| `html`    | `html`, optional `title`, `caption`, `height`                                                                                    | A mockup, diagram, or custom visual                         |
| `section` | `title`, optional `caption`                                                                                                      | A heading between groups                                    |
| `text`    | `text`                                                                                                                           | A short paragraph, sparingly                                |
| `details` | `title`, `items[]`                                                                                                               | Collapsed methods and caveats                               |

PR `state` is one of `merged`, `closed`, `draft`, `conflicts`, `checks failing`, `merging now`, `checks running`, `needs you`, or
`ready to merge`; `risk` is `very low`, `low`, `medium`, `high`, or `very high`.

Consecutive `chart` and `table` blocks sit side by side on a laptop and stack on a phone.

## Options

Each option takes `label`, optional `tradeoff` (two plain sentences: what users see and why to pick it), `recommended`, and a preview:
`html` for a mockup drawn in the frame, or `image` as an `https:` or `data:image/` URL. With previews, the fixed pick bar switches between
them; without, the options show as a grid of cards. End with the Skip option that keeps today's behavior. Leave `key` out; the push sets
the keys from the block's letter. Give each options block its own `id` when a page has several.

## html

`html` is the body of a sandboxed frame: scripts run, but it cannot reach hq's data or the owner's sign-in. Inline its CSS and assets. It
gets a dark base and resizes to its content unless `height` is set. Draw with the project's mockup kit when one exists.
