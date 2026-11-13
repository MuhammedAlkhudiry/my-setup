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
export function useLive<T>(path: string | null): Loaded<T> {
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

/** Saves one answer at once; an empty choice with no note clears it. Decisions go through drafts and `sendDrafts` instead. */
export async function sendAnswer(id: string, choice: string, note = ""): Promise<Answer | null> {
  const response = await fetch("/api/answers", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, choice, note }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `Could not save (${response.status})`)
  return body.answer ?? null
}

// Picks, notes, Later, Skip, and handled stay drafts in this browser until Muhammed sends them all at once.
export type Draft = { choice: string; note: string }
const DRAFTS_KEY = "hq-drafts"
const listeners = new Set<() => void>()
let drafts: Record<string, Draft> = (() => {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}")
  } catch {
    return {}
  }
})()

function saveDrafts(next: Record<string, Draft>) {
  drafts = next
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    // Drafts still work for this visit without storage.
  }
  listeners.forEach((l) => l())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useDrafts = () => React.useSyncExternalStore(subscribe, () => drafts)

/** Sets or clears one item's draft; a draft with no choice and no note is cleared, locally only. */
export function setDraft(id: string, draft: Draft | null) {
  const { [id]: _, ...rest } = drafts
  saveDrafts(draft && (draft.choice || draft.note.trim()) ? { ...rest, [id]: draft } : rest)
}

/** Posts every draft for the given items, then wakes the Housekeeper once. Drafts that failed stay for another try. */
export async function sendDrafts(ids: string[]): Promise<void> {
  const failed: string[] = []
  for (const id of ids) {
    const draft = drafts[id]
    if (!draft) continue
    try {
      await sendAnswer(id, draft.choice, draft.note.trim())
      setDraft(id, null)
    } catch {
      failed.push(id)
    }
  }
  if (failed.length < ids.length)
    await fetch("/api/notify", { method: "POST", credentials: "same-origin" }).catch(() => undefined)
  if (failed.length) throw new Error(`${failed.length} could not be sent; try again`)
}

/** The draft id of one options block on a page. */
export const pageDraftId = (slug: string, block: string) => `page:${slug}:${block}`

/** Sends every drafted pick on a page at once, so its thread gets them in one message. */
export async function sendPageDrafts(slug: string, blocks: string[]): Promise<void> {
  const picks = Object.fromEntries(
    blocks.flatMap((block) => {
      const draft = drafts[pageDraftId(slug, block)]
      return draft ? [[block, { choice: draft.choice, note: draft.note.trim() }]] : []
    }),
  )
  const response = await fetch(`/api/pages/${slug}/picks`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ picks }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `Could not send (${response.status})`)
  for (const block of Object.keys(picks)) setDraft(pageDraftId(slug, block), null)
}
