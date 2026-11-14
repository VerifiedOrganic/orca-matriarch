import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { CONFIG_PATH, validateConfig } from './config.ts'
import { tick, type EngineDeps } from './engine.ts'
import type { GitHub } from './github.ts'
import { countStarts, createLimitsGuard, dayOf, isWorkerStart, limitLines, limitsChanged, limitsMessage, startRefusal, type LimitState } from './limits.ts'
import type { WorkerRow } from './orca-cli.ts'
import { supervisorBrief, supervisorTag } from './supervisor.ts'
import { createWorker, deactivate } from './worker.ts'

const T0 = new Date(2026, 10, 14, 10, 0).getTime()
const HOUR = 3600_000
const GB = 1024 ** 3
const defaults = () => validateConfig({}).config.limits

function state(over: Partial<LimitState> = {}): LimitState {
  return {
    repo: 'acme/app',
    root: '/r',
    workspaces: [{ id: 'ws-main', path: '/r' }, { id: 'ws-login', path: '/r/wt/login' }],
    live: 0,
    startsToday: 0,
    day: dayOf(T0),
    freeBytes: 100 * GB,
    limits: defaults(),
    ...over
  }
}

const start = "orca orchestration worker-start --task t1 --worktree path:/r/wt/login --agent 'codex' --json"
const bash = (command: string, workspaceId: string | null = 'repo1::/r') => ({ agent: 'claude', tool: 'Bash', workspaceId, input: { command } })

describe('a worker start', () => {
  test('is told apart from other commands, even inside a longer one', () => {
    assert.equal(isWorkerStart(start), true)
    assert.equal(isWorkerStart(`cd /r && ${start}`), true)
    assert.equal(isWorkerStart(`ORCA_X=1 /opt/bin/orca orchestration worker-start --task t`), true)
    assert.equal(isWorkerStart('orca orchestration worker-list --json'), false)
    assert.equal(isWorkerStart('echo orca orchestration worker-start'), false)
    assert.equal(isWorkerStart('orca worktree create --name x'), false)
  })

  test('is refused at the cap, over the daily budget and under the disk floor, saying what to do', () => {
    const today = dayOf(T0)
    assert.equal(startRefusal(state({ live: 3 }), { starts: 0 }, today), null)
    assert.match(startRefusal(state({ live: 4 }), { starts: 0 }, today) ?? '', /4 of 4 workers are live in acme\/app.*Wait for one to finish/)
    assert.match(startRefusal(state({ live: 3 }), { starts: 1 }, today) ?? '', /4 of 4/, 'a start let through since the tick counts')
    const daily = state({ limits: { ...defaults(), maxWorkerStartsPerDay: 5 }, startsToday: 5 })
    assert.match(startRefusal(daily, { starts: 0 }, today) ?? '', /started 5 workers today, its limit of 5 a day/)
    assert.equal(startRefusal(daily, { starts: 0 }, dayOf(T0 + 24 * HOUR)), null, 'a new day starts the budget again')
    assert.match(startRefusal(state({ freeBytes: 4 * GB }), { starts: 0 }, today) ?? '', /Only 4\.0 GB is free.*10 GB floor/)
    assert.equal(startRefusal(state({ freeBytes: null }), { starts: 0 }, today), null, 'unknown free space is not low')
    const off = state({ live: 40, freeBytes: 0, startsToday: 900, limits: { ...defaults(), maxWorkers: 0, maxWorkerStartsPerDay: 0, minFreeDiskGB: 0 } })
    assert.equal(startRefusal(off, { starts: 5 }, today), null, '0 turns each limit off')
  })
})

