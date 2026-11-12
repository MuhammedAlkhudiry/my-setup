import * as React from "react"
import { AlertCircle, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { sendAnswer, useStatus } from "@/api"
import { RATING_EMOJI, type Answer, type Keeper, type Money, type Project, type Rating, type Report, type StatusItem } from "@contract"

export const PROJECT: Record<Project, { name: string; logo?: string; text: string }> = {
  awraq: { name: "Awraq", logo: "/awraq.png", text: "text-awraq" },
  harium: { name: "Harium", logo: "/harium.png", text: "text-harium" },
  setup: { name: "Setup", text: "text-muted-foreground" },
}
export const KEEPER: Record<Keeper, string> = { housekeeper: "Housekeeper", ops: "Ops", business: "Business" }

export function Logo({ project, size = 18, className }: { project: Project; size?: number; className?: string }) {
  const p = PROJECT[project]
  if (!p.logo)
    return (
      <span
        className={cn("inline-grid shrink-0 place-items-center rounded-[5px] bg-muted text-[10px] font-semibold text-muted-foreground", className)}
        style={{ width: size, height: size }}
      >
        S
      </span>
    )
  return <img src={p.logo} width={size} height={size} alt="" style={{ width: size, height: size }} className={cn("shrink-0 rounded-[5px] object-cover", className)} />
}

export function ProjectMark({ projects, size = 18 }: { projects: Project[]; size?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span className="flex -space-x-1">
        {projects.map((p) => <Logo key={p} project={p} size={size} className="ring-2 ring-card" />)}
      </span>
      {projects.map((p, i) => (
        <React.Fragment key={p}>
          {i > 0 && <span className="text-muted-foreground">+</span>}
          <span className={PROJECT[p].text}>{PROJECT[p].name}</span>
        </React.Fragment>
      ))}
    </span>
  )
}

export const Rate = ({ rating }: { rating?: Rating }) =>
  rating ? <span title={rating} aria-label={rating}>{RATING_EMOJI[rating]}</span> : null

export const money = (m: Money) =>
  `${m.currency} ${m.amount.toLocaleString("en-US", { maximumFractionDigits: Math.abs(m.amount) < 100 ? 2 : 0 })}`

export const age = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 36e5)
  return h < 1 ? "now" : h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

export const day = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(iso))

export const riyadh = (iso: string, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", ...opts }).format(new Date(iso))

export const isExternal = (url: string) => !url.startsWith("#/")

// ---- states ------------------------------------------------------------------------------------------------------------

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <AlertCircle className="size-4 text-destructive" />
        <span className="flex-1">{message}</span>
        {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
      </CardContent>
    </Card>
  )
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6" aria-busy>
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <Card><CardContent className="py-6 text-center text-sm text-muted-foreground">{children}</CardContent></Card>
}

// ---- decisions ---------------------------------------------------------------------------------------------------------

const SPECIAL: Record<string, string> = { later: "Ask again later", handled: "I took care of it", skip: "Skipped", read: "Read" }
const choiceLabel = (item: StatusItem, choice: string) =>
  item.options?.find((o) => o.key === choice)?.label ?? SPECIAL[choice] ?? (choice || "Note")

