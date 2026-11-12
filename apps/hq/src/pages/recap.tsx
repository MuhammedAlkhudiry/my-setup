import { ArrowUpRight } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Logo, Rate, day, isExternal, riyadh } from "@/shared"
import { ReportPage } from "@/report-page"
import type { RecapReport, RecapRow } from "@contract"

function Rows({ title, description, rows }: { title: string; description: string; rows: RecapRow[] }) {
  if (!rows.length) return null
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {rows.map((r) => {
          const inner = (
            <>
              <Logo project={r.project} size={16} className="mt-0.5" />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-medium">{r.title}</span>
                <span className="block text-muted-foreground">{r.text}</span>
              </span>
              {r.date && <span className="shrink-0 text-xs text-muted-foreground">{day(r.date, { day: "numeric", month: "short" })}</span>}
              {r.url && <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            </>
          )
          const cls = "flex gap-3 border-t px-6 py-3 first:border-t-0"
          return r.url ? (
            <a key={r.title} href={r.url} target={isExternal(r.url) ? "_blank" : undefined} rel="noreferrer" className={`${cls} transition-colors hover:bg-accent/50`}>{inner}</a>
          ) : <div key={r.title} className={cls}>{inner}</div>
        })}
      </CardContent>
    </Card>
  )
}

function Body({ report }: { report: RecapReport }) {
  return (
    <>
      {!!report.business.length && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {report.business.map((b) => (
            <Card key={b.project + b.label} className="gap-1 py-4">
              <CardHeader className="px-4">
                <CardDescription className="flex items-center gap-1.5"><Logo project={b.project} size={14} />{b.label}</CardDescription>
                <CardTitle className="flex items-baseline gap-2 text-xl font-semibold tnum">{b.value}{b.rating && <span className="text-base"><Rate rating={b.rating} /></span>}</CardTitle>
              </CardHeader>
              {b.reference && <CardContent className="px-4 text-xs text-muted-foreground">{b.reference}</CardContent>}
            </Card>
          ))}
        </div>
      )}
      <div className="grid items-start gap-6 2xl:grid-cols-2">
        <Rows title="Shipped" description="Live for users now." rows={report.shipped} />
        <Rows title="Moving" description="In review, in the queue, or waiting on a build." rows={report.moving} />
      </div>
      <Rows title="Handled" description="Done without needing Muhammed." rows={report.handled} />
      {!!report.live.length && (
        <p className="text-xs text-muted-foreground">
          Live: {report.live.map((l) => <span key={l.project} className="me-3 inline-flex items-center gap-1"><Logo project={l.project} size={12} /><code>{l.sha.slice(0, 7)}</code></span>)}
        </p>
      )}
    </>
  )
}

const since = (r: RecapReport) =>
  `${day(r.since)} ${riyadh(r.since)} to ${day(r.until)} ${riyadh(r.until)} Riyadh`

export default function RecapPage({ date }: { date?: string }) {
  return <ReportPage<RecapReport> type="recap" date={date} meta={since} body={Body} />
}
