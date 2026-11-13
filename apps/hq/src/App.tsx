import * as React from "react"
import { BarChart3, Calendar, HeartPulse, Inbox, Megaphone, Wallet } from "lucide-react"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Logo, riyadh } from "@/shared"
import { StatusProvider, useStatus } from "@/api"
import StatusPage, { type Filter } from "@/pages/status"
import AdsPage from "@/pages/ads"
import ProductHealthPage from "@/pages/product-health"
import FinancePage from "@/pages/finance"
import RecapPage from "@/pages/recap"
import PageView from "@/pages/page"

const useRoute = () => {
  const [hash, setHash] = React.useState(location.hash || "#/")
  React.useEffect(() => {
    const on = () => { setHash(location.hash || "#/"); window.scrollTo(0, 0) }
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  return hash
}

const REPORTS = [
  { type: "ads", label: "Ads", icon: Megaphone, page: AdsPage },
  { type: "product-health", label: "Product health", icon: HeartPulse, page: ProductHealthPage },
  { type: "finance", label: "Finance", icon: Wallet, page: FinancePage },
  { type: "recap", label: "Recap", icon: BarChart3, page: RecapPage },
] as const

export default function App() {
  const page = location.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/)?.[1]
  if (page) return <PageShell slug={page} />
  return <StatusProvider><Shell /></StatusProvider>
}

/** A one-off page at /p/<slug>: hq's look without the desk's sidebar, so a shared link opens straight to the content. */
function PageShell({ slug }: { slug: string }) {
  return (
    <TooltipProvider>
      <div className="min-h-svh bg-background">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:px-6">
          <a href="/" className="flex items-center gap-2 text-sm font-medium">
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">H</span>
            Housekeeper
          </a>
        </header>
        <PageView slug={slug} />
      </div>
    </TooltipProvider>
  )
}

function Shell() {
  const route = useRoute()
  const status = useStatus()
  const [filter, setFilter] = React.useState<Filter>("all")
  const [, , type, date] = route.split("/")
  const report = route.startsWith("#/reports/") ? REPORTS.find((r) => r.type === type) : undefined
  const needs = status.data?.items.filter((i) => i.group === "Needs you" && !status.data!.answers[i.id]).length ?? 0
  const title = report?.label ?? "Status"
  const go = (f: Filter) => { setFilter(f); if (location.hash !== "#/") location.hash = "#/" }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <a href="#/">
                    <span className="grid size-8 place-items-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">H</span>
                    <span className="grid leading-tight">
                      <span className="font-semibold">Housekeeper</span>
                      <span className="text-xs text-muted-foreground">Muhammed's desk</span>
                    </span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={title === "Status"}>
                      <a href="#/"><Inbox />Status</a>
                    </SidebarMenuButton>
                    {!!needs && <SidebarMenuBadge>{needs}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild><a href="#/" onClick={() => setTimeout(() => document.getElementById("scheduled")?.scrollIntoView({ behavior: "smooth" }), 50)}><Calendar />Scheduled</a></SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Reports</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {REPORTS.map((r) => (
                    <SidebarMenuItem key={r.type}>
                      <SidebarMenuButton asChild isActive={report?.type === r.type}>
                        <a href={`#/reports/${r.type}`}><r.icon />{r.label}</a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {(["awraq", "harium"] as const).map((p) => (
                    <SidebarMenuItem key={p}>
                      <SidebarMenuButton isActive={!report && filter === p} onClick={() => go(filter === p ? "all" : p)}>
                        <Logo project={p} size={16} />{p === "awraq" ? "Awraq" : "Harium"}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            {status.data && <p className="px-2 text-xs text-muted-foreground">Updated {riyadh(status.data.updatedAt)} Riyadh</p>}
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:rounded-t-xl">
            <SidebarTrigger className="-ms-1" />
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
            <h1 className="text-sm font-medium">{title}</h1>
          </header>
          {report ? <report.page key={route} date={date} /> : <StatusPage filter={filter} setFilter={setFilter} />}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
