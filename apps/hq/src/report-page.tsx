import type * as React from "react"
import { useReport } from "@/api"
import { Empty, ErrorCard, PageSkeleton, ReportShell } from "@/shared"
import type { Report } from "@contract"

/** Loads one report run (or the latest) and draws it inside the shared report shell. */
export function ReportPage<R extends Report>({ type, date, meta, body: Body }: {
  type: R["type"]
  date?: string
  meta: (report: R) => React.ReactNode
  body: (props: { report: R }) => React.ReactNode
}) {
  const { data, error, reload } = useReport<R>(type, date)
  if (!data) {
    if (!error) return <PageSkeleton />
    return <div className="p-4 md:p-6">{/no report/i.test(error) ? <Empty>No report yet. The keeper publishes one on its next run.</Empty> : <ErrorCard message={error} onRetry={reload} />}</div>
  }
  return <ReportShell report={data.report} dates={data.dates} meta={meta(data.report)}><Body report={data.report} /></ReportShell>
}
