import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Executor } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { ledgerKey } from './ledger.ts'
import type { Action } from './plan.ts'
import { check, pr, SHA } from './testing/fixtures.ts'

const T0 = 1_800_000_000_000

function harness(prs: PrSnapshot[], opts: { optedIn?: boolean; workspaces?: Workspace[]; working?: string[] } = {}) {
  const store = new Map<string, unknown>()
  const executed: Action[] = []
  let now = T0
  const github: GitHub = {
    async listOpen() {
      return {
        viewer: 'me',
        rate: { cost: 1, remaining: 4900, resetAt: 'later' },
        prs: prs.filter((p) => p.state === 'OPEN').map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: p.author, updatedAt: p.updatedAt, rollup: p.ci }))
      }
    },
    async detail(_repo, number) {
      const p = prs.find((x) => x.number === number)
      return { pr: p ? { ...p, fetchedAt: now } : null, rate: null }
    }
  }
  const executor: Executor = {
    async execute(action) {
      executed.push(action)
      return { ok: true }
    }
  }
  const workspaces: Workspace[] = opts.workspaces ?? [
    { id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null },
    { id: 'ws-search', kind: 'worktree', name: 'search', path: '/r/wt/search', branch: 'feature/search', hostId: null },
    { id: 'ws-remote', kind: 'worktree', name: 'remote', path: '/x', branch: 'feature/remote', hostId: 'ssh:box' }
  ]
  const deps: EngineDeps = {
    now: () => now,
    log: () => {},
    workspaces: async () => workspaces,
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => (opts.optedIn === false ? null : validateConfig({ review: { enabled: false } })),
    github,
    workers: async () => [{ dispatchId: 'd-login', worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: 'codex', model: 'gpt-6-astra', state: 'idle' }],
    activity: (id) => (opts.working?.includes(id) ? { activity: 'working', since: T0 - 60_000, agent: 'claude' } : null),
    supervisor: async () => 'run:r1',
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor
  }
  return { deps, store, executed, advance: (ms: number) => (now += ms) }
}

describe('engine tick', () => {
  const failing = pr({ number: 12, ci: 'failing', checks: [check('test', 'failure')] })

  test('dry run plans and shows the next step but sends nothing', async () => {
    const h = harness([failing], { working: ['ws-search'] })
    const board = await tick(h.deps, { autopilot: false })
    assert.deepEqual(h.executed, [])
    const login = board.tracks.find((t) => t.key === 'ws-login')!
    assert.equal(login.lane, 'fixing-ci')
    assert.equal(login.owner?.supervised, true)
    assert.match(login.next[0], /failing check/)
    const search = board.tracks.find((t) => t.key === 'ws-search')!
    assert.equal(search.lane, 'building')
    assert.equal(search.pr, null)
    assert.ok(!board.tracks.some((t) => t.key === 'ws-remote'), 'remote workspaces are skipped')
    assert.equal(board.rate?.remaining, 4900)
  })

  test('autopilot acts once, records it, and the timeline shows the mark', async () => {
    const h = harness([failing])
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['send-ci-failure'])
    assert.ok((h.store.get(ledgerKey('acme/app', 12)) as { ci: Record<string, unknown> }).ci[SHA])
    h.advance(45_000)
    const board = await tick(h.deps, { autopilot: true })
    assert.equal(h.executed.length, 1, 'nothing is sent twice for the same commit')
    const login = board.tracks.find((t) => t.key === 'ws-login')!
    assert.deepEqual(login.marks.map((m) => m.kind), ['ci-sent'])
    assert.equal(login.segments.length, 1)
  })

  test('matches PRs to worktrees whose branch Orca reports as a full ref', async () => {
    const h = harness([failing], {
      workspaces: [{ id: 'repo1::/r/wt/login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'refs/heads/feature/login', hostId: 'local' }]
    })
    const board = await tick(h.deps, { autopilot: false })
    const login = board.tracks.find((t) => t.key === 'repo1::/r/wt/login')!
    assert.equal(login.pr?.number, 12)
    assert.equal(login.workspace.branch, 'feature/login')
  })

  test('a repository without .orca/matriarch.json is left alone', async () => {
    const h = harness([failing], { optedIn: false })
    const board = await tick(h.deps, { autopilot: true })
    assert.deepEqual(board.repos, [])
    assert.deepEqual(board.tracks, [])
    assert.deepEqual(h.executed, [])
  })

  test('a followed PR that was merged shows as merged, with a push mark on new commits', async () => {
    const open = pr({ number: 12 })
    const h = harness([open])
    await tick(h.deps, { autopilot: false })
    h.advance(60_000)
    const merged = pr({ number: 12, state: 'MERGED', headSha: 'b'.repeat(40) })
    const h2 = { ...h.deps, github: { ...h.deps.github, listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: merged, rate: null }) } }
    const board = await tick(h2, { autopilot: false })
    const login = board.tracks.find((t) => t.key === 'ws-login')!
    assert.equal(login.lane, 'merged')
    assert.ok(login.marks.some((m) => m.kind === 'push'))
  })
})

