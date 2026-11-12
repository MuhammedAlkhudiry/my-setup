import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Logo, PROJECT, Rate, money } from "@/shared"
import { ReportPage } from "@/report-page"
import { cn } from "@/lib/utils"
import type { FinanceReport, Line } from "@contract"

const monthName = (month: string, style: "long" | "short" = "long") =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: style, year: style === "long" ? "numeric" : undefined }).format(new Date(`${month}-01`))

function Row({ line, strong }: { line: Line; strong?: boolean }) {
  return (
    <div className={cn("px-6 py-2.5 text-sm", strong && "border-t font-medium")}>
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1">{line.label}</span>
        <span className="shrink-0 text-end tnum">
          {line.before && <span className="me-1.5 font-normal text-muted-foreground">{money(line.before)} →</span>}
          {money(line.amount)}{line.rating && <> <Rate rating={line.rating} /></>}
        </span>
      </div>
      {line.note && <p className="mt-0.5 text-xs font-normal text-muted-foreground">{line.note}</p>}
    </div>
  )
}

function ProjectCard({ p }: { p: FinanceReport["projects"][number] }) {
  return (
    <Card className="gap-2 pb-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Logo project={p.project} size={20} /><span className={PROJECT[p.project].text}>{PROJECT[p.project].name}</span></CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <p className="px-6 pt-1 text-xs font-medium text-muted-foreground">Revenue</p>
        {p.revenue.map((l) => <Row key={l.label} line={l} />)}
        {!p.revenue.length && <p className="px-6 py-2 text-sm text-muted-foreground">None</p>}
        <p className="px-6 pt-3 text-xs font-medium text-muted-foreground">Costs</p>
        {p.costs.map((l) => <Row key={l.label} line={l} />)}
        <Row line={p.net} strong />
      </CardContent>
    </Card>
  )
}

function Trend({ report }: { report: FinanceReport }) {
  const projects = report.projects.map((p) => p.project)
  const config = Object.fromEntries(projects.map((p) => [p, { label: PROJECT[p].name, color: `var(--${p})` }])) satisfies ChartConfig
  const rows = report.history.map((h) => ({ month: monthName(h.month, "short"), ...h.net }))
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Net by month</CardTitle>
        <CardDescription>Revenue minus costs, {report.currency}.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-6">
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <BarChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis width={44} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {projects.map((p) => <Bar key={p} dataKey={p} fill={`var(--color-${p})`} radius={3} isAnimationActive={false} />)}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function Body({ report }: { report: FinanceReport }) {
  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-2">{report.projects.map((p) => <ProjectCard key={p.project} p={p} />)}</div>
      {report.history.length > 1 && <Trend report={report} />}
    </>
  )
}

export default function FinancePage({ date }: { date?: string }) {
  return <ReportPage<FinanceReport> type="finance" date={date} meta={(r) => monthName(r.month)} body={Body} />
}
