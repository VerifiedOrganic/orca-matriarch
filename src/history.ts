// A worktree's history: lane segments and point marks, kept in plugin storage and pruned to a
// week. It is what the timeline draws, so it must survive worker restarts.
import type { Lane } from './plan.ts'
import type { Mark, Segment } from './protocol.ts'

export interface TrackHistory {
  v: 1
  segments: Segment[]
  marks: Mark[]
  /** The PR head commit last seen, to mark pushes. */
  lastSha?: string
  /** When the engine last saw this track's workspace; pruning goes by it. */
  seenAt?: number
}

export const historyKey = (trackKey: string): string => `track:${trackKey}`
export const KEEP_MS = 7 * 24 * 3600_000
const MAX_SEGMENTS = 400
const MAX_MARKS = 300

export function emptyHistory(): TrackHistory {
  return { v: 1, segments: [], marks: [] }
}

export function loadHistory(raw: unknown): TrackHistory {
  const r = typeof raw === 'object' && raw !== null ? (raw as Partial<TrackHistory>) : {}
  return {
    v: 1,
    segments: Array.isArray(r.segments) ? r.segments.filter((s) => typeof s?.from === 'number') : [],
    marks: Array.isArray(r.marks) ? r.marks.filter((m) => typeof m?.at === 'number') : [],
    ...(typeof r.lastSha === 'string' ? { lastSha: r.lastSha } : {}),
    ...(typeof r.seenAt === 'number' ? { seenAt: r.seenAt } : {})
  }
}

/** Records that the track is in `lane` now: extends the open segment or starts a new one. */
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
  return { ...h, segments }
}

export function addMark(h: TrackHistory, mark: Mark): TrackHistory {
  return { ...h, marks: [...h.marks, mark] }
}

/** Drops what ended before `now - keepMs` and caps the counts. */
export function prune(h: TrackHistory, now: number, keepMs = KEEP_MS): TrackHistory {
  const cutoff = now - keepMs
  const segments = h.segments.filter((s) => s.to === null || s.to >= cutoff).slice(-MAX_SEGMENTS)
  const marks = h.marks.filter((m) => m.at >= cutoff).slice(-MAX_MARKS)
  if (segments.length === h.segments.length && marks.length === h.marks.length) return h
  return { ...h, segments, marks }
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
