// A worktree's history: lane segments and point marks, kept in plugin storage and pruned to a
// week. It is what the timeline draws, so it must survive worker restarts.
import type { Lane } from './plan.ts'
import type { LogEntry, Mark, Segment } from './protocol.ts'

export interface TrackHistory {
  v: 1
  segments: Segment[]
  marks: Mark[]
  /** What Matriarch did on this track and why, oldest first; read by the panel on demand. */
  log: LogEntry[]
  /**
   * The PR this history belongs to. A worktree's history (kept under its id) is the first PR's on
   * that worktree, so one row runs from building to merged; a later PR on the same worktree keeps
   * its own, under `pr:<repo>#<n>`.
   */
  pr?: number
  /** The PR head commit last seen, to mark pushes. */
  lastSha?: string
  /** When the engine last saw this track's workspace; pruning goes by it. */
  seenAt?: number
}

export const historyKey = (trackKey: string): string => `track:${trackKey}`
export const KEEP_MS = 7 * 24 * 3600_000
const MAX_SEGMENTS = 400
const MAX_MARKS = 300
const MAX_LOG = 300

export function emptyHistory(): TrackHistory {
  return { v: 1, segments: [], marks: [], log: [] }
}

export function loadHistory(raw: unknown): TrackHistory {
  const r = typeof raw === 'object' && raw !== null ? (raw as Partial<TrackHistory>) : {}
  return {
    v: 1,
    segments: Array.isArray(r.segments) ? r.segments.filter((s) => typeof s?.from === 'number') : [],
    marks: Array.isArray(r.marks) ? r.marks.filter((m) => typeof m?.at === 'number') : [],
    // Histories saved before the log existed have none.
    log: Array.isArray(r.log) ? r.log.filter((e) => typeof e?.at === 'number' && typeof e?.text === 'string') : [],
    ...(typeof r.lastSha === 'string' ? { lastSha: r.lastSha } : {}),
    ...(typeof r.pr === 'number' ? { pr: r.pr } : {}),
    ...(typeof r.seenAt === 'number' ? { seenAt: r.seenAt } : {})
  }
}

/**
 * Records that the track is in `lane` now: extends the open segment or starts a new one. A new
 * lane goes in the log with its reason; a new reason within the same lane does not, since some
 * reasons change every check (how long an agent has waited, say).
 */
export function noteLane(h: TrackHistory, lane: Lane, reason: string, now: number): TrackHistory {
  const segments = h.segments.slice()
  const last = segments[segments.length - 1]
  if (last && last.to === null && last.lane === lane) {
    if (last.reason === reason) return h
    segments[segments.length - 1] = { ...last, reason }
    return { ...h, segments }
  }
  if (last && last.to === null) segments[segments.length - 1] = { ...last, to: Math.max(now, last.from) }
  segments.push({ lane, from: now, to: null, reason })
  return addLog({ ...h, segments }, { at: now, kind: 'lane', lane, text: reason })
}

export function addMark(h: TrackHistory, mark: Mark): TrackHistory {
  return { ...h, marks: [...h.marks, mark] }
}

/** The same line again, apart from when: what came, to whom, and how it went all match. */
const sameLine = (a: LogEntry, b: LogEntry): boolean =>
  a.kind === b.kind && a.text === b.text && a.lane === b.lane && a.to === b.to && a.subject === b.subject && a.error === b.error

/**
 * Adds a line to the log. The same line again right after itself (an action that fails every
 * check, say) is counted on the line before instead, so a stuck PR does not fill the log.
 */
export function addLog(h: TrackHistory, entry: LogEntry): TrackHistory {
  const last = h.log[h.log.length - 1]
  if (last && sameLine(last, entry)) {
    return { ...h, log: [...h.log.slice(0, -1), { ...last, count: (last.count ?? 1) + (entry.count ?? 1), lastAt: entry.lastAt ?? entry.at }] }
  }
  return { ...h, log: [...h.log, entry] }
}

/** Drops what ended before `now - keepMs` and caps the counts. */
export function prune(h: TrackHistory, now: number, keepMs = KEEP_MS): TrackHistory {
  const cutoff = now - keepMs
  const segments = h.segments.filter((s) => s.to === null || s.to >= cutoff).slice(-MAX_SEGMENTS)
  const marks = h.marks.filter((m) => m.at >= cutoff).slice(-MAX_MARKS)
  const log = h.log.filter((e) => (e.lastAt ?? e.at) >= cutoff).slice(-MAX_LOG)
  if (segments.length === h.segments.length && marks.length === h.marks.length && log.length === h.log.length) return h
  return { ...h, segments, marks, log }
}

/** The part of the history that overlaps `[since, ∞)`, segments clipped to start at `since`. */
export function windowed(h: TrackHistory, since: number): { segments: Segment[]; marks: Mark[] } {
  return {
    segments: h.segments
      .filter((s) => s.to === null || s.to > since)
      .map((s) => (s.from < since ? { ...s, from: since } : s)),
    marks: h.marks.filter((m) => m.at >= since)
  }
}
