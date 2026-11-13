import * as React from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { ArrowUpRight, Check, Loader2, MessageSquare } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ErrorCard, Logo, PageSkeleton, ProjectMark, Rate, age, isExternal } from "@/shared"
import { pageDraftId, sendPageDrafts, setDraft, useDrafts, useLive } from "@/api"
import { cn } from "@/lib/utils"
import { RISK_EMOJI, type Answer, type Block, type Cell, type OptionsBlock, type Page } from "@contract"

type PageData = { page: Page; picks: Record<string, Answer | null>; delivering: boolean }

// ---- sandboxed HTML ----------------------------------------------------------------------------------------------------

// The frame gets scripts but no same-origin access, so custom HTML cannot read hq's data or act as Muhammed.
const FRAME_BASE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:dark}html,body{margin:0;background:transparent;color:#e7e7ea;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}img,svg,video{max-width:100%}</style>
<script>addEventListener("load",()=>{const post=()=>parent.postMessage({hqFrameHeight:document.documentElement.scrollHeight},"*");post();new ResizeObserver(post).observe(document.documentElement)})</script>
</head><body>`

function Sandbox({ html, height, title }: { html: string; height?: number; title: string }) {
  const ref = React.useRef<HTMLIFrameElement>(null)
  const [auto, setAuto] = React.useState(240)

  React.useEffect(() => {
    if (height) return
    const on = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && typeof e.data?.hqFrameHeight === "number") setAuto(Math.min(4000, Math.ceil(e.data.hqFrameHeight)))
    }
    addEventListener("message", on)
    return () => removeEventListener("message", on)
  }, [height])

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      srcDoc={FRAME_BASE + html + "</body></html>"}
      className="block w-full rounded-lg border-0 bg-transparent"
      style={{ height: height ?? auto }}
    />
  )
}

// ---- blocks ------------------------------------------------------------------------------------------------------------

function Verdict({ block }: { block: Extract<Block, { type: "verdict" }> }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex gap-3 text-xl leading-snug font-semibold md:text-2xl">
          <span><Rate rating={block.rating} /></span>{block.headline}
        </CardTitle>
      </CardHeader>
      {!!block.findings.length && (
        <CardContent>
          <ul className="grid gap-3 md:grid-cols-3">
            {block.findings.map((f) => (
              <li key={f.text} className="flex gap-2.5 rounded-lg border p-3 text-sm leading-snug">
                {f.project && <Logo project={f.project} size={18} />}
                <span>{f.rating && <><Rate rating={f.rating} /> </>}{f.text}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  )
}

function Stats({ block }: { block: Extract<Block, { type: "stats" }> }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", block.items.length >= 4 ? "lg:grid-cols-4" : block.items.length === 3 && "lg:grid-cols-3")}>
      {block.items.map((s) => (
        <Card key={s.label} className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription className="flex items-center gap-1.5">{s.project && <Logo project={s.project} size={14} />}{s.label}</CardDescription>
            <CardTitle className="flex flex-wrap items-baseline gap-x-2 text-xl font-semibold tnum">
              {s.before && <span className="text-base font-normal text-muted-foreground">{s.before} →</span>}
              {s.value}
              {s.rating && <span className="text-base"><Rate rating={s.rating} /></span>}
            </CardTitle>
          </CardHeader>
          {s.reference && <CardContent className="px-4 text-xs text-muted-foreground">{s.reference}</CardContent>}
        </Card>
      ))}
    </div>
  )
}

function Titled({ title, caption, children, flush }: { title?: string; caption?: string; children: React.ReactNode; flush?: boolean }) {
  return (
    <Card className="min-w-0 gap-3">
      {(title || caption) && (
        <CardHeader>
          {title && <CardTitle>{title}</CardTitle>}
          {caption && <CardDescription>{caption}</CardDescription>}
        </CardHeader>
      )}
      <CardContent className={cn(flush && "px-0")}>{children}</CardContent>
    </Card>
  )
}

const cellText = (cell: Cell) => (typeof cell === "string" ? cell : cell.text)

function DataTable({ block }: { block: Extract<Block, { type: "table" }> }) {
  const emoji = block.rows.some((r) => r.emoji)
  return (
    <Titled title={block.title} caption={block.caption} flush>
      <Table>
        <TableHeader>
          <TableRow>
            {block.columns.map((c, i) => <TableHead key={c + i} className={cn("first:ps-6 last:pe-6", i > 0 && "text-end")}>{c}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, r) => (
            <TableRow key={r}>
              {row.cells.map((cell, i) => (
                <TableCell key={i} className={cn("first:ps-6 last:pe-6 tnum", i > 0 && "text-end", i === 0 && "font-medium")}>
                  <span className="inline-flex items-center gap-1.5">
                    {i === 0 && emoji && <span>{row.emoji}</span>}
                    {cellText(cell)}
                    {typeof cell !== "string" && <Rate rating={cell.rating} />}
                  </span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Titled>
  )
}

function DataChart({ block }: { block: Extract<Block, { type: "chart" }> }) {
  const keys = block.series.map((_, i) => `s${i}`)
  const config = Object.fromEntries(
    block.series.map((s, i) => [keys[i], { label: s.label, color: s.project && s.project !== "setup" ? `var(--${s.project})` : `var(--chart-${(i % 5) + 1})` }]),
  ) satisfies ChartConfig
  const rows = block.x.map((x, i) => Object.fromEntries([["x", x], ...block.series.map((s, j) => [keys[j], s.values[i] ?? null])]))
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="x" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
      <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}${block.unit ?? ""}`} />
      <ChartTooltip content={<ChartTooltipContent />} />
      {block.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
    </>
  )
  return (
    <Titled title={block.title} caption={block.caption}>
      <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
        {block.kind === "bar" ? (
          <BarChart data={rows}>{axes}{keys.map((k) => <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={4} isAnimationActive={false} />)}</BarChart>
        ) : block.kind === "area" ? (
          <AreaChart data={rows}>{axes}{keys.map((k) => <Area key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.15} isAnimationActive={false} />)}</AreaChart>
        ) : (
          <LineChart data={rows} margin={{ right: 12, top: 8 }}>{axes}{keys.map((k) => <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />)}</LineChart>
        )}
      </ChartContainer>
    </Titled>
  )
}

