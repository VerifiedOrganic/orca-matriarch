// The fixes from the second review pass: pruning, restarts, serial writes, config warnings.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { collectGarbage, GC_EVERY_MS, RETAIN_MS } from './gc.ts'
import { ActivityTracker, ACTIVITY_TRUST_MS, serial } from './worker.ts'

function memoryStore(entries: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(entries))
  return {
    m,
    keys: async () => [...m.keys()],
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: never) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k)
  }
}

describe('storage pruning', () => {
  const now = 100 * RETAIN_MS
  test('drops a PR a week after it closed, keeps open ones and fresh ones', async () => {
    const s = memoryStore({
      'closed:a/b#1': now - RETAIN_MS - 1,
      'pr:a/b#1': {}, 'snap:a/b#1': {}, 'crew:a/b#1:sha1': {}, 'crew:last:a/b#1': 'x',
      'closed:a/b#2': now - 1000, 'pr:a/b#2': {},
      'pr:a/b#3': {}, 'snap:a/b#3': {}
    })
    const removed = await collectGarbage(s, { now, openPrs: new Set(['a/b#3']), liveWorkspaces: new Set() })
    assert.equal(removed, 5)
    assert.deepEqual([...s.m.keys()].sort(), ['closed:a/b#2', 'gc:last', 'pr:a/b#2', 'pr:a/b#3', 'snap:a/b#3'])
  })

  test('drops a worktree history a week after the worktree was last seen, and runs at most hourly', async () => {
    const s = memoryStore({
      'track:gone': { seenAt: now - RETAIN_MS - 1, segments: [] },
      'track:recent': { seenAt: now - 1000, segments: [] },
      'track:live': { seenAt: 0, segments: [] }
    })
    assert.equal(await collectGarbage(s, { now, openPrs: new Set(), liveWorkspaces: new Set(['live']) }), 1)
    assert.ok(!s.m.has('track:gone') && s.m.has('track:recent') && s.m.has('track:live'))
    s.m.set('track:recent', { seenAt: 0, segments: [] })
    assert.equal(await collectGarbage(s, { now: now + GC_EVERY_MS - 1, openPrs: new Set(), liveWorkspaces: new Set() }), 0, 'throttled')
  })
})

describe('restarts', () => {
  test('agent activity comes back after a restart unless it is too old to trust', () => {
    const before = new ActivityTracker()
    before.note('p1', 'ws1', 'working', 1_000)
    before.note('p2', 'ws2', 'waiting', 1_000)
    const saved = before.serialize()
    const after = new ActivityTracker()
    after.note('p2', 'ws2', 'done', 5_000) // heard after the restart: wins
    after.restore(saved, 2_000)
    assert.equal(after.forWorkspace('ws1', 2_000)?.activity, 'working')
    assert.equal(after.forWorkspace('ws2', 2_000)?.activity, 'done')
    // A restored "working" whose "done" was lost during the restart stops counting later on.
    assert.equal(after.forWorkspace('ws1', 1_000 + ACTIVITY_TRUST_MS + 1), null)
    const late = new ActivityTracker()
    late.restore(saved, 1_000 + ACTIVITY_TRUST_MS + 1)
    assert.equal(late.forWorkspace('ws1'), null, 'too old: not trusted')
  })
})

test('storage writers take turns, in order, and one failure does not block the next', async () => {
  const run = serial()
  const order: string[] = []
  const slow = run(async () => {
    await new Promise((r) => setTimeout(r, 20))
    order.push('tick')
  })
  const failing = run(async () => {
    order.push('panel')
    throw new Error('boom')
  })
  const after = run(async () => void order.push('next tick'))
  await Promise.allSettled([slow, failing, after])
  assert.deepEqual(order, ['tick', 'panel', 'next tick'])
})

test('options that are not built yet warn instead of silently doing nothing', () => {
  const r = validateConfig({ arbiter: { agent: 'claude' }, merge: { onBaseRed: 'revert' } })
  assert.ok(r.warnings.some((w) => w.startsWith('arbiter: not used yet')))
  assert.ok(r.warnings.some((w) => w.startsWith('merge.onBaseRed')))
  assert.deepEqual(validateConfig({}).warnings, [])
})
