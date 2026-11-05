export const meta = {
  name: 'exhaustive-sweep',
  description: 'Judge every inventory item on every dimension with evidence, re-inventory blind, and spot-check clean cells',
  whenToUse: 'Started by the exhaustive skill with args {task, root, scope, items, dimensions, sliceSize}',
  phases: [
    { title: 'Re-inventory', detail: 'list the items blind and diff against the inventory' },
    { title: 'Audit', detail: 'one fresh agent per slice fills every cell with evidence' },
    { title: 'Spot-check', detail: 'a skeptic re-checks clean cells, weighted to the end of each slice' },
  ],
}

// args: {task, root, scope, items: string[], dimensions: [{name, check}], sliceSize?: number}
const SLICE_SIZE = args.sliceSize || 20
const SPOT_PER_SLICE = 8
const MISS_LIMIT = 2

const ROW = {
  type: 'object',
  properties: {
    item: { type: 'string' },
    dimension: { type: 'string' },
    verdict: { type: 'string', enum: ['issue', 'ok', 'na'] },
    file: { type: 'string' },
    line: { type: 'integer' },
    quote: { type: 'string', description: 'Verbatim text from file at or within 2 lines of line' },
    note: { type: 'string', description: 'The issue, why it is ok, or why it does not apply' },
  },
  required: ['item', 'dimension', 'verdict', 'note'],
}
const ROWS = { type: 'object', properties: { rows: { type: 'array', items: ROW } }, required: ['rows'] }
const LIST = { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] }
const SPOT = {
  type: 'object',
  properties: {
    cells: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, dimension: { type: 'string' }, missed: { type: 'boolean' }, row: ROW },
        required: ['item', 'dimension', 'missed'],
      },
    },
  },
  required: ['cells'],
}

// Deterministic shuffle so the same folder is not always last; scripts cannot use Math.random.
const hash = text => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)
const shuffled = [...args.items].sort((a, b) => hash(a) - hash(b))
const slices = []
for (let i = 0; i < shuffled.length; i += SLICE_SIZE) slices.push(shuffled.slice(i, i + SLICE_SIZE))
log(`${args.items.length} items × ${args.dimensions.length} dimensions in ${slices.length} slices`)

const dimensionText = args.dimensions.map(d => `- ${d.name}: ${d.check}`).join('\n')
const key = (item, dimension) => `${item}\u0000${dimension}`

const auditPrompt = (items, extra = '') => `Task: ${args.task}
Repository root: ${args.root}

Judge each item below on each dimension. Read every item in full yourself, in the order given; give the last item the same depth as
the first. Return exactly one row per item × dimension (${items.length * args.dimensions.length} rows).
- issue or ok: file (relative to the root), line, and a verbatim quote of the code that shows it, copied from that line or within
  2 lines of it. The quote must show the thing judged, not a nearby signature.
- na: a note saying why the dimension cannot apply to this item.
Never reuse one note or one quote for several cells. Change nothing.

Dimensions:
${dimensionText}

Items:
${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}${extra}`

function gaps(items, rows) {
  const have = new Set(rows.map(r => key(r.item, r.dimension)))
  const missing = []
  for (const item of items) for (const d of args.dimensions) if (!have.has(key(item, d.name))) missing.push(`${item} [${d.name}]`)

  return missing
}

async function audit(items, index, label) {
  const first = await agent(auditPrompt(items), { label: `${label} ${index}`, phase: 'Audit', schema: ROWS })
  let rows = first ? first.rows : []
  const missing = gaps(items, rows)
  if (missing.length) {
    const retry = await agent(auditPrompt(items, `\n\nOnly these cells are missing; return rows for them:\n${missing.join('\n')}`),
      { label: `${label} ${index} gaps`, phase: 'Audit', schema: ROWS })
    rows = rows.concat(retry ? retry.rows : [])
  }

  return rows.map(r => ({ ...r, slice: index }))
}

// Clean cells from the back half of the slice are sampled first: that is where attention thins.
function spotSample(items, rows) {
  const order = new Map(items.map((item, i) => [item, i]))
  const clean = rows.filter(r => r.verdict !== 'issue')
  const late = clean.filter(r => order.get(r.item) >= items.length / 2)
  const early = clean.filter(r => order.get(r.item) < items.length / 2)
  const pick = (list, n) => [...list].sort((a, b) => hash(key(a.item, a.dimension)) - hash(key(b.item, b.dimension))).slice(0, n)
  const lateCount = Math.ceil(SPOT_PER_SLICE * 0.75)

  return pick(late, lateCount).concat(pick(early, SPOT_PER_SLICE - Math.min(lateCount, late.length)))
}

const spotPrompt = cells => `Task: ${args.task}
Repository root: ${args.root}

Another agent marked these cells ok or na. For each, read the code yourself and try to find a real issue on that dimension that it
missed. Set missed=true only for a concrete issue, and then give the full row (verdict issue, file, line, verbatim quote, note).

Dimensions:
${dimensionText}

Cells:
${cells.map(c => `- ${c.item} [${c.dimension}] ${c.verdict}: ${c.note}`).join('\n')}`

const [reinventory, results] = await parallel([
  () => agent(`List every item in scope for this task, without any prior list. Use the strongest source you can find (framework
commands, manifests, file listings), then search for anything that source misses.
Task: ${args.task}
Scope: ${args.scope}
Repository root: ${args.root}
Return item identifiers in the same form as these examples: ${args.items.slice(0, 3).join(', ')}`,
    { label: 'blind re-inventory', phase: 'Re-inventory', schema: LIST }),
  () => pipeline(
    slices,
    (items, _, index) => audit(items, index, 'slice'),
    async (rows, items, index) => {
      const sample = spotSample(items, rows)
      if (!sample.length) return { index, rows, checked: 0, missed: [] }
      const spot = await agent(spotPrompt(sample), { label: `spot ${index}`, phase: 'Spot-check', schema: SPOT })
      const missed = spot ? spot.cells.filter(c => c.missed && c.row) : []
      const fixed = new Map(missed.map(c => [key(c.item, c.dimension), { ...c.row, slice: index }]))
      const patch = list => list.map(r => fixed.get(key(r.item, r.dimension)) || r)
      if (missed.length < MISS_LIMIT) return { index, rows: patch(rows), checked: sample.length, missed }

      log(`slice ${index}: spot-check found ${missed.length} misses in ${sample.length} clean cells; re-auditing the slice`)
      const redo = await audit(items, index, 'reaudit')

      return { index, rows: patch(redo), checked: sample.length, missed, reaudited: true }
    },
  ),
])

const known = new Set(args.items)
const unlisted = reinventory ? reinventory.items.filter(item => !known.has(item)) : null
if (unlisted === null) log('blind re-inventory failed; coverage of the inventory itself is unchecked')
else if (unlisted.length) log(`blind re-inventory found ${unlisted.length} items missing from the inventory`)

const done = results.filter(Boolean)
const failedSlices = slices.map((_, i) => i).filter(i => !done.some(r => r.index === i))
if (failedSlices.length) log(`slices with no result: ${failedSlices.join(', ')}`)

return {
  rows: done.flatMap(r => r.rows),
  unlisted,
  failedSlices,
  spot: {
    checked: done.reduce((n, r) => n + r.checked, 0),
    missed: done.reduce((n, r) => n + r.missed.length, 0),
    reaudited: done.filter(r => r.reaudited).map(r => r.index),
  },
}