describe('the hook', () => {
  test("refuses only a worker start from one of the project's own checkouts", () => {
    const guard = createLimitsGuard(() => T0)
    guard.update(state({ live: 4 }))
    assert.match(guard.decide(bash(start))?.deny ?? '', /4 of 4/, 'the supervisor in the main checkout')
    assert.ok(guard.decide(bash(start, 'ws-login')), 'by workspace id')
    assert.equal(guard.decide(bash(start, 'repo2::/elsewhere')), null, 'another project is not judged')
    assert.equal(guard.decide(bash(start, null)), null)
    assert.equal(guard.decide(bash('git status')), null)
    assert.equal(guard.decide({ agent: 'claude', tool: 'Write', workspaceId: 'repo1::/r', input: { command: start } }), null)
  })

  test('counts the starts it let through until the next tick sees them, then forgets a gone project', () => {
    const guard = createLimitsGuard(() => T0)
    guard.update(state({ live: 2 }))
    assert.equal(guard.decide(bash(start)), null)
    assert.equal(guard.decide(bash(start)), null)
    assert.match(guard.decide(bash(start))?.deny ?? '', /4 of 4/, 'two let through on top of two live')
    guard.update(state({ live: 3 }))
    assert.equal(guard.decide(bash(start)), null, 'the next tick counts afresh')
    guard.keep(new Set())
    assert.equal(guard.decide(bash(start)), null, 'a project turned off is not judged')
  })
})

describe('starts a day', () => {
  test('counts workers first seen today, once each, and starts again at midnight', () => {
    const first = countStarts(null, ['d1', 'd2'], T0)
    assert.equal(first.count, 0, 'workers already there when Matriarch first looks started at an unknown time')
    const later = countStarts(first, ['d1', 'd2', 'd3'], T0 + HOUR)
    assert.equal(later.count, 1)
    assert.equal(countStarts(later, ['d1', 'd2', 'd3'], T0 + 2 * HOUR).count, 1, 'none counts twice')
    const tomorrow = countStarts(later, ['d3', 'd4'], T0 + 24 * HOUR)
    assert.deepEqual([tomorrow.day, tomorrow.count], [dayOf(T0 + 24 * HOUR), 1])
  })
})

describe('the supervisor is told the limits', () => {
  test('in its brief, and when they change in Settings', () => {
    const config = validateConfig({ limits: { maxWorkers: 3, maxWorkerStartsPerDay: 12 } }).config
    const brief = supervisorBrief({ repo: 'acme/app', objective: 'x', tag: supervisorTag('acme/app', 'n'), base: 'main', config })
    assert.ok(brief.includes('Limits in this project: at most 3 workers running at once; at most 12 worker starts a day; no new worker while the disk has under 10 GB free.'))
    assert.ok(brief.includes('Matriarch refuses a worker-start over a limit'))
    const none = validateConfig({ limits: { maxWorkers: 0, minFreeDiskGB: 0 } }).config
    assert.deepEqual(limitLines(none.limits), [])
    assert.ok(!supervisorBrief({ repo: 'acme/app', objective: 'x', tag: 't', base: 'main', config: none }).includes('Limits in this project'))
    assert.equal(limitsChanged(defaults(), defaults()), false)
    assert.equal(limitsChanged(defaults(), { ...defaults(), maxConcurrentReviews: 5 }), false, 'reviews at once are not the supervisor’s')
    assert.equal(limitsChanged(defaults(), config.limits), true)
    assert.match(limitsMessage(config.limits).body, /at most 3 workers running at once/)
    assert.match(limitsMessage(none.limits).body, /turned the worker limits off/)
  })
})

function engine(rows: WorkerRow[], over: Partial<EngineDeps> = {}) {
  const store = new Map<string, unknown>()
  let now = T0
  const github: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
  const seen: LimitState[] = []
  const deps: EngineDeps = {
    now: () => now,
    log: () => {},
    workspaces: async () => [{ id: 'ws-main', kind: 'worktree', name: 'main', path: '/r', branch: 'refs/heads/main', hostId: 'local' }],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig({ review: { enabled: false }, limits: { maxWorkers: 2, maxWorkerStartsPerDay: 3 } }),
    github,
    workers: async () => rows,
    activity: () => null,
    supervisor: async () => 'run:r1',
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor: null,
    onLimits: (s) => seen.push(s),
    ...over
  }
  return { deps, seen, advance: (ms: number) => (now += ms) }
}

const row = (id: string, over: Partial<WorkerRow> = {}): WorkerRow => ({ dispatchId: id, worktreeId: `ws-${id}`, taskId: 't', runId: 'r1', agent: 'codex', model: null, state: 'running', live: true, ...over })