/** One owner decision. The same card renders on the status page and inside the report that raised it. */
export function DecisionCard({ item, compact = false }: { item: StatusItem; compact?: boolean }) {
  const status = useStatus()
  const saved = status.data?.answers[item.id]
  const [answer, setAnswer] = React.useState<Answer | null | undefined>(undefined)
  const [noteOpen, setNoteOpen] = React.useState(false)
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const current = answer === undefined ? saved : answer

  // `clear` undoes a pick; a note with no choice is sent on its own.
  const send = async (choice: string, clear = false) => {
    setBusy(clear ? "undo" : choice)
    setError(null)
    try {
      setAnswer(await sendAnswer(item.id, choice, clear ? "" : note.trim()))
      if (clear) setNote("")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (current)
    return (
      <Card className="gap-0 py-4 animate-in fade-in-0">
        <CardContent className="flex items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary"><Check className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.title}</p>
            <p className="truncate text-sm text-muted-foreground">
              {choiceLabel(item, current.choice)}{current.note ? ` · “${current.note}”` : ""} · sent to {KEEPER[item.owner]}
            </p>
          </div>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => send("", true)}>
            {busy === "undo" ? <Loader2 className="animate-spin" /> : <Undo2 />}Undo
          </Button>
        </CardContent>
      </Card>
    )

  // The question's own letter, such as "A" for options A1, A2, A3; older items only have lettered options.
  const keys = new Set(item.options?.map((o) => o.key))
  const letters = (item.letters.filter((l) => !keys.has(l)).join(" ") || [...keys].join(" "))

  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <ProjectMark projects={item.projects} />
          <span>·</span>
          <span>{KEEPER[item.owner]}</span>
          <span>·</span>
          <span>{age(item.updatedAt)}</span>
        </div>
        {!compact && <CardAction><span className="font-mono text-xs text-muted-foreground">{letters}</span></CardAction>}
        <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
        {item.detail && <CardDescription className="leading-relaxed">{item.detail}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {(!!item.links.length || item.report) && (
          <div className="flex flex-wrap gap-2">
            {item.report && (
              <Button variant="secondary" size="sm" asChild>
                <a href={item.report} target={isExternal(item.report) ? "_blank" : undefined} rel="noreferrer">
                  {isExternal(item.report) ? <>Options page<ExternalLink /></> : <>Open report<ChevronRight /></>}
                </a>
              </Button>
            )}
            {item.links.map((l) => (
              <Button key={l.label + l.url} variant="secondary" size="sm" asChild>
                <a href={l.url} target={isExternal(l.url) ? "_blank" : undefined} rel="noreferrer">{l.label}{isExternal(l.url) && <ExternalLink />}</a>
              </Button>
            ))}
          </div>
        )}
        <div className={cn("grid gap-2", !compact && "sm:grid-cols-2")}>
          {item.options?.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={!!busy}
              onClick={() => send(o.key)}
              className={cn(
                "group flex min-h-16 flex-col items-start gap-1 rounded-lg border bg-background/40 p-3 text-start transition-colors",
                "hover:border-foreground/30 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none disabled:opacity-60",
                o.recommended && "border-foreground/25",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{o.key}</span>
                <span className="text-sm font-medium">{o.label}</span>
                {busy === o.key && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                {o.recommended && <Badge variant="secondary" className="ms-auto">Recommended</Badge>}
              </span>
              {o.tradeoff && <span className="text-xs leading-relaxed text-muted-foreground">{o.tradeoff}</span>}
            </button>
          ))}
        </div>
        {noteOpen && (
          <Textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A note, sent with your pick"
            className="min-h-16 animate-in fade-in-0"
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
      <CardFooter className="flex-wrap gap-1 border-t pt-3! [.border-t]:pt-3">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setNoteOpen((v) => !v)}>Add a note</Button>
        {noteOpen && note.trim() && (
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => send("")}>Send note only</Button>
        )}
        <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={!!busy} onClick={() => send("later")}>Later</Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={!!busy} onClick={() => send("handled")}>I took care of it</Button>
        <Button variant="ghost" size="sm" className="ms-auto text-muted-foreground" disabled={!!busy} onClick={() => send("skip")}>Skip</Button>
      </CardFooter>
    </Card>
  )
}

// ---- report shell ------------------------------------------------------------------------------------------------------

/** The skeleton every report shares: date navigator, verdict first, the report's own body, and its decisions beside it. */
export function ReportShell({ report, dates, meta, children }: { report: Report; dates: string[]; meta: React.ReactNode; children: React.ReactNode }) {
  const status = useStatus()
  const decisions = (status.data?.items ?? []).filter((i) => report.decisions.includes(i.id))
  const index = dates.indexOf(report.date)
  const older = dates[index + 1]
  const newer = index > 0 ? dates[index - 1] : undefined
  const to = (date?: string) => (date ? `#/reports/${report.type}/${date}` : undefined)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{meta} · {KEEPER[report.owner]} keeper</p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-8" disabled={!older} aria-label="Older run" asChild={!!older}>
            {older ? <a href={to(older)}><ChevronLeft /></a> : <ChevronLeft />}
          </Button>
          <Button variant="outline" size="sm" className="tnum" asChild><a href={to(report.date)}>{day(report.date)}</a></Button>
          <Button variant="outline" size="icon" className="size-8" disabled={!newer} aria-label="Newer run" asChild={!!newer}>
            {newer ? <a href={to(newer)}><ChevronRight /></a> : <ChevronRight />}
          </Button>
        </div>
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex gap-3 text-xl leading-snug font-semibold md:text-2xl">
            <span><Rate rating={report.verdict.rating} /></span>{report.verdict.headline}
          </CardTitle>
        </CardHeader>
        {!!report.verdict.findings.length && (
          <CardContent>
            <ul className="grid gap-3 md:grid-cols-3">
              {report.verdict.findings.map((f) => (
                <li key={f.text} className="flex gap-2.5 rounded-lg border p-3 text-sm leading-snug">
                  <Logo project={f.project} size={18} />
                  <span>{f.rating && <><Rate rating={f.rating} /> </>}{f.text}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      {decisions.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="flex min-w-0 flex-col gap-6">{children}</div>
          <aside className="order-first flex flex-col gap-3 xl:order-none">
            <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">Decide here <Badge variant="outline">{decisions.length}</Badge></h3>
            {decisions.map((item) => <DecisionCard key={item.id} item={item} compact />)}
          </aside>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      )}
      {!!report.notes.length && (
        <details className="group rounded-xl border bg-card p-4 text-sm">
          <summary className="cursor-pointer list-none font-medium marker:hidden">How this was read <span className="text-muted-foreground group-open:hidden">· show</span></summary>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
