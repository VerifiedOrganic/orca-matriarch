// Pure geometry and grouping for the views: no DOM, so `orca plugin test` covers it in Node.
import type { Lane, Mark, Segment, TrackView } from '../protocol.ts'

export type Group = 'blocked' | 'fixing' | 'review' | 'active' | 'waiting' | 'ready' | 'quiet' | 'done'

/** Groups in the order the board shows them and the strip stacks them (bottom first). */
export const GROUPS: { id: Group; label: string }[] = [
  { id: 'blocked', label: 'Needs you' },
  { id: 'fixing', label: 'Fixing' },
  { id: 'review', label: 'AI review' },
  { id: 'active', label: 'Working' },
  { id: 'waiting', label: 'Awaiting CI' },
  { id: 'ready', label: 'Ready / merging' },
  { id: 'quiet', label: 'Draft / idle' },
  { id: 'done', label: 'Merged / closed' }
]

export const LANES: Record<Lane, { label: string; group: Group }> = {
  'needs-you': { label: 'Needs you', group: 'blocked' },
  'fixing-ci': { label: 'Fixing CI', group: 'fixing' },
  'fixing-conflict': { label: 'Fixing conflicts', group: 'fixing' },
  'fixing-review': { label: 'Fixing review', group: 'fixing' },
  'ai-review': { label: 'AI review', group: 'review' },
  working: { label: 'Working', group: 'active' },
  building: { label: 'Building', group: 'active' },
  'awaiting-ci': { label: 'Awaiting CI', group: 'waiting' },
  ready: { label: 'Ready to merge', group: 'ready' },
  merging: { label: 'Merging', group: 'ready' },
  draft: { label: 'Draft', group: 'quiet' },
  idle: { label: 'Idle', group: 'quiet' },
  merged: { label: 'Merged', group: 'done' },
  closed: { label: 'Closed', group: 'done' }
}

export const groupOf = (lane: Lane): Group => LANES[lane]?.group ?? 'quiet'

export interface Scale {
  from: number
  to: number
  x0: number
  x1: number
  x(t: number): number
}

export function scale(from: number, to: number, x0: number, x1: number): Scale {
  const span = Math.max(1, to - from)
  return { from, to, x0, x1, x: (t) => x0 + ((Math.min(Math.max(t, from), to) - from) / span) * (x1 - x0) }
}

const STEPS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 2 * 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000]

/**
 * Evenly spaced ticks at round local clock times, at most `max` of them. `offsetMinutes` is local
 * time minus UTC (in a browser: `-new Date().getTimezoneOffset()`).
 */
export function ticks(s: Scale, max: number, offsetMinutes = 0): { t: number; x: number; label: string }[] {
  const span = s.to - s.from
  const step = STEPS.find((st) => span / st <= max) ?? STEPS[STEPS.length - 1]
  const offset = offsetMinutes * 60_000
  const first = Math.ceil((s.from + offset) / step) * step - offset
  const out: { t: number; x: number; label: string }[] = []
  for (let t = first; t <= s.to; t += step) {
    const d = new Date(t + offset)
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    out.push({ t, x: s.x(t), label: `${hh}:${mm}` })
  }
  return out
}

export interface Bar {
  x: number
  w: number
  lane: Lane
  group: Group
  from: number
  to: number
  reason: string
}

/** A track's segments as bars inside the scale; open segments run to `now`, at least `minW` wide. */
export function bars(segments: readonly Segment[], s: Scale, now: number, minW = 1): Bar[] {
  const out: Bar[] = []
  for (const seg of segments) {
    const end = seg.to ?? now
    if (end < s.from || seg.from > s.to) continue
    const x = s.x(seg.from)
    const w = Math.max(minW, s.x(end) - x)
    out.push({ x, w, lane: seg.lane, group: groupOf(seg.lane), from: seg.from, to: end, reason: seg.reason })
  }
  return out
}

export function marksIn(marks: readonly Mark[], s: Scale): (Mark & { x: number })[] {
  return marks.filter((m) => m.at >= s.from && m.at <= s.to).map((m) => ({ ...m, x: s.x(m.at) }))
}

/** The lane a track was in at time t, or null before its first segment. */
export function laneAt(segments: readonly Segment[], t: number, now: number): Lane | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.from <= t && (seg.to ?? now) >= t) return seg.lane
  }
  return null
}

export type Counts = Record<Group, number>
const zero = (): Counts => ({ blocked: 0, fixing: 0, review: 0, active: 0, waiting: 0, ready: 0, quiet: 0, done: 0 })

/** How many tracks were in each group at `samples` evenly spaced times: the concurrency strip. */
export function concurrency(tracks: readonly TrackView[], s: Scale, now: number, samples: number): { t: number; counts: Counts }[] {
  const out: { t: number; counts: Counts }[] = []
  const n = Math.max(1, samples)
  for (let i = 0; i < n; i++) {
    const t = s.from + ((i + 0.5) / n) * (s.to - s.from)
    const counts = zero()
    if (t <= now) {
      for (const track of tracks) {
        const lane = laneAt(track.segments, t, now)
        if (lane) counts[groupOf(lane)]++
      }
    }
    out.push({ t, counts })
  }
  return out
}

/**
 * Tracks per board group, keeping the engine's order inside each group. With `all`, empty groups
 * stay too: the board always shows the whole pipeline, so a lane's place never moves.
 */
export function byGroup(tracks: readonly TrackView[], all = false): { group: Group; label: string; tracks: TrackView[] }[] {
  return GROUPS.map((g) => ({ group: g.id, label: g.label, tracks: tracks.filter((t) => groupOf(t.lane) === g.id) })).filter(
    (g) => all || g.tracks.length > 0
  )
}

/** Now-counts for the header chips. */
export function summary(tracks: readonly TrackView[]): Counts {
  const c = zero()
  for (const t of tracks) c[groupOf(t.lane)]++
  return c
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
