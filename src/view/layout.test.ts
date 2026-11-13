import { assert, test } from 'orca/testing'
import type { TrackView } from '../protocol.ts'
import { bars, byGroup, concurrency, laneAt, scale, summary, ticks } from './layout.ts'

const H = 3600_000

function track(key: string, segments: TrackView['segments'], lane: TrackView['lane']): TrackView {
  return {
    key,
    repo: 'acme/app',
    workspace: { id: key, name: key, branch: key },
    pr: null,
    owner: null,
    lane,
    reason: '',
    next: [],
    review: null,
    rounds: { ci: 0, conflicts: 0, comments: 0, reviews: 0 },
    segments,
    marks: []
  }
}

test('bars clip to the window and an open segment runs to now', () => {
  const s = scale(10 * H, 12 * H, 0, 200)
  const b = bars(
    [
      { lane: 'working', from: 9 * H, to: 11 * H, reason: '' },
      { lane: 'fixing-ci', from: 11 * H, to: null, reason: '' }
    ],
    s,
    12 * H
  )
  assert.deepEqual(b.map((x) => [x.lane, x.x, x.w, x.group]), [['working', 0, 100, 'active'], ['fixing-ci', 100, 100, 'fixing']])
})

test('the concurrency strip counts what ran and blocked at the same moment', () => {
  const now = 4 * H
  const tracks = [
    track('a', [{ lane: 'working', from: 0, to: 2 * H, reason: '' }, { lane: 'needs-you', from: 2 * H, to: null, reason: '' }], 'needs-you'),
    track('b', [{ lane: 'building', from: H, to: null, reason: '' }], 'building'),
    track('c', [{ lane: 'ai-review', from: 3 * H, to: null, reason: '' }], 'ai-review')
  ]
  const s = scale(0, now, 0, 400)
  const samples = concurrency(tracks, s, now, 4) // at 0.5h, 1.5h, 2.5h, 3.5h
  assert.deepEqual(samples.map((p) => [p.counts.active, p.counts.blocked, p.counts.review]), [[1, 0, 0], [2, 0, 0], [1, 1, 0], [1, 1, 1]])
  assert.equal(laneAt(tracks[0].segments, 3 * H, now), 'needs-you')
  assert.equal(laneAt(tracks[2].segments, H, now), null)
})

test('ticks fall on round local times', () => {
  const s = scale(10 * H + 7 * 60_000, 16 * H, 0, 600)
  const t = ticks(s, 6, 60) // UTC+1
  assert.ok(t.length > 0 && t.length <= 7)
  assert.deepEqual(t.map((x) => x.label).slice(0, 2), ['12:00', '13:00'])
})

test('board groups keep lane priority and counts', () => {
  const tracks = [track('x', [], 'ready'), track('y', [], 'needs-you'), track('z', [], 'fixing-ci')]
  assert.deepEqual(byGroup(tracks).map((g) => g.group), ['blocked', 'fixing', 'ready'])
  // The board asks for every lane, empty ones included, in the same order.
  assert.deepEqual(byGroup(tracks, true).map((g) => g.group), ['blocked', 'fixing', 'review', 'active', 'waiting', 'ready', 'quiet', 'done'])
  assert.equal(byGroup(tracks, true).find((g) => g.group === 'review')?.tracks.length, 0)
  assert.equal(summary(tracks).blocked, 1)
})
