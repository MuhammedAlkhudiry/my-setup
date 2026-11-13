import * as React from "react"
import { ArrowUpRight, Check, ChevronRight } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DecisionCard, Empty, ErrorCard, KEEPER, Logo, PageSkeleton, ProjectMark, Rate, age, isExternal } from "@/shared"
import { sendAnswer, useStatus } from "@/api"
import { cn } from "@/lib/utils"
import type { Keeper, Project, StatusItem } from "@contract"

export type Filter = "all" | Project

// Needs you is split per keeper, each asking in its own thread (owner, 2026-11-12: NO-RELAY).
const KEEPER_ORDER: Keeper[] = ["housekeeper", "ops", "business"]
const KEEPER_THREADS: Record<Keeper, string> = {
  housekeeper: "feb86885-0ba2-42b9-9bf2-2a149f93fd86",
  ops: "mcp:launch:2dd1db018a86258cdfd58d47021105634813412850dfc951d9a6f2f6431c6903",
  business: "mcp:launch:0458dfd31db6e08afa91d84897375cfeef0886231daf6b25e47e79c8b40ac0c2",
}
const keeperThread = (keeper: Keeper) => `t3-thread://v2/536353db-2939-4391-bd29-eb07c7af97a3/${KEEPER_THREADS[keeper]}`

function ReadRow({ item, first }: { item: StatusItem; first: boolean }) {
  const status = useStatus()
  const [read, setRead] = React.useState(!!status.data?.answers[item.id])
  const external = item.report ? isExternal(item.report) : false
  const body = (
    <>
      <span className="pt-0.5 text-sm"><Rate rating={item.rating} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {item.projects.map((p) => <Logo key={p} project={p} size={14} />)}
          {KEEPER[item.owner]} · {age(item.updatedAt)}
          {external && <span>· one-off page</span>}
        </span>
        <span className="mt-1 block text-sm font-medium leading-snug">{item.title}</span>
        {item.detail && <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{item.detail}</span>}
      </span>
    </>
  )

  return (
    <div className={cn("flex items-start gap-1 pe-2", !first && "border-t", read && "opacity-50")}>
      {item.report ? (
        <a href={item.report} target={external ? "_blank" : undefined} rel="noreferrer" className="flex min-w-0 flex-1 gap-3 p-4 transition-colors hover:bg-accent/50 rounded-xl">
          {body}
          {external ? <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        </a>
      ) : (
        <div className="flex min-w-0 flex-1 gap-3 p-4">{body}</div>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="mt-2.5 size-8 shrink-0 text-muted-foreground"
        aria-label={read ? "Mark unread" : "Mark read"}
        title={read ? "Mark unread" : "Mark read"}
        onClick={() => { setRead(!read); sendAnswer(item.id, read ? "" : "read").catch(() => setRead(read)) }}
      >
        <Check className={cn(read && "text-foreground")} />
      </Button>
    </div>
  )
}

export default function StatusPage({ filter, setFilter }: { filter: Filter; setFilter: (f: Filter) => void }) {
  const status = useStatus()
  if (!status.data) return status.error ? <div className="p-4 md:p-6"><ErrorCard message={status.error} onRetry={status.reload} /></div> : <PageSkeleton />

  const items = status.data.items.filter((i) => filter === "all" || i.projects.includes(filter))
  const group = (g: StatusItem["group"]) => items.filter((i) => i.group === g)
  const needs = group("Needs you"), read = group("To read"), scheduled = group("Scheduled"), watching = group("Watching")
  const waiting = needs.filter((i) => !status.data!.answers[i.id]).length

  // One group per keeper, each asking in its own thread.
  const groups = [
    ...KEEPER_ORDER.map((keeper) => ({
      key: keeper,
      title: KEEPER[keeper],
      link: keeperThread(keeper),
      items: needs.filter((i) => i.owner === keeper),
    })),
  ].filter((g) => g.items.length)

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {status.error && <ErrorCard message={status.error} onRetry={status.reload} />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {waiting ? `${waiting} decision${waiting === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you` : "Nothing needs you"}
          </h2>
          <p className="text-sm text-muted-foreground">{read.length} to read · {scheduled.length} scheduled · {watching.length} watched</p>
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="awraq"><Logo project="awraq" size={14} />Awraq</TabsTrigger>
            <TabsTrigger value="harium"><Logo project="harium" size={14} />Harium</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <span className="truncate">{g.title}</span>
                <span className="rounded-full bg-secondary px-1.5 text-xs text-foreground tnum">{g.items.length}</span>
                <a href={g.link} className="ms-auto inline-flex shrink-0 items-center gap-1 text-xs hover:text-foreground">
                  Open thread<ArrowUpRight className="size-3.5" />
                </a>
              </h3>
              {g.items.map((item) => <DecisionCard key={item.id} item={item} />)}
            </section>
          ))}
          {!needs.length && <Empty>Nothing needs you here.</Empty>}
        </div>

        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-muted-foreground">To read</h3>
            {read.length ? (
              <Card className="gap-0 py-0">{read.map((item, i) => <ReadRow key={item.id} item={item} first={i === 0} />)}</Card>
            ) : <Empty>Nothing to read.</Empty>}
          </section>

          <section id="scheduled" className="flex scroll-mt-20 flex-col gap-3">
            <h3 className="text-sm font-medium text-muted-foreground">Scheduled</h3>
            {scheduled.length ? (
              <Card className="gap-0 py-2">
                {scheduled.map((item) => (
                  <div key={item.id} className="flex flex-col gap-0.5 px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium leading-snug">
                      {item.projects.map((p) => <Logo key={p} project={p} size={14} />)}{item.title}
                    </span>
                    {(item.next || item.detail) && <span className="text-xs leading-snug text-muted-foreground">{item.next || item.detail}</span>}
                  </div>
                ))}
              </Card>
            ) : <Empty>Nothing scheduled.</Empty>}
          </section>
        </aside>
      </div>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle>Watching</CardTitle>
          <CardDescription>Checks that wait on a build, a date, or more data.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {watching.map((item) => (
            <details key={item.id} className="group border-t px-6 py-3 first:border-t-0">
              <summary className="flex cursor-pointer list-none items-center gap-3 marker:hidden">
                <ProjectMark projects={item.projects} size={16} />
                <span className="min-w-0 flex-1 truncate text-sm group-open:whitespace-normal">{item.title}</span>
                <span className="hidden text-sm text-muted-foreground md:inline">{KEEPER[item.owner]}</span>
                <span className="w-8 text-end text-sm text-muted-foreground tnum">{age(item.updatedAt)}</span>
              </summary>
              {(item.detail || item.next) && (
                <div className="mt-2 space-y-1 ps-0 text-sm text-muted-foreground md:ps-24">
                  {item.detail && <p>{item.detail}</p>}
                  {item.next && <p><span className="text-foreground">Next:</span> {item.next}</p>}
                </div>
              )}
            </details>
          ))}
          {!watching.length && <p className="px-6 text-sm text-muted-foreground">Nothing watched.</p>}
        </CardContent>
      </Card>
      <p className="pb-4 text-center text-xs text-muted-foreground">Picks stay drafts in this browser until you press Send; one Send delivers them all to the Housekeeper.</p>
    </div>
  )
}
