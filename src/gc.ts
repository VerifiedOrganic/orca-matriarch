// Storage housekeeping. Matriarch keeps per-PR and per-worktree records; without pruning they
// would outlive the PRs and worktrees they describe. Runs at most hourly from the tick.

export const RETAIN_MS = 7 * 24 * 3600_000
export const GC_EVERY_MS = 3600_000
const LAST = 'gc:last'
/** A PR's own records, by key prefix: they all go with it. */
const PR_RECORDS = ['closed:', 'dropped:', 'pr:', 'snap:', 'moves:', 'ci-logs:', 'crew:last:']

export interface GcStore {
  keys(): Promise<string[]>
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<void>
  delete(key: string): Promise<void>
}

export interface GcInput {
  now: number
  /** `owner/name#n` of PRs that are open and managed right now. */
  openPrs: ReadonlySet<string>
  /** Ids of workspaces Orca lists right now. */
  liveWorkspaces: ReadonlySet<string>
}

/** Deletes records older than the retention window; answers how many keys it removed. */
export async function collectGarbage(store: GcStore, input: GcInput): Promise<number> {
  const last = await store.get(LAST)
  if (typeof last === 'number' && input.now - last < GC_EVERY_MS) return 0
  await store.set(LAST, input.now as never)

  const keys = await store.keys()
  const doomed = new Set<string>()

  /** Every record of one PR (`owner/name#n`), but a review round whose worktree the sweep must still remove. */
  const dropPr = async (pr: string): Promise<void> => {
    for (const k of keys) {
      if (k.startsWith(`crew:${pr}:`)) {
        const run = (await store.get(k)) as { status?: string; worktree?: unknown; cleaned?: boolean } | null
        if (run && (run.status === 'running' || (run.worktree && !run.cleaned))) continue
        doomed.add(k)
      } else if (PR_RECORDS.some((prefix) => k === `${prefix}${pr}`)) {
        doomed.add(k)
      }
    }
  }

  // A PR's records go a week after Matriarch saw it merged or closed, or stopped following it while
  // it was open (its worktree gone, say: `dropped:`). One that is followed again keeps them.
  for (const key of keys) {
    const mark = key.startsWith('closed:') ? 'closed:' : key.startsWith('dropped:') ? 'dropped:' : null
    if (!mark) continue
    const pr = key.slice(mark.length)
    const at = await store.get(key)
    if (input.openPrs.has(pr)) {
      doomed.add(key) // open and followed again: it is live
      continue
    }
    if (typeof at !== 'number' || input.now - at < RETAIN_MS) continue
    await dropPr(pr)
    doomed.add(key)
  }

  // A labeled issue's handoff record goes a week after the issue left the open list (closed, or
  // its label removed); with no list to say (issues turned off), a week after it was handed over
  // once it is not among the issues last read.
  for (const key of keys) {
    if (!key.startsWith('issue:')) continue
    const cut = key.lastIndexOf('#')
    const repo = key.slice('issue:'.length, cut)
    const number = Number(key.slice(cut + 1))
    const list = (await store.get(`issues:${repo}`)) as { open?: unknown; left?: Record<string, unknown> } | null
    const open = Array.isArray(list?.open) && list.open.includes(number)
    if (open) continue
    const left = list?.left?.[String(number)]
    const handed = (await store.get(key)) as { at?: unknown } | null
    const since = typeof left === 'number' ? left : typeof handed?.at === 'number' ? handed.at : 0
    if (input.now - since >= RETAIN_MS) doomed.add(key)
  }

  // A worktree's history goes a week after it was last seen.
  for (const key of keys) {
    if (!key.startsWith('track:')) continue
    const id = key.slice('track:'.length)
    if (input.liveWorkspaces.has(id)) continue
    const h = (await store.get(key)) as { seenAt?: number; segments?: { from: number; to: number | null }[] } | null
    const lastSeen = h?.seenAt ?? Math.max(0, ...(h?.segments ?? []).map((s) => s.to ?? s.from))
    if (input.now - lastSeen >= RETAIN_MS) doomed.add(key)
  }

  for (const key of doomed) await store.delete(key)
  return doomed.size
}
