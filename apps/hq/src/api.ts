import * as React from "react"
import type { Answer, Report, ReportType, Status } from "@contract"

export type StatusData = Status & { answers: Record<string, Answer> }
export type Loaded<T> = { data?: T; error?: string; loading: boolean; reload: () => void }

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" })
  if (response.status === 401) throw new Error("Signed out. Reload the page to sign in again.")
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`)
  return response.json()
}

/** Fetches a path, refreshes it when the tab comes back into view and every minute while it is visible. */
function useLive<T>(path: string | null): Loaded<T> {
  const [state, setState] = React.useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [tick, setTick] = React.useState(0)
  const reload = React.useCallback(() => setTick((t) => t + 1), [])

  React.useEffect(() => {
    if (!path) return
    let live = true
    setState((s) => ({ ...s, loading: true }))
    getJson<T>(path).then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState((s) => ({ ...s, error: error.message, loading: false })),
    )
    return () => { live = false }
  }, [path, tick])

  React.useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && reload()
    const timer = setInterval(() => document.visibilityState === "visible" && reload(), 60_000)
    document.addEventListener("visibilitychange", onVisible)
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible) }
  }, [reload])

  return { ...state, reload }
}

const StatusContext = React.createContext<Loaded<StatusData> | null>(null)
export const StatusProvider = ({ children }: { children: React.ReactNode }) =>
  React.createElement(StatusContext.Provider, { value: useLive<StatusData>("/api/status") }, children)
export const useStatus = () => React.useContext(StatusContext)!

export const useReport = <R extends Report>(type: ReportType, date = "latest") =>
  useLive<{ report: R; dates: string[] }>(`/api/reports/${type}/${date}`)

// ---- picks ------------------------------------------------------------------------------------------------------------

// Picks save at once; the Housekeeper is woken once the owner stops picking for a moment, or when the page closes.
const NOTIFY_AFTER_MS = 15_000
let notifyTimer: ReturnType<typeof setTimeout> | undefined
let notifyDue = false

function notifySoon() {
  notifyDue = true
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(flushNotify, NOTIFY_AFTER_MS)
}

function flushNotify(beacon = false) {
  if (!notifyDue) return
  notifyDue = false
  clearTimeout(notifyTimer)
  if (beacon && navigator.sendBeacon("/api/notify")) return
  fetch("/api/notify", { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => { notifyDue = true })
}

addEventListener("pagehide", () => flushNotify(true))
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushNotify(true))

export async function sendAnswer(id: string, choice: string, note = ""): Promise<Answer | null> {
  const response = await fetch("/api/answers", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, choice, note }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `Could not save (${response.status})`)
  if (choice || note) notifySoon()
  return body.answer ?? null
}