describe('each tick', () => {
  test("counts the supervisor's running workers for its row and the hook", async () => {
    const rows = [row('d1'), row('d2', { live: false }), row('d3', { state: 'succeeded' }), row('d4', { runId: 'other' })]
    const e = engine(rows)
    const board = await tick(e.deps, { autopilot: false })
    const sup = board.repos[0].supervisor
    assert.deepEqual([sup.workers, sup.live, sup.maxWorkers, sup.startsToday, sup.maxStarts], [3, 1, 2, 0, 3])
    assert.equal(e.seen[0].live, 1)
    assert.equal(e.seen[0].root, '/r')
    assert.ok(!board.attention.some((a) => a.key === 'limits:acme/app'))
  })

  test('says in Needs you when a supervisor the hook cannot stop went over', async () => {
    const rows = [row('d1'), row('d2')]
    const e = engine(rows)
    await tick(e.deps, { autopilot: true })
    rows.push(row('d3'), row('d4'))
    e.advance(60_000)
    const board = await tick(e.deps, { autopilot: true })
    const over = board.attention.filter((a) => a.key === 'limits:acme/app')
    assert.equal(over.length, 1)
    assert.match(over[0].message, /4 workers are running, over its limit of 2 at once/)
    assert.equal(board.repos[0].supervisor.startsToday, 2)
  })

  test('warns of a nearly full disk at the floor the project sets, or not at all', async () => {
    const low = engine([], { freeSpace: async () => 15 * GB, readConfig: async () => validateConfig({ review: { enabled: false }, limits: { minFreeDiskGB: 20 } }) })
    assert.ok((await tick(low.deps, { autopilot: false })).attention.some((a) => a.key === 'disk'))
    const off = engine([], { freeSpace: async () => 1 * GB, readConfig: async () => validateConfig({ review: { enabled: false }, limits: { minFreeDiskGB: 0 } }) })
    assert.ok(!(await tick(off.deps, { autopilot: false })).attention.some((a) => a.key === 'disk'))
  })

  test('hands nothing to the hook while it cannot see the workers', async () => {
    const e = engine([], { workers: async () => { throw new Error('runtime_unavailable') } })
    await tick(e.deps, { autopilot: false })
    assert.deepEqual(e.seen, [])
  })
})

test("the worker refuses a Claude supervisor's worker start over the cap, once a tick counted them", async () => {
  const root = await mkdtemp(join(tmpdir(), 'matriarch-limits-'))
  await mkdir(join(root, '.orca'), { recursive: true })
  await writeFile(join(root, CONFIG_PATH), JSON.stringify({ version: 1 }))
  const orcaCli = {
    run: async (args: readonly string[]) => {
      if (args[1] === 'worker-list') return { workers: [1, 2, 3, 4].map((n) => ({ dispatchId: `d${n}`, runId: 'r1', resource: { worktreeId: `w${n}` }, workerState: 'running' })) }
      if (args[1] === 'run-list') return { runs: [{ id: 'r1', objective: '[matriarch:acme/app:n] x' }] }
      return {}
    }
  }
  const exec = async (file: string, args: readonly string[]) => {
    if (file !== 'git') return { code: 1, stdout: '', stderr: '' }
    if (args.includes('--git-common-dir')) return { code: 0, stdout: `${root}/.git\n`, stderr: '' }
    if (args.includes('remote.origin.url')) return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const github: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: {
      'workspace.list': { workspaces: [{ id: 'ws-main', kind: 'worktree', name: 'main', path: root, branch: 'refs/heads/main', hostId: 'local' }], truncated: false },
      'statusBar.update': { ok: true }
    },
    settings: { autopilot: false, pollSeconds: 45 },
    storage: { 'supervisor:acme/app': 'run:r1' }
  })
  const worker = await mountWorker({ default: createWorker({ exec, github, orcaCli, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot'],
    hooks: ['agent.tool.before', 'agent.launch.before']
  })
  try {
    const event = { agent: 'claude', workspaceId: `repo1::${root}`, tool: 'Bash', input: { command: start } }
    assert.equal((await worker.hooks.fire('agent.tool.before', event)).kind, 'continue', 'nothing counted yet')
    await worker.command('refresh')
    const refused = await worker.hooks.fire('agent.tool.before', event)
    assert.equal(refused.kind, 'deny')
    assert.match(refused.kind === 'deny' ? refused.reason : '', /4 of 4 workers are live/)
    assert.ok(worker.logs.some((l) => l.includes('refused a worker start by claude')))
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