const PR_STATE: Record<Extract<Block, { type: "prs" }>["items"][number]["state"], string> = {
  merged: "🟣 MERGED",
  closed: "⚪ CLOSED",
  draft: "📝 DRAFT",
  conflicts: "⚔️ CONFLICTS",
  "checks failing": "🔴 CHECKS FAILING",
  "merging now": "🚀 MERGING NOW",
  "checks running": "⏳ CHECKS RUNNING",
  "needs you": "💬 NEEDS YOU",
  "ready to merge": "🟢 READY TO MERGE",
}

function Prs({ block }: { block: Extract<Block, { type: "prs" }> }) {
  return (
    <section className="flex flex-col gap-3">
      {block.title && <h3 className="text-sm font-medium text-muted-foreground">{block.title}</h3>}
      <div className="grid gap-3 lg:grid-cols-2">
        {block.items.map((pr) => (
          <Card key={pr.url} className="gap-3 py-4">
            <CardHeader className="px-4">
              <span className="text-xs font-semibold tracking-wide">{PR_STATE[pr.state]}</span>
              <CardTitle className="text-base leading-snug">
                <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">#{pr.number} {pr.title}</a>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-4 text-sm leading-snug">
              <p className="text-muted-foreground">{pr.context}</p>
              <p><span className="text-muted-foreground">Merge risk</span> {RISK_EMOJI[pr.risk]} {pr.risk}: {pr.riskReason}</p>
              <p><span className="text-muted-foreground">Honest opinion</span> {pr.opinion}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

// ---- options -----------------------------------------------------------------------------------------------------------

function Options({ block, slug, sent, raised }: { block: OptionsBlock; slug: string; sent: Answer | null; raised: boolean }) {
  const previews = block.options.some((o) => o.html || o.image)
  const [view, setView] = React.useState(0)
  const id = pageDraftId(slug, block.id)
  const draft = useDrafts()[id]
  const [noteOpen, setNoteOpen] = React.useState(!!draft?.note)
  const picked = (draft?.choice ?? "").split(" ").filter(Boolean)
  const note = draft?.note ?? ""
  const label = (key: string) => block.options.find((o) => o.key === key)?.label ?? key
  const chosen = new Set((sent?.choice ?? "").split(" ").filter(Boolean))

  const toggle = (key: string) => {
    const next = picked.includes(key) ? picked.filter((k) => k !== key) : block.multiple ? [...picked, key].sort() : [key]
    setDraft(id, { choice: next.join(" "), note })
  }
  const current = block.options[view]

  return (
    <Card className={cn("gap-4 pb-0 transition-colors", draft && "border-foreground/40")}>
      <CardHeader>
        <CardTitle className="text-lg leading-snug">{block.title}</CardTitle>
        {block.context && <CardDescription className="leading-relaxed">{block.context}</CardDescription>}
        {block.letter && <CardAction><Badge variant="outline" className="font-mono">{block.letter}</Badge></CardAction>}
      </CardHeader>

      <CardContent className="space-y-3">
        {previews ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-lg border bg-background/40">
              {current.html ? <Sandbox key={view} html={current.html} title={current.label} /> : current.image ? <img src={current.image} alt={current.label} className="mx-auto block max-h-[70vh] w-auto" /> : <p className="p-6 text-sm text-muted-foreground">No preview for this option.</p>}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-xs text-muted-foreground">{current.key}</span>
              <span className="font-medium">{current.label}</span>
              {current.recommended && <Badge variant="secondary">Recommended</Badge>}
              {current.tradeoff && <p className="w-full text-sm leading-relaxed text-muted-foreground">{current.tradeoff}</p>}
            </div>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {block.options.map((o) => {
              const on = picked.includes(o.key!) || chosen.has(o.key!)
              return (
                <button
                  key={o.key}
                  type="button"
                  disabled={!!sent}
                  onClick={() => toggle(o.key!)}
                  aria-pressed={on}
                  className={cn(
                    "flex min-h-16 flex-col items-start gap-1 rounded-lg border bg-background/40 p-3 text-start transition-colors outline-none",
                    "hover:border-foreground/30 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:bg-background/40",
                    o.recommended && "border-foreground/25",
                    on && "border-foreground bg-accent disabled:hover:bg-accent",
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{o.key}</span>
                    <span className="text-sm font-medium">{o.label}</span>
                    {on && <Check className="size-4" />}
                    {o.recommended && <Badge variant="secondary" className="ms-auto">Recommended</Badge>}
                  </span>
                  {o.tradeoff && <span className="text-xs leading-relaxed text-muted-foreground">{o.tradeoff}</span>}
                </button>
              )
            })}
          </div>
        )}
        {noteOpen && !sent && (
          <Textarea autoFocus={!note} value={note} onChange={(e) => setDraft(id, { choice: picked.join(" "), note: e.target.value })} placeholder="A note, sent with your picks" className="min-h-16 animate-in fade-in-0" />
        )}
      </CardContent>

      {/* The block's bar stays on screen while it is in view, above the page's Send bar, so switching never needs scrolling. */}
      <div className={cn("sticky z-10 rounded-b-xl border-t bg-card/95 px-4 py-3 backdrop-blur transition-[bottom] md:px-6", raised ? "bottom-[76px]" : "bottom-0")}>
        {sent ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary"><Check className="size-4" /></span>
            <span className="min-w-0 flex-1">
              {[...chosen].map((k) => `${k} ${label(k)}`).join(" + ") || "Note"}{sent.note ? ` · “${sent.note}”` : ""}
              <span className="text-muted-foreground"> · sent {age(sent.at)} ago</span>
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {previews &&
              block.options.map((o, i) => (
                <Button
                  key={o.key}
                  variant={view === i ? "secondary" : "ghost"}
                  size="sm"
                  className={cn("font-mono", picked.includes(o.key!) && "ring-1 ring-foreground")}
                  onClick={() => setView(i)}
                  aria-label={`Show ${o.key} ${o.label}`}
                >
                  {o.key}{picked.includes(o.key!) && <Check />}
                </Button>
              ))}
            {previews && (
              <Button variant="outline" size="sm" onClick={() => toggle(current.key!)}>
                {picked.includes(current.key!) ? <>Unpick {current.key}</> : <>Pick {current.key}</>}
              </Button>
            )}
            {!previews && <span className="text-sm text-muted-foreground">{picked.length ? `Picked ${picked.join(" + ")}` : block.multiple ? "Pick one or more" : "Pick one"}</span>}
            <Button variant="ghost" size="icon" className="ms-auto size-8 text-muted-foreground" aria-label="Add a note" onClick={() => setNoteOpen((v) => !v)}>
              <MessageSquare />
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

/** One Send for every block on the page, so the thread that pushed it gets all the picks in one message. */
function PageSendBar({ slug, blocks, asker, onSent }: { slug: string; blocks: string[]; asker: string; onSent: () => void }) {
  const drafts = useDrafts()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const keys = blocks.flatMap((b) => drafts[pageDraftId(slug, b)]?.choice.split(" ").filter(Boolean) ?? [])
  const count = blocks.filter((b) => drafts[pageDraftId(slug, b)]).length
  if (!count) return null

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendPageDrafts(slug, blocks)
      onSent()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pointer-events-none sticky bottom-0 z-20 -mt-2 flex justify-center pb-4">
      <div className="pointer-events-auto flex h-14 w-full max-w-xl items-center gap-3 rounded-xl border bg-card/95 p-2 ps-4 shadow-lg backdrop-blur animate-in fade-in-0 slide-in-from-bottom-2">
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium tnum">{keys.length ? keys.join(" ") : `${count} note${count === 1 ? "" : "s"}`}</span>
          <span className="text-muted-foreground">{error ? ` · ${error}` : ` · to ${asker}`}</span>
        </span>
        <Button disabled={busy} onClick={send}>{busy && <Loader2 className="animate-spin" />}Send</Button>
      </div>
    </div>
  )
}

// ---- page --------------------------------------------------------------------------------------------------------------

const WIDE = new Set<Block["type"]>(["table", "chart"])

/** Consecutive tables and charts sit side by side on wide screens. */
function rowsOf(blocks: Block[]): Block[][] {
  const rows: Block[][] = []
  for (const block of blocks) {
    const last = rows.at(-1)
    if (last && WIDE.has(block.type) && WIDE.has(last[0].type) && last.length < 2) last.push(block)
    else rows.push([block])
  }
  return rows
}

function BlockView({ block, data, raised }: { block: Block; data: PageData; raised: boolean }) {
  switch (block.type) {
    case "verdict": return <Verdict block={block} />
    case "section":
      return (
        <div className="pt-2">
          <h2 className="text-lg font-semibold tracking-tight">{block.title}</h2>
          {block.caption && <p className="text-sm text-muted-foreground">{block.caption}</p>}
        </div>
      )
    case "text": return <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-muted-foreground">{block.text}</p>
    case "stats": return <Stats block={block} />
    case "table": return <DataTable block={block} />
    case "chart": return <DataChart block={block} />
    case "prs": return <Prs block={block} />
    case "options":
      return <Options block={block} slug={data.page.slug} sent={data.picks[block.id] ?? null} raised={raised} />
    case "html":
      return <Titled title={block.title} caption={block.caption}><Sandbox html={block.html} height={block.height} title={block.title ?? "Custom view"} /></Titled>
    case "details":
      return (
        <details className="group rounded-xl border bg-card p-4 text-sm">
          <summary className="cursor-pointer list-none font-medium marker:hidden">{block.title} <span className="text-muted-foreground group-open:hidden">· show</span></summary>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">{block.items.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      )
  }
}

export default function PageView({ slug }: { slug: string }) {
  const { data, error, reload } = useLive<PageData>(`/api/pages/${slug}`)
  const drafts = useDrafts()

  React.useEffect(() => {
    if (data) document.title = `${data.page.title} · hq`
  }, [data])

  if (!data) return error ? <div className="p-4 md:p-6"><ErrorCard message={error} onRetry={reload} /></div> : <PageSkeleton />
  const { page } = data
  // Blocks already sent take no new picks; drafts left on them from before are ignored.
  const open = page.blocks.flatMap((b) => (b.type === "options" && !data.picks[b.id] ? [b.id] : []))
  const raised = open.some((b) => drafts[pageDraftId(slug, b)])

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <ProjectMark projects={page.projects} />
          {page.thread && (
            <>
              <span>·</span>
              <a href={page.thread.link} target={isExternal(page.thread.link) ? "_blank" : undefined} rel="noreferrer" className="inline-flex items-center gap-1 truncate hover:text-foreground">
                {page.thread.title}<ArrowUpRight className="size-3.5" />
              </a>
            </>
          )}
          {page.updatedAt && <><span>·</span><span>{age(page.updatedAt)}</span></>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
        {page.description && <p className="max-w-3xl text-sm text-muted-foreground">{page.description}</p>}
      </div>
      {rowsOf(page.blocks).map((row, i) =>
        row.length > 1 ? (
          <div key={i} className="grid items-start gap-6 lg:grid-cols-2">{row.map((b, j) => <BlockView key={j} block={b} data={data} raised={raised} />)}</div>
        ) : (
          <BlockView key={i} block={row[0]} data={data} raised={raised} />
        ),
      )}
      <PageSendBar slug={slug} blocks={open} asker={page.thread?.title ?? "the thread"} onSent={reload} />
    </div>
  )
}