test('a board with a review in progress is plain JSON after the worker strips undefined', async () => {
  const running = pr({ number: 12 })
  const h = harness([running])
  h.store.set(ledgerKey('acme/app', 12), { reviews: { [SHA]: { round: 1, status: 'running', startedAt: 1 } } })
  const board = await tick(h.deps, { autopilot: false })
  const clean = JSON.parse(JSON.stringify(board))
  const hasUndefined = (v: unknown): boolean =>
    v === undefined || (typeof v === 'object' && v !== null && Object.values(v).some(hasUndefined))
  assert.equal(hasUndefined(clean), false)
  assert.equal(clean.tracks.find((t: { key: string }) => t.key === 'ws-login').review.status, 'running')
})

describe('reading a PR again only when something it depends on moved', () => {
  function counting(rollup: string, state: { checksTag: string; baseSha: string }) {
    let details = 0
    const p = pr({ number: 12 })
    const github: GitHub = {
      listOpen: async () => ({
        viewer: 'me',
        rate: null,
        base: { name: 'main', sha: state.baseSha, rollup: 'SUCCESS' },
        prs: [{ number: 12, headRef: p.headRef, headSha: p.headSha, baseRef: 'main', author: 'me', updatedAt: p.updatedAt, rollup, checksTag: state.checksTag }]
      }),
      detail: async () => (details++, { pr: { ...p, fetchedAt: T0 }, rate: null })
    }
    const h = harness([p])
    h.deps.github = github
    return { h, details: () => details }
  }

  test('the base branch moving re-reads it (its mergeability may have changed)', async () => {
    const state = { checksTag: 'c1', baseSha: 'base1' }
    const { h, details } = counting('SUCCESS', state)
    await tick(h.deps, { autopilot: false })
    await tick(h.deps, { autopilot: false })
    assert.equal(details(), 1)
    state.baseSha = 'base2'
    await tick(h.deps, { autopilot: false })
    assert.equal(details(), 2)
  })

  test('check changes re-read it while CI is failing, not while it is still running', async () => {
    const pending = { checksTag: 'c1', baseSha: 'base1' }
    const p = counting('PENDING', pending)
    await tick(p.h.deps, { autopilot: false })
    pending.checksTag = 'c2'
    await tick(p.h.deps, { autopilot: false })
    assert.equal(p.details(), 1, 'a running CI only matters once its rollup changes')

    const failing = { checksTag: 'c1', baseSha: 'base1' }
    const f = counting('FAILURE', failing)
    await tick(f.h.deps, { autopilot: false })
    failing.checksTag = 'c2'
    await tick(f.h.deps, { autopilot: false })
    assert.equal(f.details(), 2, 'with CI failing, the planner waits for the remaining checks')
  })
})

describe('projects on the board', () => {
  test("a project's own checkout is not a row of work while nothing happens there", async () => {
    const main: Workspace = { id: 'ws-main', kind: 'worktree', name: 'app', path: '/r', branch: 'main', hostId: null }
    const login: Workspace = { id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }
    const idle = harness([], { workspaces: [main, login] })
    assert.deepEqual((await tick(idle.deps, { autopilot: false })).tracks.map((t) => t.key), ['ws-login'])
    const busy = harness([], { workspaces: [main, login], working: ['ws-main'] })
    assert.deepEqual((await tick(busy.deps, { autopilot: false })).tracks.map((t) => t.key).sort(), ['ws-login', 'ws-main'])
  })

  test('a project with no commits on GitHub says so, and cannot start a supervisor', async () => {
    const h = harness([])
    h.deps.github = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null, base: null }), detail: async () => ({ pr: null, rate: null }) }
    const board = await tick(h.deps, { autopilot: false })
    assert.equal(board.repos[0].empty, true)
    assert.match(board.repos[0].errors[0], /no commits/)
  })
})

describe('the worker that owns a worktree', () => {
  test('is its live worker, even when a failed attempt is listed first', async () => {
    const p = pr({ number: 12 })
    const h = harness([p])
    h.deps.workers = async () => [
      { dispatchId: 'd-failed', worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: null, model: null, state: 'failed', live: false },
      { dispatchId: 'd-live', worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: 'opencode', model: 'deepinfra/x', state: 'ready', live: true }
    ]
    const board = await tick(h.deps, { autopilot: false })
    const t = board.tracks.find((x) => x.workspace.id === 'ws-login')!
    assert.deepEqual([t.owner?.agent, t.owner?.model, t.owner?.supervised], ['opencode', 'deepinfra/x', true])
  })

  test("is found by its worktree's path when Orca names the workspace by identity", async () => {
    const h = harness([], { workspaces: [{ id: 'identity:wt2:local:abc', kind: 'worktree', name: 'p0', path: '/r/wt/p0', branch: 'p0', hostId: 'local' }] })
    h.deps.workers = async () => [{ dispatchId: 'd1', worktreeId: 'repo1::/r/wt/p0', taskId: 't1', runId: 'r1', agent: 'opencode', model: 'deepinfra/x', state: 'ready', live: true }]
    const board = await tick(h.deps, { autopilot: false })
    assert.equal(board.tracks[0].owner?.agent, 'opencode')
  })
})

