// Storage housekeeping. Matriarch keeps per-PR and per-worktree records; without pruning they
// would outlive the PRs and worktrees they describe. Runs at most hourly from the tick.

export const RETAIN_MS = 7 * 24 * 3600_000
export const GC_EVERY_MS = 3600_000
const LAST = 'gc:last'

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

  // A PR's records go a week after Matriarch saw it merged or closed.
  for (const key of keys) {
    if (!key.startsWith('closed:')) continue
    const pr = key.slice('closed:'.length)
    const at = await store.get(key)
    if (input.openPrs.has(pr)) {
      doomed.add(key) // reopened: it is live again
      continue
    }
    if (typeof at !== 'number' || input.now - at < RETAIN_MS) continue
    for (const k of keys) {
      if (k.startsWith(`crew:${pr}:`)) {
        // Never drop a round whose worktree still exists: the sweep must still remove it.
        const run = (await store.get(k)) as { status?: string; worktree?: unknown; cleaned?: boolean } | null
        if (run && (run.status === 'running' || (run.worktree && !run.cleaned))) continue
        doomed.add(k)
      } else if (k === key || k === `pr:${pr}` || k === `snap:${pr}` || k === `crew:last:${pr}`) {
        doomed.add(k)
      }
    }
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
