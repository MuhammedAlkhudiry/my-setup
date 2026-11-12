import * as React from "react"
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Logo, PROJECT, Rate, day, money } from "@/shared"
import { ReportPage } from "@/report-page"
import type { AdsProject, AdsReport, Campaign, Platform, Rating } from "@contract"

const PLATFORM: Record<Platform, string> = { meta: "Meta", x: "X", google: "Google", snap: "Snap", tiktok: "TikTok", apple: "Apple" }

function Kpi({ p, label, value, before, rating, reference }: { p: AdsProject; label: string; value: string; before?: string; rating?: Rating; reference?: string }) {
  return (
    <Card className="gap-2 py-5">
      <CardHeader className="px-5">
        <CardDescription className="flex items-center gap-1.5"><Logo project={p.project} size={14} />{label}</CardDescription>
        <CardTitle className="flex items-baseline gap-2 whitespace-nowrap text-xl font-semibold tabular-nums sm:text-2xl">
          {value}{rating && <span className="text-base"><Rate rating={rating} /></span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 text-sm text-muted-foreground tnum">
        {before && <span className="block">{before} → {value}</span>}
        {reference && <span className="block">{reference}</span>}
      </CardContent>
    </Card>
  )
}

const SERIES_COLOR: Record<Platform | "all", string> = {
  all: "var(--color-foreground)", meta: "var(--chart-3)", x: "var(--chart-5)", google: "var(--chart-4)",
  snap: "var(--chart-2)", tiktok: "var(--chart-1)", apple: "var(--chart-2)",
}

function CostChart({ p }: { p: AdsProject }) {
  const [series, setSeries] = React.useState<string>("all")
  const platforms = [...new Set(p.daily.flatMap((d) => Object.keys(d.byPlatform) as Platform[]))]
  const per = (spend?: number, results?: number) => (spend !== undefined && results ? +(spend / results).toFixed(1) : undefined)
  const rows = p.daily.map((d) => ({
    date: d.date,
    all: per(d.spend, d.results),
    ...Object.fromEntries(platforms.map((k) => [k, per(d.byPlatform[k]?.spend, d.byPlatform[k]?.results)])),
  })) as Record<string, number | string | undefined>[]
  const keys = series === "all" ? ["all", ...platforms] : [series]
  const config = Object.fromEntries(
    ["all", ...platforms].map((k) => [k, { label: k === "all" ? "All paid" : PLATFORM[k as Platform], color: SERIES_COLOR[k as Platform] }]),
  ) satisfies ChartConfig

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Logo project={p.project} size={18} />Cost per {p.resultLabel}, by day</CardTitle>
        <CardDescription>{p.line ? `The dashed line is the ${money(p.line)} stop line.` : p.usual ? `Usual ${p.usual}.` : "Cost per result each day."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-2 sm:px-6">
        {platforms.length > 1 && (
          <div className="px-4 sm:px-0">
            <ToggleGroup type="single" variant="outline" size="sm" value={series} onValueChange={(v) => v && setSeries(v)}>
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              {platforms.map((k) => <ToggleGroupItem key={k} value={k}>{PLATFORM[k]}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        )}
        <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
          <LineChart data={rows} margin={{ left: 0, right: 12, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(d) => day(d, { day: "numeric", month: "short" })} />
            <YAxis width={36} tickLine={false} axisLine={false} />
            {p.line && <ReferenceLine y={p.line.amount} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" />}
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(d) => day(String(d))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            {keys.map((k) => (
              <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={k === "all" ? 2.5 : 1.5} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function Campaigns({ p }: { p: AdsProject }) {
  const result = (c: Campaign) =>
    c.costPer ? `${money(c.costPer)} per ${p.resultLabel}` : c.state === "stopped" ? "Not delivering" : "Off"
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Logo project={p.project} size={20} /><span className={PROJECT[p.project].text}>{PROJECT[p.project].name}</span></CardTitle>
        <CardDescription className="tnum">
          {money(p.total.spend)} for {p.total.results} {p.total.results === 1 ? p.resultLabel : p.resultPlural} = {money(p.total.costPer)} each
          {p.line ? ` against the ${money(p.line)} line` : ""} <Rate rating={p.total.rating} />
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-6">Campaign</TableHead>
              <TableHead className="hidden sm:table-cell">Budget</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="hidden lg:table-cell pe-6">Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.campaigns.map((c) => (
              <TableRow key={c.platform + c.name} className={c.state === "paused" || c.state === "off" ? "text-muted-foreground" : ""}>
                <TableCell className="ps-6">
                  <span className="block font-medium">{PLATFORM[c.platform]} <span className="font-normal text-muted-foreground">{c.name !== PLATFORM[c.platform] ? c.name : ""}</span></span>
                  <span className="block text-xs text-muted-foreground">
                    {c.state === "running" ? (c.endsOn ? `Ends ${day(c.endsOn, { day: "numeric", month: "short" })}` : "No end date") : c.state[0].toUpperCase() + c.state.slice(1)}
                  </span>
                </TableCell>
                <TableCell className="hidden tnum sm:table-cell">{c.budgetPerDay ? `${money(c.budgetPerDay)}/day` : "–"}</TableCell>
                <TableCell className="tnum whitespace-normal">{c.rating && <><Rate rating={c.rating} /> </>}{result(c)}
                  {c.note && <span className="block text-xs text-muted-foreground lg:hidden">{c.note}</span>}
                </TableCell>
                <TableCell className="hidden max-w-64 whitespace-normal text-muted-foreground lg:table-cell pe-6">{c.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Body({ report }: { report: AdsReport }) {
  const charted = report.projects.filter((p) => p.daily.length > 1)
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {report.projects.flatMap((p) => [
          <Kpi key={p.project + "cost"} p={p} label={`${PROJECT[p.project].name} per ${p.resultLabel}`} value={money(p.total.costPer)}
            before={p.total.before && money(p.total.before.costPer)} rating={p.total.rating}
            reference={p.line ? `Line ${money(p.line)}` : p.usual ? `Usual ${p.usual}` : undefined} />,
          <Kpi key={p.project + "results"} p={p} label={`${PROJECT[p.project].name} ${p.resultPlural}`} value={String(p.total.results)}
            before={p.total.before && String(p.total.before.results)} reference={`${money(p.total.spend)} spent`} />,
        ])}
      </div>
      {charted.map((p) => <CostChart key={p.project} p={p} />)}
      {report.projects.map((p) => <Campaigns key={p.project} p={p} />)}
    </>
  )
}

const period = (r: AdsReport) =>
  r.period.from === r.period.to ? `Spend for ${day(r.period.to)}` : `Spend ${day(r.period.from)} to ${day(r.period.to)}`

export default function AdsPage({ date }: { date?: string }) {
  return <ReportPage<AdsReport> type="ads" date={date} meta={period} body={Body} />
}