describe('what counts as needing you before a PR', () => {
  const lanes = async (activity: 'waiting' | 'blocked', sinceAgo: number, supervised: boolean) => {
    const h = harness([], { workspaces: [{ id: 'ws-x', kind: 'worktree', name: 'x', path: '/r/wt/x', branch: 'x', hostId: null }] })
    h.deps.activity = () => ({ activity, since: T0 - sinceAgo, agent: 'opencode' })
    h.deps.workers = async () => (supervised ? [{ dispatchId: 'd1', worktreeId: 'repo1::/r/wt/x', taskId: 't', runId: 'r', agent: 'opencode', model: null, state: 'ready' }] : [])
    return (await tick(h.deps, { autopilot: false })).tracks[0].lane
  }
  test('a supervised worker waiting between turns is the supervisor\'s to answer', async () => {
    assert.equal(await lanes('waiting', 60_000, true), 'idle')
    assert.equal(await lanes('waiting', 60_000, false), 'needs-you')
  })
  test('a prompt needs you only once nobody answered it for a while', async () => {
    assert.equal(await lanes('blocked', 30_000, true), 'building')
    assert.equal(await lanes('blocked', 10 * 60_000, true), 'needs-you')
  })
})

describe('review rounds whose findings nobody received', () => {
  test('do not use up a round once the PR moved on', async () => {
    const p = pr({ number: 12, headSha: 'b'.repeat(40) })
    const h = harness([p])
    h.store.set(ledgerKey('acme/app', 12), {
      v: 1, ci: {}, conflicts: {}, comments: {}, updates: {}, escalations: {}, notified: {}, merge: null, heads: {},
      reviews: {
        ['a'.repeat(40)]: { round: 1, status: 'done', startedAt: 1, endedAt: 2, verdict: 'changes', findings: 1 },
        ['c'.repeat(40)]: { round: 2, status: 'done', startedAt: 3, endedAt: 4, verdict: 'changes', findings: 1, delivered: true }
      }
    })
    await tick(h.deps, { autopilot: false })
    const l = h.store.get(ledgerKey('acme/app', 12)) as { reviews: Record<string, { superseded?: boolean }> }
    assert.equal(l.reviews['a'.repeat(40)].superseded, true, 'never delivered, and the PR moved: moot')
    assert.equal(l.reviews['c'.repeat(40)].superseded, undefined, 'delivered: it counts')
  })
})

describe('the worktree of a merged PR', () => {
  test('is removed once nothing runs there, and kept with a reason while something does', async () => {
    const merged = pr({ number: 12, state: 'MERGED' })
    const h = harness([merged])
    h.store.set('tracked:acme/app', [12])
    const removed: string[] = []
    let dirty = true
    h.deps.removeWorktree = async (path) => (dirty ? { removed: false, reason: 'it has uncommitted changes' } : (removed.push(path), { removed: true }))
    let live = true
    h.deps.workers = async () => [{ dispatchId: 'd1', worktreeId: 'ws-login', taskId: 't', runId: 'r', agent: 'opencode', model: null, state: 'ready', live }]
    // The tick that sees it merged queues it; a live worker keeps it.
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(removed, [])
    assert.equal((h.store.get('cleanup:acme/app') as { kept?: string }[])[0].kept, 'an agent is still running there')
    // Worker gone but uncommitted changes: kept, and the board says why.
    live = false
    const board = await tick(h.deps, { autopilot: true })
    assert.ok(board.repos[0].warnings.some((w) => w.includes('uncommitted changes')))
    // Clean: removed, and no longer pending.
    dirty = false
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(removed, ['/r/wt/login'])
    assert.deepEqual(h.store.get('cleanup:acme/app'), [])
  })

  test('is left alone in dry run and when the setting is off', async () => {
    const merged = pr({ number: 12, state: 'MERGED' })
    const h = harness([merged])
    h.store.set('tracked:acme/app', [12])
    let called = false
    h.deps.removeWorktree = async () => ((called = true), { removed: true })
    h.deps.workers = async () => []
    await tick(h.deps, { autopilot: false })
    await tick(h.deps, { autopilot: false })
    assert.equal(called, false)
  })
})

describe('a nearly full disk', () => {
  test('needs the person, once per board', async () => {
    const h = harness([pr({ number: 12 })])
    h.deps.freeSpace = async () => 3 * 1024 ** 3
    const low = await tick(h.deps, { autopilot: false })
    const disk = low.attention.filter((a) => a.key === 'disk')
    assert.equal(disk.length, 1)
    assert.ok(disk[0].message.startsWith('Only 3.0 GB free on the disk with acme/app.'))
    h.deps.freeSpace = async () => 50 * 1024 ** 3
    assert.equal((await tick(h.deps, { autopilot: false })).attention.some((a) => a.key === 'disk'), false)
    h.deps.freeSpace = async () => null
    assert.equal((await tick(h.deps, { autopilot: false })).attention.some((a) => a.key === 'disk'), false, 'unknown is not low')
  })
})
