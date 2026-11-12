import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Logo, PROJECT, Rate, day } from "@/shared"
import { ReportPage } from "@/report-page"
import { cn } from "@/lib/utils"
import type { ProductHealthReport } from "@contract"

type ProjectHealth = ProductHealthReport["projects"][number]

function Metrics({ p, columns, usualLabel }: { p: ProjectHealth; columns: string[]; usualLabel: string }) {
  const last = columns.length - 1
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Logo project={p.project} size={20} /><span className={PROJECT[p.project].text}>{PROJECT[p.project].name}</span></CardTitle>
        {p.errors && <CardDescription>{p.errors}</CardDescription>}
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-44 ps-6">Metric</TableHead>
              {columns.map((c, i) => <TableHead key={c} className={cn("text-end", i < last && "hidden sm:table-cell")}>{c}</TableHead>)}
              <TableHead className="hidden text-end md:table-cell">{usualLabel}</TableHead>
              <TableHead className="w-10 pe-6 text-center"><span className="sr-only">Rating</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.metrics.map((m) => (
              <TableRow key={m.label}>
                <TableCell className="ps-6 whitespace-normal">
                  <span className="block font-medium">{m.label}</span>
                  {m.usual && <span className="block text-xs text-muted-foreground md:hidden">{usualLabel} {m.usual}</span>}
                  {m.note && <span className="block text-xs text-muted-foreground">{m.note}</span>}
                </TableCell>
                {m.values.map((v, i) => (
                  <TableCell key={i} className={cn("text-end tnum", i < last ? "hidden text-muted-foreground sm:table-cell" : "font-medium")}>{v}</TableCell>
                ))}
                <TableCell className="hidden text-end text-muted-foreground tnum md:table-cell">{m.usual ?? "–"}</TableCell>
                <TableCell className="pe-6 text-center"><Rate rating={m.rating} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const STATE = { carried: "Still open", dropped: "Dropped", closed: "Closed" } as const

function Body({ report }: { report: ProductHealthReport }) {
  return (
    <>
      <div className="grid items-start gap-6 2xl:grid-cols-2">
        {report.projects.map((p) => <Metrics key={p.project} p={p} columns={report.columns} usualLabel={report.usualLabel} />)}
      </div>
      {!!report.carried.length && (
        <Card className="gap-2">
          <CardHeader>
            <CardTitle>Earlier findings</CardTitle>
            <CardDescription>What earlier runs flagged and where each stands now.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {report.carried.map((c) => (
              <div key={c.project + c.title} className="flex gap-3 border-t px-6 py-3 first:border-t-0">
                <Logo project={c.project} size={16} className="mt-0.5" />
                <div className={cn("min-w-0 flex-1 text-sm", c.state !== "carried" && "text-muted-foreground")}>
                  <p className="font-medium">{c.title}</p>
                  <p className="text-muted-foreground">{c.why}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{STATE[c.state]}{c.days ? ` · ${c.days}d` : ""}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  )
}

export default function ProductHealthPage({ date }: { date?: string }) {
  return <ReportPage<ProductHealthReport> type="product-health" date={date} meta={(r) => `Data to the end of ${day(r.dataTo)}, Riyadh`} body={Body} />
}
