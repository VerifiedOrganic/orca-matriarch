import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { ATTENTION_CLEAR_MS, diskAttention, FINISHED_GRACE_MS, SHOW_CLOSED_MS, tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Executor } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { ledgerKey } from './ledger.ts'
import type { WorkerRow } from './orca-cli.ts'
import type { Action } from './plan.ts'
import { check, pr, SHA } from './testing/fixtures.ts'
import { ActivityTracker } from './worker.ts'

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

describe('an agent whose worker Orca saw exit', () => {
  // Seen live: a worker stopped over a limit never said it was done, so its pane read "working"
  // for a day, and the PR a later worker opened and finished in the same worktree sat in Working.
  const row = (dispatchId: string, terminal: string, over: Partial<WorkerRow> = {}): WorkerRow =>
    ({ dispatchId, worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: 'codex', model: null, state: 'running', live: true, liveness: 'live', terminal, ...over })
  const exited = (state: string): Partial<WorkerRow> => ({ state, live: false, liveness: 'exited' })
  /** The engine with the worker's own ActivityTracker behind `activity`. */
  const setup = (prs: PrSnapshot[], workers: () => WorkerRow[], workspaces?: Workspace[]) => {
    const h = harness(prs, { workspaces })
    const panes = new ActivityTracker()
    const asked: (ReadonlySet<string> | undefined)[] = []
    h.deps.activity = (id, path, gone) => (asked.push(gone), panes.forWorkspace(id, h.deps.now(), path, gone))
    h.deps.workers = async () => workers()
    return { h, panes, asked }
  }
  const track = async (deps: EngineDeps, key: string, autopilot = false) => (await tick(deps, { autopilot })).tracks.find((t) => t.key === key)!

  test('no longer holds the PR a later worker finished in the same worktree', async () => {
    let rows = [row('d-stopped', 'term_stopped')]
    const { h, panes } = setup([pr({ number: 19 })], () => rows)
    panes.note('pane-1', 'ws-login', 'working', T0 - 30 * 60_000, 'term_stopped')
    assert.equal((await track(h.deps, 'ws-login')).lane, 'working', 'while it runs, its turn holds the PR')
    // Stopped, it never says it is done; the supervisor starts another worker there, which finishes.
    panes.note('pane-2', 'ws-login', 'working', T0 - 20 * 60_000, 'term_next')
    panes.note('pane-2', 'ws-login', 'done', T0 - 5 * 60_000, 'term_next')
    rows = [row('d-next', 'term_next', exited('succeeded')), row('d-stopped', 'term_stopped', exited('stopped'))]
    const t = await track(h.deps, 'ws-login')
    assert.equal(t.lane, 'ready')
    assert.equal(t.owner?.activity, 'done')
  })

  test('still counts while a worker Orca does not call exited runs in that terminal', async () => {
    for (const liveness of ['live', 'unverifiable', null]) {
      const rows = [row('d-again', 'term_shared', { liveness, live: liveness !== 'unverifiable' }), row('d-before', 'term_shared', exited('succeeded'))]
      const { h, panes } = setup([pr({ number: 19 })], () => rows)
      panes.note('pane-1', 'ws-login', 'working', T0 - 60_000, 'term_shared')
      assert.equal((await track(h.deps, 'ws-login')).lane, 'working', `a worker ${liveness ?? 'Orca says nothing of'} runs there`)
    }
  })

  test("takes each agent at its word while Orca's worker list cannot be read", async () => {
    const { h, panes, asked } = setup([pr({ number: 19 })], () => {
      throw new Error('runtime_unavailable')
    })
    panes.note('pane-1', 'ws-login', 'working', T0 - 60_000, 'term_stopped')
    assert.equal((await track(h.deps, 'ws-login')).lane, 'working')
    assert.ok(asked.length > 0 && asked.every((gone) => gone === undefined))
  })

  test('leaves a worktree with no PR idle, so its cleanup goes ahead', async () => {
    const gate: Workspace = { id: 'ws-gate', kind: 'worktree', name: 'gate', path: '/r/wt/gate', branch: null, hostId: null }
    let rows = [row('d-gate', 'term_gate', { worktreeId: 'ws-gate' })]
    const { h, panes } = setup([], () => rows, [gate])
    const removed: string[] = []
    h.deps.removeWorktree = async (path) => (removed.push(path), { removed: true })
    panes.note('pane-1', 'ws-gate', 'working', T0 - 60_000, 'term_gate')
    assert.equal((await track(h.deps, 'ws-gate', true)).lane, 'building')
    // Its agent crashed mid-turn: Orca saw it exit, and its pane still says working.
    rows = [row('d-gate', 'term_gate', { worktreeId: 'ws-gate', ...exited('failed') })]
    assert.equal((await track(h.deps, 'ws-gate', true)).lane, 'idle')
    h.advance(FINISHED_GRACE_MS)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(removed, ['/r/wt/gate'])
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
  const GB = 1024 ** 3
  test('needs the person, once per disk', async () => {
    const h = harness([pr({ number: 12 })])
    h.deps.disk = async () => ({ id: 'd1', free: 3 * GB })
    const low = await tick(h.deps, { autopilot: false })
    const disk = low.attention.filter((a) => a.key.startsWith('disk:'))
    assert.equal(disk.length, 1)
    assert.equal(disk[0].repo, 'acme/app')
    assert.ok(disk[0].message.startsWith('Only 3.0 GB free on the disk with acme/app.'))
    h.deps.disk = async () => ({ id: 'd1', free: 50 * GB })
    assert.equal((await tick(h.deps, { autopilot: false })).attention.some((a) => a.key.startsWith('disk:')), false)
    h.deps.disk = async () => null
    assert.equal((await tick(h.deps, { autopilot: false })).attention.some((a) => a.key.startsWith('disk:')), false, 'unknown is not low')
  })

  // Two projects, each with a worktree; which disk each is on, and its floor, set per test.
  const twoProjects = (disks: Record<string, { id: string; free: number }>, floors: Record<string, number> = {}) => {
    const h = harness([], {
      workspaces: [
        { id: 'ws-a', kind: 'worktree', name: 'a', path: '/r/wt/a', branch: 'feature/a', hostId: null },
        { id: 'ws-b', kind: 'worktree', name: 'b', path: '/s/wt/b', branch: 'feature/b', hostId: null }
      ]
    })
    h.deps.repoOf = async (path) =>
      path.startsWith('/s') ? { ref: { owner: 'acme', name: 'web' }, key: 'acme/web', root: '/s' } : { ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }
    h.deps.readConfig = async (root) => validateConfig({ review: { enabled: false }, limits: { minFreeDiskGB: floors[root] ?? 10 } })
    h.deps.disk = async (path) => disks[path] ?? null
    return h
  }

  test('one notice for a disk two projects share, naming both, on both their pages', async () => {
    // Seen live: the notice named only the first project, though the second's workers were held too.
    const h = twoProjects({ '/r': { id: 'd1', free: 4.2 * GB }, '/s': { id: 'd1', free: 4.0 * GB } })
    const disk = (await tick(h.deps, { autopilot: false })).attention.filter((a) => a.key.startsWith('disk:'))
    assert.equal(disk.length, 1)
    assert.match(disk[0].message, /^Only 4\.0 GB free on the disk with acme\/app and acme\/web\./, 'the lower reading, and both projects')
    assert.deepEqual(disk[0].repos, ['acme/app', 'acme/web'])
    assert.equal(disk[0].repo, undefined)
  })

  test('a project on the disk above its own floor is not named', async () => {
    const h = twoProjects({ '/r': { id: 'd1', free: 4 * GB }, '/s': { id: 'd1', free: 4 * GB } }, { '/s': 2 })
    const disk = (await tick(h.deps, { autopilot: false })).attention.filter((a) => a.key.startsWith('disk:'))
    assert.equal(disk.length, 1)
    assert.equal(disk[0].repo, 'acme/app')
    assert.match(disk[0].message, /on the disk with acme\/app\. /)
  })

  test('a second low disk gets its own notice, not hidden behind the first', async () => {
    const h = twoProjects({ '/r': { id: 'd1', free: 3 * GB }, '/s': { id: 'd2', free: 1 * GB } })
    const disk = (await tick(h.deps, { autopilot: false })).attention.filter((a) => a.key.startsWith('disk:'))
    assert.deepEqual(disk.map((a) => [a.key, a.repo]), [['disk:d1', 'acme/app'], ['disk:d2', 'acme/web']])
  })

  test('three projects are named in order, in one sentence', () => {
    const a = diskAttention('d1', 3 * GB, ['acme/web', 'acme/api', 'acme/app'])
    assert.match(a.message, /^Only 3\.0 GB free on the disk with acme\/api, acme\/app and acme\/web\. /)
    assert.deepEqual(a.repos, ['acme/api', 'acme/app', 'acme/web'])
  })

  test('a shared notice reaches you once, titled for Matriarch rather than one project', async () => {
    const h = twoProjects({ '/r': { id: 'd1', free: 3 * GB }, '/s': { id: 'd1', free: 3 * GB } })
    const told: string[] = []
    h.deps.notifyPerson = async (a) => void told.push(`${a.title} | ${a.repo ?? '-'}`)
    await tick(h.deps, { autopilot: true })
    h.deps.disk = async () => ({ id: 'd1', free: 2 * GB })
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(told, ['Matriarch needs you | -'], 'once, though the figure changed')
  })
})

describe("a PR's builder", () => {
  test('is the first worker seen on it, and is marked done once it finishes a turn', async () => {
    const h = harness([pr({ number: 12 })])
    let state = 'ready'
    h.deps.workers = async () => [{ dispatchId: 'd1', worktreeId: 'ws-login', taskId: 't', runId: 'r', agent: 'opencode', model: null, state, live: true }]
    await tick(h.deps, { autopilot: false })
    const first = h.store.get(ledgerKey('acme/app', 12)) as { builder?: { address: string; done: boolean } }
    assert.equal(first.builder?.address, 'dispatch:d1')
    // Another worker later on the PR does not replace its builder.
    h.deps.workers = async () => [{ dispatchId: 'd2', worktreeId: 'ws-login', taskId: 't2', runId: 'r', agent: 'codex', model: null, state, live: true }]
    await tick(h.deps, { autopilot: false })
    assert.equal((h.store.get(ledgerKey('acme/app', 12)) as { builder?: { address: string } }).builder?.address, 'dispatch:d1')
  })
})

describe("a finished worktree that never became a PR", () => {
  const gate = { id: 'ws-gate', kind: 'worktree' as const, name: 'P1 gate review', path: '/r/wt/gate', branch: null, hostId: null }
  const mine = { id: 'ws-mine', kind: 'worktree' as const, name: 'my spike', path: '/r/wt/mine', branch: 'spike', hostId: null }
  const setup = () => {
    const h = harness([], { workspaces: [gate, mine] })
    const removed: { path: string; keepBranch?: boolean }[] = []
    h.deps.removeWorktree = async (path, options) => (removed.push({ path, keepBranch: options?.keepBranch }), { removed: true })
    h.deps.workers = async () => [
      { dispatchId: 'd-gate', worktreeId: 'ws-gate', taskId: 't', runId: 'r1', agent: 'codex', model: null, state: 'succeeded', live: false },
      // A worktree some other Run used: a person's, or another supervisor's.
      { dispatchId: 'd-mine', worktreeId: 'ws-mine', taskId: 't2', runId: 'other', agent: 'codex', model: null, state: 'succeeded', live: false }
    ]
    return { h, removed }
  }

  test("goes an hour after the supervisor's last worker there finished, keeping its branch", async () => {
    const { h, removed } = setup()
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(removed, [], 'not yet: its worker just finished')
    h.advance(FINISHED_GRACE_MS)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(removed, [{ path: '/r/wt/gate', keepBranch: true }], "only the supervisor's own worktree")
  })

  test('stays in dry run, while a worker is live there, and when the setting is off', async () => {
    const dry = setup()
    await tick(dry.h.deps, { autopilot: false })
    dry.h.advance(FINISHED_GRACE_MS)
    await tick(dry.h.deps, { autopilot: false })
    assert.deepEqual(dry.removed, [])
    const live = setup()
    live.h.deps.workers = async () => [{ dispatchId: 'd-gate', worktreeId: 'ws-gate', taskId: 't', runId: 'r1', agent: 'codex', model: null, state: 'ready', live: true }]
    await tick(live.h.deps, { autopilot: true })
    live.h.advance(FINISHED_GRACE_MS)
    await tick(live.h.deps, { autopilot: true })
    assert.deepEqual(live.removed, [])
    const off = setup()
    off.h.deps.readConfig = async () => validateConfig({ review: { enabled: false }, merge: { removeFinishedWorktrees: false } })
    await tick(off.h.deps, { autopilot: true })
    off.h.advance(FINISHED_GRACE_MS)
    await tick(off.h.deps, { autopilot: true })
    assert.deepEqual(off.removed, [])
  })
})

describe('a merged PR', () => {
  test('stays on the board in Merged / closed for a while, without asking the forge again', async () => {
    const open = pr({ number: 12 })
    const prs = [open]
    const h = harness(prs)
    h.deps.store.keys = async () => [...h.store.keys()]
    await tick(h.deps, { autopilot: false })
    prs[0] = { ...open, state: 'MERGED' }
    const merged = await tick(h.deps, { autopilot: false })
    assert.equal(merged.tracks.find((t) => t.pr?.number === 12)?.lane, 'merged')
    let asked = 0
    const detail = h.deps.github.detail
    h.deps.github.detail = async (...args) => (asked++, detail(...args))
    h.advance(60 * 60_000)
    const later = await tick(h.deps, { autopilot: false })
    assert.equal(later.tracks.find((t) => t.pr?.number === 12)?.lane, 'merged', 'still shown an hour later')
    assert.equal(asked, 0, 'from what was read when it closed')
    h.advance(SHOW_CLOSED_MS)
    const gone = await tick(h.deps, { autopilot: false })
    assert.ok(!gone.tracks.some((t) => t.pr?.number === 12), 'gone once the window passed')
  })
})

describe('Needs you that nothing else tells you about', () => {
  // A nearly full disk: on the board, and with no escalation or notice of its own.
  const setup = () => {
    const h = harness([])
    let free = 2 * 1024 ** 3
    const told: string[] = []
    h.deps.disk = async () => ({ id: 'd1', free })
    h.deps.notifyPerson = async (a) => void told.push(`${a.kind}: ${a.body}`)
    return { h, told, setFree: (gb: number) => (free = gb * 1024 ** 3) }
  }

  test('reaches you once while it stands, and again only after it cleared for a while', async () => {
    const { h, told, setFree } = setup()
    const board = await tick(h.deps, { autopilot: true })
    assert.equal(board.attention.find((a) => a.key === 'disk:d1')?.alert, true)
    assert.equal(told.length, 1)
    assert.match(told[0], /^needs-you: Only 2\.0 GB free on the disk with acme\/app/)
    await tick(h.deps, { autopilot: true })
    assert.equal(told.length, 1, 'once while it stands')
    // Gone for a tick (a read that failed, say), then back: not again.
    setFree(50)
    await tick(h.deps, { autopilot: true })
    setFree(2)
    await tick(h.deps, { autopilot: true })
    assert.equal(told.length, 1, 'a short gap does not ring twice')
    // Gone for long enough, then back: again.
    setFree(50)
    await tick(h.deps, { autopilot: true })
    h.advance(ATTENTION_CLEAR_MS)
    await tick(h.deps, { autopilot: true })
    setFree(2)
    await tick(h.deps, { autopilot: true })
    assert.equal(told.length, 2)
  })

  test('only while Matriarch acts: one first seen in dry run reaches you once autopilot is on', async () => {
    const { h, told } = setup()
    await tick(h.deps, { autopilot: false })
    assert.deepEqual(told, [])
    await tick(h.deps, { autopilot: true })
    assert.equal(told.length, 1)
  })

  test('an item another path already tells you about (the advisor stuck on a prompt) is not alerted twice', async () => {
    const { h, told, setFree } = setup()
    setFree(50)
    h.deps.advisor = {
      step: async () => ({
        agent: 'claude', model: null, effort: null, usable: true, queued: 0, waiting: null, last: null,
        answering: { question: 'q', since: 1, blocked: 'a permission prompt', terminal: 'term_adv', workspaceId: null, lock: null }
      })
    }
    const board = await tick(h.deps, { autopilot: true })
    const stuck = board.attention.find((a) => a.key === 'acme/app:advisor')
    assert.ok(stuck, 'it is under Needs you')
    assert.notEqual(stuck.alert, true, 'the advisor alerts when it starts waiting')
    assert.deepEqual(told, [])
  })
})

describe('a PR Matriarch stops following while it is still open', () => {
  test('is marked, so its records go a week later unless it is followed again', async () => {
    const open = pr({ number: 12 })
    const main = { id: 'ws-main', kind: 'worktree' as const, name: 'app', path: '/r', branch: 'main', hostId: null }
    const login = { id: 'ws-login', kind: 'worktree' as const, name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }
    const h = harness([open], { workspaces: [main, login] })
    await tick(h.deps, { autopilot: false })
    assert.equal(h.store.get('dropped:acme/app#12'), undefined)
    // Its worktree is gone: the PR is still open, but nothing of it is in Orca any more.
    h.deps.workspaces = async () => [main]
    h.advance(60_000)
    await tick(h.deps, { autopilot: false })
    assert.equal(typeof h.store.get('dropped:acme/app#12'), 'number')
  })
})
