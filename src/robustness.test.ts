// Scenarios from the independent review: each was a way to lose work, act twice, act when it
// should not, or stop when it should act. Driven through the whole engine tick.
import { assert, describe, test } from 'orca/testing'
import type { ReviewerSpec } from './config.ts'
import { validateConfig } from './config.ts'
import { createCrew } from './crew.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Executor, Outcome } from './executor.ts'
import { normalizePr, type GitHub, type PrSnapshot } from './github.ts'
import { collectGarbage, RETAIN_MS } from './gc.ts'
import { ledgerKey } from './ledger.ts'
import type { Action } from './plan.ts'
import { check, config, pr, SHA } from './testing/fixtures.ts'

const WS: Workspace = { id: 'ws1', kind: 'worktree', name: 'login', path: '/r/wt', branch: 'refs/heads/feature/login', hostId: 'local' }

function engine(prs: PrSnapshot[], over: Partial<EngineDeps> & { cfg?: unknown; execute?: (a: Action) => Promise<Outcome> | Outcome } = {}) {
  const store = new Map<string, unknown>()
  const executed: Action[] = []
  const github: GitHub = {
    listOpen: async () => ({
      viewer: 'me',
      rate: null,
      prs: prs.filter((p) => p.state === 'OPEN').map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: 'me', updatedAt: p.updatedAt, rollup: p.ci }))
    }),
    detail: async (_r, n) => ({ pr: prs.find((p) => p.number === n) ?? null, rate: null })
  }
  const executor: Executor = {
    async execute(a) {
      executed.push(a)
      return over.execute ? await over.execute(a) : { ok: true }
    }
  }
  const deps: EngineDeps = {
    now: () => 10 * RETAIN_MS,
    log: () => {},
    workspaces: async () => [WS],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig(over.cfg ?? { review: { enabled: false } }),
    github,
    workers: async () => [{ dispatchId: 'd1', worktreeId: 'ws1', taskId: 't', runId: 'r1', agent: 'codex', model: null, state: null }],
    activity: () => null,
    supervisor: async () => null,
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor,
    ...over
  }
  return { deps, store, executed }
}

const failing = pr({ ci: 'failing', checks: [check('test', 'failure')] })

describe('acting safely', () => {
  test('a config with errors is watched only, even with autopilot on', async () => {
    const e = engine([failing], { cfg: { review: { enabled: false }, merge: { requireHuman: ['migrations/**', ''] } } })
    const board = await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed, [])
    assert.ok(board.repos[0].errors.some((x) => x.includes('only watches')))
  })

  test('pausing stops the next action at once', async () => {
    const e = engine([failing])
    await tick(e.deps, { autopilot: true, stillOn: async () => false })
    assert.deepEqual(e.executed, [])
  })

  test('without the worker list nothing is sent and nothing is escalated as orphaned', async () => {
    const e = engine([failing], { workers: async () => { throw new Error('runtime_unavailable') } })
    const board = await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed, [])
    assert.ok(board.errors.some((x) => x.includes("Can't see Orca's workers")))
  })
})

describe('not losing work', () => {
  test('a failing action does not undo one that already succeeded, nor abort the tick', async () => {
    // Manual mode, a passed review: publish (ok) then notify (throws).
    const ready = pr({})
    const e = engine([ready], {
      cfg: { review: { publish: 'github' } },
      execute: (a) => {
        if (a.kind === 'notify') throw new Error('notifications unavailable')
        return { ok: true }
      }
    })
    e.store.set(ledgerKey('acme/app', 12), { reviews: { [SHA]: { round: 1, status: 'done', startedAt: 1, verdict: 'pass' } }, heads: { [SHA]: 0 } })
    const board = await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed.map((a) => a.kind), ['publish-review', 'notify'])
    const ledger = e.store.get(ledgerKey('acme/app', 12)) as { reviews: Record<string, { published?: boolean }> }
    assert.equal(ledger.reviews[SHA].published, true, 'the post is recorded, so it is not repeated')
    assert.ok(board.repos[0].errors.some((x) => x.includes('notify')))
    await tick(e.deps, { autopilot: true })
    assert.equal(e.executed.filter((a) => a.kind === 'publish-review').length, 1)
  })

  test('an unreachable supervisor sends the escalation to you instead, and its stale link is dropped', async () => {
    const e = engine([pr({ ci: 'failing', checks: [check('test', 'failure')] })], {
      workers: async () => [],
      supervisor: async () => 'run:gone',
      execute: (a) => (a.kind === 'escalate' && a.to === 'supervisor' ? { ok: false, error: 'run_not_found: no such run' } : { ok: true })
    })
    await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed.map((a) => (a.kind === 'escalate' ? `escalate:${a.to}` : a.kind)), ['escalate:supervisor', 'escalate:human'])
    assert.equal(e.store.get('supervisor:acme/app'), '')
  })
})

describe('merge train', () => {
  test('a stale merge request for an old commit does not hold the base', async () => {
    const auto = { review: { enabled: false }, merge: { mode: 'auto' } }
    const a = pr({ number: 12 })
    const b = pr({ number: 13, headRef: 'feature/b', headSha: 'b'.repeat(40) })
    const e = engine([a, b], { cfg: auto, workspaces: async () => [WS, { ...WS, id: 'ws2', branch: 'refs/heads/feature/b', path: '/r/wt2' }] })
    e.store.set(ledgerKey('acme/app', 12), { merge: { sha: 'old'.padEnd(40, '0'), at: 1, status: 'requested' }, heads: { [SHA]: 0 } })
    e.store.set(ledgerKey('acme/app', 13), { heads: { ['b'.repeat(40)]: 0 } })
    await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed.filter((x) => x.kind === 'merge').length, 1)
  })

  test('a red base is escalated once per repository, not once per ready PR', async () => {
    const auto = { review: { enabled: false }, merge: { mode: 'auto' } }
    const a = pr({ number: 12 })
    const b = pr({ number: 13, headRef: 'feature/b', headSha: 'b'.repeat(40) })
    const e = engine([a, b], {
      cfg: auto,
      supervisor: async () => 'run:r1',
      workspaces: async () => [WS, { ...WS, id: 'ws2', branch: 'refs/heads/feature/b', path: '/r/wt2' }],
      github: {
        listOpen: async () => ({ viewer: 'me', rate: null, base: { name: 'main', sha: 'base1', rollup: 'FAILURE' }, prs: [a, b].map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: 'me', updatedAt: p.updatedAt, rollup: 'SUCCESS' })) }),
        detail: async (_r, n) => ({ pr: [a, b].find((p) => p.number === n) ?? null, rate: null })
      }
    })
    e.store.set(ledgerKey('acme/app', 12), { heads: { [SHA]: 0 } })
    e.store.set(ledgerKey('acme/app', 13), { heads: { ['b'.repeat(40)]: 0 } })
    await tick(e.deps, { autopilot: true })
    assert.equal(e.executed.filter((x) => x.kind === 'escalate').length, 1)
    assert.equal(e.executed.filter((x) => x.kind === 'merge').length, 0)
  })
})

describe('outages', () => {
  test('when GitHub cannot list PRs, worktrees keep their last lane and their history is left alone', async () => {
    const e = engine([failing])
    await tick(e.deps, { autopilot: false })
    const before = JSON.stringify(e.store.get('track:ws1'))
    e.deps.github = { listOpen: async () => { throw new Error('API rate limit exceeded') }, detail: async () => ({ pr: null, rate: null }) }
    const board = await tick(e.deps, { autopilot: false })
    assert.equal(board.tracks[0].lane, 'fixing-ci')
    assert.match(board.tracks[0].reason, /last known/)
    assert.equal(JSON.stringify(e.store.get('track:ws1')), before)
  })

  test('a check list cut short trusts GitHub\'s rollup over the first 100 checks', () => {
    const raw = {
      number: 1, headRefOid: SHA, state: 'OPEN',
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { pageInfo: { hasNextPage: true }, nodes: [{ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] }
    }
    const snap = normalizePr(raw, 'acme/app', 0)!
    assert.equal(snap.ci, 'failing')
    assert.equal(snap.checksTruncated, true)
  })
})

describe('the crew', () => {
  const R = (name: string, agent: string, blocking = true): ReviewerSpec => ({ name, agent, blocking })
  function crewFor(files: Record<string, string>) {
    const calls: string[][] = []
    let now = 0
    const store = new Map<string, unknown>()
    const crew = createCrew({
      orca: { run: async (args) => (calls.push([...args]), args[1] === 'create' ? { worktree: { path: `/wt/r${calls.length}` } } : {}) },
      exec: async (_f, args) => ({ code: 0, stdout: args.includes('rev-parse') ? `${SHA}\n` : '', stderr: '' }),
      readFile: async (p) => files[p.replace(/^\/wt\/r\d+\//, '')] ?? null,
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      now: () => now,
      log: () => {},
      workspaceIdFor: async () => null
    })
    return { crew, calls, store, advance: (ms: number) => (now += ms) }
  }

  test('a vote needs a quorum: one approval out of three reviewers is not a pass', async () => {
    const files: Record<string, string> = {}
    const h = crewFor(files)
    const c = config((x) => (x.review.pass = 'majority'))
    await h.crew.start({ pr: pr(), root: '/r', config: c, round: 1, reviewers: [R('a', 'claude'), R('b', 'codex'), R('c', 'grok')] })
    files[`.matriarch/review/${SHA.slice(0, 12)}/a.json`] = '{"verdict":"approve","summary":"","findings":[]}'
    h.advance(31 * 60_000)
    const [run] = await h.crew.poll()
    assert.equal(run.status, 'failed')
    assert.match(run.error ?? '', /too few/)
  })

  test('re-running a failed round removes the worktree it left, and uses a new name', async () => {
    const h = crewFor({})
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('a', 'claude')] })
    h.advance(31 * 60_000)
    await h.crew.poll() // fails, keeps its worktree
    h.advance(1000)
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('a', 'claude')] })
    const names = h.calls.filter((c) => c[1] === 'create').map((c) => c[c.indexOf('--name') + 1])
    assert.equal(names.length, 2)
    assert.notEqual(names[0], names[1])
    assert.ok(h.calls.some((c) => c[1] === 'rm' && c.includes('path:/wt/r1')), 'the earlier worktree is removed first')
  })

  test('pruning never drops a round whose worktree still exists', async () => {
    const m = new Map<string, unknown>([
      ['closed:a/b#1', 0],
      ['crew:a/b#1:s1', { status: 'failed', worktree: { path: '/wt/x' }, cleaned: false }],
      ['crew:a/b#1:s2', { status: 'done', worktree: { path: '/wt/y' }, cleaned: true }]
    ])
    const s = { keys: async () => [...m.keys()], get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: never) => void m.set(k, v), delete: async (k: string) => void m.delete(k) }
    await collectGarbage(s, { now: 2 * RETAIN_MS, openPrs: new Set(), liveWorkspaces: new Set() })
    assert.ok(m.has('crew:a/b#1:s1'), 'kept: the sweep still has to remove its worktree')
    assert.ok(!m.has('crew:a/b#1:s2'))
  })
})
