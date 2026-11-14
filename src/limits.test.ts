import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from 'orca/host'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { CONFIG_PATH, validateConfig } from './config.ts'
import { FINISHED_GRACE_MS, tick, type EngineDeps } from './engine.ts'
import type { GitHub } from './github.ts'
import {
  countStarts,
  createLimitsGuard,
  dayOf,
  isWorking,
  limitLines,
  limitsChanged,
  limitsMessage,
  overLimitStarts,
  PASSED_GRACE_MS,
  STOP_RETRY_MS,
  stoppedMessage,
  startRefusal,
  startsIn,
  type LimitState,
  type LimitsSnapshot
} from './limits.ts'
import { OrcaRefusal, parseWorkerList, type WorkerRow } from './orca-cli.ts'
import { supervisorBrief, supervisorTag } from './supervisor.ts'
import { check, pr } from './testing/fixtures.ts'
import { createWorker, deactivate } from './worker.ts'

const T0 = new Date(2026, 10, 14, 10, 0).getTime()
const HOUR = 3600_000
const GB = 1024 ** 3
const defaults = () => validateConfig({}).config.limits

function state(over: Partial<LimitState> = {}): LimitState {
  return {
    repo: 'acme/app',
    terminals: ['term_sup', 'term_w1'],
    live: 0,
    startsToday: 0,
    day: dayOf(T0),
    freeBytes: 100 * GB,
    listedAt: T0,
    limits: defaults(),
    ...over
  }
}

const start = "orca orchestration worker-start --task t1 --worktree path:/r/wt/login --agent 'codex' --json"
const bash = (command: string, terminalId: string | undefined = 'term_sup') => ({ agent: 'claude', tool: 'Bash', workspaceId: 'repo1::/r', ...(terminalId ? { terminalId } : {}), input: { command } })
const none = { running: 0, today: 0 }
const one = { count: 1, repeats: false }

describe('reading a command for worker starts', () => {
  test('finds a start in every shell form, failing closed', () => {
    const forms = [
      start,
      `cd /r && ${start}`,
      'cd /r && orca orchestration worker-start --task "$(cat t.md)" --json',
      "orca orchestration worker-start --task t --spec - <<'EOF'\nDo the thing\nEOF",
      'WT=$(orca worktree create --repo path:/r --name a --json | jq -r .path) && orca orchestration worker-start --task t --worktree "path:$WT"',
      'OUT=$(orca orchestration worker-start --task t --json)',
      'if true; then orca orchestration worker-start --task t; fi',
      '( orca orchestration worker-start --task t )',
      '{ orca orchestration worker-start --task t; }',
      'env A=1 orca orchestration worker-start --task t',
      'time nohup orca orchestration worker-start --task t &',
      'bash -c "orca orchestration worker-start --task t"',
      '"orca" orchestration worker-start --task t',
      "'/Applications/Orca.app/Contents/Resources/bin/orca' 'orchestration' 'worker-start'",
      'orca --json orchestration worker-start --task t',
      'orca orchestration --json worker-start --task t',
      'orca --environment local orchestration --environment check worker-start --task t',
      'orca orchestration \\\n  worker-start \\\n  --task t',
      'orca-ide orchestration worker-start --task t',
      'orca-dev orchestration worker-start --task t',
      '"$ORCA_CLI_COMMAND" orchestration worker-start --task t',
      '${ORCA_CLI_COMMAND} orchestration worker-start --task t',
      'orca orchestration worker"-"start --task t',
      'orca orchestration $SUB --task t',
      'orca orchestration dispatch --to term_x --task t',
      "orca agent launch --agent codex --worktree path:/r/wt/a --prompt 'Do it'"
    ]
    for (const command of forms) assert.ok(startsIn(command).count >= 1, `not seen: ${command}`)
    for (const command of ['orca orchestration worker-list --json', 'orca orchestration --json worker-list', 'orca worktree create --name x', 'git status', 'orca orchestration send --to run:r1 --subject s'])
      assert.equal(startsIn(command).count, 0, `not a start: ${command}`)
  })

  test('counts several starts in one call, and knows a loop can start more than it shows', () => {
    assert.deepEqual(startsIn(`${start} && ${start.replace('t1', 't2')}`), { count: 2, repeats: false })
    assert.equal(startsIn(`for t in a b c; do ${start}; done`).repeats, true)
    assert.equal(startsIn(`printf 'a\\nb' | xargs -n1 ${start}`).repeats, true)
    assert.equal(startsIn(`go() { ${start}; }; go; go`).repeats, true)
    assert.equal(startsIn('for f in *.md; do cat $f; done').repeats, false, 'a loop with no start is nothing')
  })
})

describe('a worker start', () => {
  test('is refused when it would pass the cap, the daily budget or the disk floor, saying what to do', () => {
    const today = dayOf(T0)
    assert.equal(startRefusal(state({ live: 3 }), none, one, today), null)
    assert.match(startRefusal(state({ live: 4 }), none, one, today) ?? '', /4 of 4 workers are running in acme\/app.*Wait for one to finish/)
    assert.match(startRefusal(state({ live: 3 }), { running: 1, today: 1 }, one, today) ?? '', /4 of 4/, 'a start let through since the tick counts')
    assert.match(startRefusal(state({ live: 3 }), none, { count: 2, repeats: false }, today) ?? '', /3 of 4 workers are running in acme\/app, and this would start 2 more/)
    assert.equal(startRefusal(state({ live: 2 }), none, { count: 2, repeats: false }, today), null, 'two fit')
    assert.match(startRefusal(state(), none, { count: 1, repeats: true }, today) ?? '', /in a loop.*its own worker-start call/)
    const daily = state({ limits: { ...defaults(), maxWorkerStartsPerDay: 5 }, startsToday: 4 })
    assert.equal(startRefusal(daily, none, one, today), null)
    assert.match(startRefusal(daily, none, { count: 2, repeats: false }, today) ?? '', /started 4 workers today and this would start 2 more, over its limit of 5 a day/)
    assert.equal(startRefusal(state({ ...daily, startsToday: 5 }), none, one, dayOf(T0 + 24 * HOUR)), null, 'a new day starts the budget again')
    assert.match(startRefusal(state({ freeBytes: 4 * GB }), none, one, today) ?? '', /Only 4\.0 GB is free.*10 GB floor/)
    assert.equal(startRefusal(state({ freeBytes: null }), none, one, today), null, 'unknown free space is not low')
    const off = state({ live: 40, freeBytes: 0, startsToday: 900, limits: { ...defaults(), maxWorkers: 0, maxWorkerStartsPerDay: 0, minFreeDiskGB: 0 } })
    assert.equal(startRefusal(off, { running: 5, today: 5 }, { count: 3, repeats: true }, today), null, '0 turns each limit off, loops included')
  })
})

describe('the hook', () => {
  test("judges only the supervisor's terminal and its workers', never another session", () => {
    const guard = createLimitsGuard({ now: () => T0 })
    guard.update(state({ live: 4 }))
    assert.match(guard.decide(bash(start))?.deny ?? '', /4 of 4/, "the supervisor's terminal")
    assert.ok(guard.decide(bash(start, 'term_w1')), 'a worker of its Run')
    assert.equal(guard.decide(bash(start, 'term_mine')), null, "the person's own Claude session in the same checkout")
    assert.equal(guard.decide({ agent: 'claude', tool: 'Bash', workspaceId: 'repo1::/r', input: { command: start } }), null, 'a call Orca could not tie to a terminal')
    assert.equal(guard.decide(bash('git status')), null)
    assert.equal(guard.decide({ agent: 'claude', tool: 'Write', workspaceId: 'repo1::/r', terminalId: 'term_sup', input: { command: start } }), null)
  })

  test('counts every start it let through, until a worker list read well after them', () => {
    let now = T0
    const guard = createLimitsGuard({ now: () => now })
    guard.update(state({ live: 1, listedAt: T0 }))
    assert.equal(guard.decide(bash(`${start} && ${start}`)), null, 'two starts in one call')
    assert.match(guard.decide(bash(`${start} && ${start}`))?.deny ?? '', /3 of 4 .*this would start 2 more/, 'they count as two')
    now = T0 + 5_000
    // A tick whose worker list was asked for before the starts: they are not in it, and still count.
    guard.update(state({ live: 1, listedAt: T0 - 1_000 }))
    assert.match(guard.decide(bash(`${start} && ${start}`))?.deny ?? '', /3 of 4/)
    // A list read long after them has the workers: the tick counts them instead.
    guard.update(state({ live: 3, listedAt: T0 + PASSED_GRACE_MS + 1 }))
    assert.equal(guard.decide(bash(start)), null, 'the fourth fits')
    assert.ok(guard.decide(bash(start)), 'not a fifth')
  })

  test('keeps its counts through a failed tick, forgets a project only a good tick did not see, and starts from storage', () => {
    const saved: LimitsSnapshot[] = []
    const guard = createLimitsGuard({ now: () => T0, save: (s) => saved.push(structuredClone(s)) })
    guard.update(state({ live: 4 }))
    guard.keep(new Set(['acme/app']))
    assert.ok(guard.decide(bash(start)))
    const restarted = createLimitsGuard({ now: () => T0 })
    restarted.restore(saved.at(-1))
    assert.ok(restarted.decide(bash(start)), 'a restart starts from the saved counts')
    restarted.update(state({ live: 0 }))
    restarted.restore({ states: { 'acme/app': state({ live: 4 }) }, passed: {} })
    assert.equal(restarted.decide(bash(start)), null, "a tick's newer counts win over what was saved")
    restarted.keep(new Set())
    assert.equal(restarted.decide(bash(start)), null, 'a project a good tick did not see is forgotten')
  })

  test('saves only when what it decides by changed, not on every tick', () => {
    const saved: LimitsSnapshot[] = []
    const guard = createLimitsGuard({ now: () => T0, save: (s) => saved.push(structuredClone(s)) })
    guard.update(state({ live: 2, listedAt: T0 }))
    guard.update(state({ live: 2, listedAt: T0 + 45_000 }))
    guard.update(state({ live: 2, listedAt: T0 + 90_000 }))
    assert.equal(saved.length, 1, 'the same counts, a later list')
    guard.update(state({ live: 3, listedAt: T0 + 135_000 }))
    assert.equal(saved.length, 2)
  })
})

describe('a worker Orca cannot vouch for', () => {
  test('counts as running; only one that settled or exited does not', () => {
    const rows = parseWorkerList({ workers: [
      { dispatchId: 'new', runId: 'r1', workerState: 'ready', agentTerminalHandle: 'term_a', projection: { liveness: { verdict: 'unverifiable', reason: 'missing_status' } } },
      { dispatchId: 'restored', runId: 'r1', workerState: 'running', projection: { liveness: { verdict: 'unverifiable', reason: 'restored_unconfirmed' } } },
      { dispatchId: 'gone', runId: 'r1', workerState: 'running', projection: { liveness: { verdict: 'exited' } } },
      { dispatchId: 'done', runId: 'r1', workerState: 'succeeded', projection: { liveness: { verdict: 'live' } } }
    ] })
    assert.deepEqual(rows.map((r) => [r.dispatchId, r.live, isWorking(r)]), [['new', false, true], ['restored', false, true], ['gone', false, false], ['done', true, false]])
    assert.equal(rows[0].terminal, 'term_a')
  })
})

describe('starts a day', () => {
  test("counts a Run's workers first seen today, once each, and starts again at midnight", () => {
    const first = countStarts(null, 'run:r1', ['d1', 'd2'], T0)
    assert.equal(first.count, 0, 'workers already there when Matriarch first looks started at an unknown time')
    const later = countStarts(first, 'run:r1', ['d3', 'd1', 'd2'], T0 + HOUR)
    assert.equal(later.count, 1)
    assert.equal(countStarts(later, 'run:r1', ['d3', 'd1', 'd2'], T0 + 2 * HOUR).count, 1, 'none counts twice')
    const tomorrow = countStarts(later, 'run:r1', ['d4', 'd3'], T0 + 24 * HOUR)
    assert.deepEqual([tomorrow.day, tomorrow.count], [dayOf(T0 + 24 * HOUR), 1])
  })

  test('does not run high: a long list, newest first, or an older Run found again', () => {
    const many = Array.from({ length: 900 }, (_, i) => `d${900 - i}`)
    let rec = countStarts(null, 'run:r1', many, T0)
    for (let n = 1; n <= 5; n++) rec = countStarts(rec, 'run:r1', many, T0 + n * 60_000)
    assert.equal(rec.count, 0, 'past 500 workers, none is counted again tick after tick')
    rec = countStarts(rec, 'run:r1', ['d901', ...many], T0 + HOUR)
    assert.equal(rec.count, 1, 'the newest, at the head of the list, is the one counted')
    const switched = countStarts(rec, 'run:r0', Array.from({ length: 30 }, (_, i) => `old${i}`), T0 + 2 * HOUR)
    assert.equal(switched.count, 1, "an older Run's workers are not today's starts")
  })
})

describe('the supervisor is told the limits', () => {
  test('in its brief, and when they change in Settings', () => {
    const config = validateConfig({ limits: { maxWorkers: 3, maxWorkerStartsPerDay: 12 } }).config
    const brief = supervisorBrief({ repo: 'acme/app', objective: 'x', tag: supervisorTag('acme/app', 'n'), base: 'main', config })
    assert.ok(brief.includes('Limits in this project: at most 3 workers running at once; at most 12 worker starts a day; no new worker while the disk has under 10 GB free.'))
    assert.ok(brief.includes('Start each worker with its own worker-start call, not in a loop'))
    const off = validateConfig({ limits: { maxWorkers: 0, minFreeDiskGB: 0 } }).config
    assert.deepEqual(limitLines(off.limits), [])
    assert.ok(!supervisorBrief({ repo: 'acme/app', objective: 'x', tag: 't', base: 'main', config: off }).includes('Limits in this project'))
    assert.equal(limitsChanged(defaults(), defaults()), false)
    assert.equal(limitsChanged(defaults(), { ...defaults(), maxConcurrentReviews: 5 }), false, 'reviews at once are not the supervisor’s')
    assert.equal(limitsChanged(defaults(), config.limits), true)
    assert.match(limitsMessage(config.limits).body, /at most 3 workers running at once/)
    assert.match(limitsMessage(off.limits).body, /turned the worker limits off/)
  })
})

function engine(rows: WorkerRow[], over: Partial<EngineDeps> = {}) {
  const store = new Map<string, unknown>([['supervisor:terminal:acme/app', 'term_sup']])
  let now = T0
  const github: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
  const seen: LimitState[] = []
  const projects: string[][] = []
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
    onProjects: (repos) => projects.push(repos),
    ...over
  }
  return { deps, seen, projects, advance: (ms: number) => (now += ms) }
}

const row = (id: string, over: Partial<WorkerRow> = {}): WorkerRow => ({ dispatchId: id, worktreeId: `ws-${id}`, taskId: 't', runId: 'r1', agent: 'codex', model: null, state: 'running', live: true, liveness: 'live', terminal: `term_${id}`, ...over })

describe('each tick', () => {
  test("counts the supervisor's running workers for its row and the hook, with their terminals", async () => {
    const rows = [row('d1'), row('d2', { live: false, liveness: 'exited' }), row('d3', { state: 'succeeded' }), row('d4', { runId: 'other' }), row('d5', { live: false, liveness: 'unverifiable' })]
    const e = engine(rows)
    const board = await tick(e.deps, { autopilot: false })
    const sup = board.repos[0].supervisor
    assert.deepEqual([sup.workers, sup.live, sup.maxWorkers, sup.startsToday, sup.maxStarts], [4, 2, 2, 0, 3])
    assert.equal(e.seen[0].live, 2)
    assert.deepEqual(e.seen[0].terminals, ['term_sup', 'term_d1', 'term_d2', 'term_d3', 'term_d5'], 'only its own Run')
    assert.equal(e.seen[0].listedAt, T0)
    assert.deepEqual(e.projects, [['acme/app']])
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

  test('hands nothing to the hook while it cannot see the workers, and forgets nothing while it cannot see the workspaces', async () => {
    const blind = engine([], { workers: async () => { throw new Error('runtime_unavailable') } })
    await tick(blind.deps, { autopilot: false })
    assert.deepEqual(blind.seen, [])
    assert.deepEqual(blind.projects, [['acme/app']], 'the project is still there')
    const down = engine([], { workspaces: async () => { throw new Error('runtime_unavailable') } })
    await tick(down.deps, { autopilot: false })
    assert.deepEqual(down.projects, [], 'a tick that saw no workspaces says nothing about projects')
  })
})

test("the worker refuses a Claude supervisor's start over the cap, keeps refusing after a restart, and leaves the person's own sessions alone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'matriarch-limits-'))
  await mkdir(join(root, '.orca'), { recursive: true })
  await writeFile(join(root, CONFIG_PATH), JSON.stringify({ version: 1 }))
  const orcaCli = {
    run: async (args: readonly string[]) => {
      if (args[1] === 'worker-list') return { workers: [1, 2, 3, 4].map((n) => ({ dispatchId: `d${n}`, runId: 'r1', agentTerminalHandle: `term_w${n}`, resource: { worktreeId: `w${n}` }, workerState: 'running' })) }
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
  const mount = (storage: Record<string, JsonValue>) => {
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
      results: {
        'workspace.list': { workspaces: [{ id: 'ws-main', kind: 'worktree', name: 'main', path: root, branch: 'refs/heads/main', hostId: 'local' }], truncated: false },
        'statusBar.update': { ok: true }
      },
      settings: { autopilot: false, pollSeconds: 45 },
      storage
    })
    return mountWorker({ default: createWorker({ exec, github, orcaCli, autoStart: false }), deactivate }, {
      host,
      events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
      commands: ['showBoard', 'refresh', 'toggleAutopilot'],
      hooks: ['agent.tool.before', 'agent.launch.before']
    })
  }
  const event = (terminalId: string) => ({ agent: 'claude', workspaceId: `repo1::${root}`, terminalId, tool: 'Bash', input: { command: start } })
  const worker = await mount({ 'supervisor:acme/app': 'run:r1', 'supervisor:terminal:acme/app': 'term_sup' })
  let storage: Record<string, unknown> = {}
  try {
    assert.equal((await worker.hooks.fire('agent.tool.before', event('term_sup'))).kind, 'continue', 'nothing counted yet')
    await worker.command('refresh')
    const refused = await worker.hooks.fire('agent.tool.before', event('term_sup'))
    assert.equal(refused.kind, 'deny')
    assert.match(refused.kind === 'deny' ? refused.reason : '', /4 of 4 workers are running/)
    assert.equal((await worker.hooks.fire('agent.tool.before', event('term_w2'))).kind, 'deny', 'a worker of its Run')
    assert.equal((await worker.hooks.fire('agent.tool.before', event('term_mine'))).kind, 'continue', "the person's own session")
    assert.ok(worker.logs.some((l) => l.includes('refused a worker start by claude')))
    storage = worker.host.data().storage
  } finally {
    await worker.deactivate()
  }
  const again = await mount(storage as Record<string, JsonValue>)
  try {
    await new Promise((r) => setTimeout(r, 20))
    assert.equal((await again.hooks.fire('agent.tool.before', event('term_sup'))).kind, 'deny', 'before its first tick, from storage')
  } finally {
    await again.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

describe('a worker that started over a limit', () => {
  const w = (id: string, over: Partial<WorkerRow> = {}): WorkerRow => ({ dispatchId: id, worktreeId: null, taskId: `t-${id}`, runId: 'r1', agent: 'codex', model: null, state: 'running', live: true, liveness: 'live', ...over })
  const input = (over: Partial<Parameters<typeof overLimitStarts>[1]> = {}) => ({ repo: 'acme/app', runningBefore: 3, startsBefore: 0, freeBytes: 100 * GB, limits: defaults(), ...over })

  test('is judged in the order they started: the first that fits stays, the next is over', () => {
    // Orca lists the newest first: d6 started after d5.
    const over = overLimitStarts([w('d6'), w('d5')], input())
    assert.deepEqual(over.map((o) => [o.dispatchId, o.limit]), [['d6', 'workers']])
    assert.match(over[0].reason, /started while 4 of 4 workers were running in acme\/app/)
    const daily = overLimitStarts([w('d3'), w('d2')], input({ runningBefore: 0, startsBefore: 4, limits: { ...defaults(), maxWorkerStartsPerDay: 5 } }))
    assert.deepEqual(daily.map((o) => [o.dispatchId, o.limit]), [['d3', 'day']])
    assert.deepEqual(overLimitStarts([w('d2')], input({ runningBefore: 0, freeBytes: 2 * GB })).map((o) => o.limit), ['disk'])
    assert.deepEqual(overLimitStarts([w('d6', { state: 'succeeded' }), w('d5')], input()), [], 'one that already finished takes no room')
    assert.deepEqual(overLimitStarts([], input({ runningBefore: 9 })), [], 'workers already there are never over: only a start is')
    const m = stoppedMessage(over)
    assert.equal(m.subject, 'Stopped a worker that started over a limit')
    assert.match(m.body, /- dispatch:d6 \(task t-d6\): it started while 4 of 4/)
    assert.match(m.body, /Its task is not done, and its worktree is kept/)
  })

  // Orca names a worktree `<repoId>::<path>` in orchestration, and by an identity in its workspace list.
  const D3_WS = { id: 'identity:wt2:d3', kind: 'worktree' as const, name: 'task d3', path: '/r/wt/d3', branch: 'refs/heads/task-d3', hostId: 'local' }
  const IN_D3 = 'repo1::/r/wt/d3'

  function stopping(
    rowsByTick: WorkerRow[][],
    opts: { autopilot?: boolean; stop?: (id: string) => Promise<{ ok: boolean; error?: string }>; removed?: string[] } = {}
  ) {
    const store = new Map<string, unknown>()
    const stops: string[] = []
    const told: string[] = []
    let i = 0
    let now = T0
    const deps: EngineDeps = {
      now: () => now,
      log: () => {},
      workspaces: async () => [{ id: 'ws-main', kind: 'worktree', name: 'main', path: '/r', branch: 'refs/heads/main', hostId: 'local' }, D3_WS],
      repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
      readConfig: async () => validateConfig({ review: { enabled: false }, limits: { maxWorkers: 2, maxWorkerStartsPerDay: 3 } }),
      github: { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) },
      workers: async () => rowsByTick[Math.min(i, rowsByTick.length - 1)],
      activity: () => null,
      supervisor: async () => 'run:r1',
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      executor: { execute: async () => ({ ok: true }) },
      stopWorker: async (id) => (stops.push(id), opts.stop ? opts.stop(id) : { ok: true }),
      tellSupervisor: async (_repo, _root, _to, m) => void told.push(m.body),
      removeWorktree: async (path) => (opts.removed?.push(path), { removed: true })
    }
    const run = async () => {
      const board = await tick(deps, { autopilot: opts.autopilot ?? true })
      i++
      now += 60_000
      return board
    }
    return { run, stops, told, store, deps, advance: (ms: number) => (now += ms) }
  }

  test('under autopilot it is stopped, the supervisor is told, and it takes no room or start', async () => {
    const s = stopping([[w('d1')], [w('d3', { worktreeId: IN_D3 }), w('d2'), w('d1')]])
    await s.run()
    const board = await s.run()
    assert.deepEqual(s.stops, ['d3'], 'd2 fits under the limit of 2, d3 does not')
    // In the log of the worktree's track as the board keys it: by its workspace id, not Orca's
    // orchestration id, so the panel shows it and pruning keeps it.
    const track = board.tracks.find((t) => t.workspace.id === D3_WS.id)
    assert.equal(track?.key, D3_WS.id)
    const log = (s.store.get(`track:${D3_WS.id}`) as { log: { kind: string; text: string }[] }).log
    assert.deepEqual(log.filter((e) => e.kind === 'stop-worker').length, 1, "the stop is in that worktree's log")
    assert.match(log.find((e) => e.kind === 'stop-worker')!.text, /^Stopped this worktree's worker, which started over a limit: it started while 2 of 2/)
    assert.equal(s.store.get(`track:${IN_D3}`), undefined, 'nothing under the orchestration id')
    assert.match(s.told[0], /dispatch:d3 \(task t-d3\): it started while 2 of 2 workers were running/)
    assert.deepEqual([board.repos[0].supervisor.live, board.repos[0].supervisor.startsToday], [2, 1])
    assert.ok(board.repos[0].warnings.some((x) => x.startsWith('Stopped worker dispatch:d3')))
    assert.ok(!board.attention.some((a) => a.key === 'limits:acme/app'), 'nothing left over the limit')
  })

  test('in dry run it is only shown; the first look at a Run, and a lowered limit, stop nothing', async () => {
    const dry = stopping([[w('d1')], [w('d3'), w('d2'), w('d1')]], { autopilot: false })
    await dry.run()
    const board = await dry.run()
    assert.deepEqual(dry.stops, [])
    assert.ok(board.repos[0].warnings.some((x) => x.startsWith('Dry run: with autopilot on, Matriarch would stop worker dispatch:d3')))
    assert.match(board.attention.find((a) => a.key === 'limits:acme/app')?.message ?? '', /In dry run Matriarch only tells you/)
    const first = stopping([[w('d3'), w('d2'), w('d1')]])
    const seen = await first.run()
    assert.deepEqual(first.stops, [], 'workers there when Matriarch first looks are never stopped')
    assert.match(seen.attention.find((a) => a.key === 'limits:acme/app')?.message ?? '', /running before it looked or before the limit was lowered/)
  })

  test("the stopped worker's worktree is kept for its task, until a newer worker ran there and finished", async () => {
    const removed: string[] = []
    const stoppedRow = w('d3', { worktreeId: IN_D3, live: false, liveness: 'exited', state: 'stopped' })
    const s = stopping(
      [[w('d1')], [w('d3', { worktreeId: IN_D3 }), w('d2'), w('d1')], [stoppedRow, w('d2'), w('d1')]],
      { removed }
    )
    await s.run()
    await s.run()
    assert.deepEqual(s.stops, ['d3'])
    for (let k = 0; k < 3; k++) {
      s.advance(FINISHED_GRACE_MS)
      await s.run()
    }
    assert.ok(!removed.includes(D3_WS.path), 'its task is not done: the worktree waits for it, as the supervisor was told')
    // A newer worker took the task up there and finished: an ordinary finished worktree again.
    const later = stopping(
      [[w('d1')], [w('d3', { worktreeId: IN_D3 }), w('d2'), w('d1')], [w('d5', { worktreeId: IN_D3, live: false, liveness: 'exited', state: 'succeeded' }), stoppedRow, w('d2'), w('d1')]],
      { removed }
    )
    await later.run()
    await later.run()
    await later.run()
    later.advance(FINISHED_GRACE_MS)
    await later.run()
    assert.ok(removed.includes(D3_WS.path), 'removed once the newer worker finished there')
  })

  test('for the rest of the tick a stopped worker owns nothing: its PR gets nothing sent to it', async () => {
    const sends: { owner: string | null; ownerLive: boolean | null }[] = []
    const failing = pr({ number: 7, headRef: 'task-d3', ci: 'failing', checks: [check('test', 'failure')] })
    const s = stopping([[w('d1')], [w('d3', { worktreeId: IN_D3 }), w('d2'), w('d1')]])
    const summary = { number: 7, headRef: 'task-d3', headSha: failing.headSha, baseRef: 'main', author: failing.author, updatedAt: failing.updatedAt, rollup: 'FAILURE' }
    s.deps.github = { listOpen: async () => ({ viewer: 'me', prs: [summary], rate: null }), detail: async () => ({ pr: { ...failing, fetchedAt: T0 }, rate: null }) }
    s.deps.activity = (id) => (id === D3_WS.id ? { activity: 'done', since: 1, agent: 'codex' } : null)
    s.deps.executor = { execute: async (a, ctx) => (a.kind === 'send-ci-failure' && sends.push({ owner: ctx.owner ?? null, ownerLive: ctx.ownerLive ?? null }), { ok: true }) }
    await s.run()
    await s.run()
    assert.deepEqual(s.stops, ['d3'])
    assert.deepEqual(sends.at(-1), { owner: 'dispatch:d3', ownerLive: false }, 'so the executor sends it to the supervisor, not the stopped worker')
  })

  test('a stop that fails is tried again while the worker runs, then given up', async () => {
    let fail = true
    const s = stopping([[w('d1')], [w('d3'), w('d2'), w('d1')]], { stop: async () => (fail ? { ok: false, error: 'runtime_unavailable' } : { ok: true }) })
    await s.run()
    const failed = await s.run()
    assert.ok(failed.repos[0].errors.some((x) => /Could not stop worker dispatch:d3, which started over a limit: runtime_unavailable/.test(x)))
    fail = false
    await s.run()
    assert.deepEqual(s.stops, ['d3', 'd3'])
    assert.equal(s.told.length, 1)
    const late = stopping([[w('d1')], [w('d3'), w('d2'), w('d1')]], { stop: async () => ({ ok: false, error: 'nope' }) })
    await late.run()
    await late.run()
    late.advance(STOP_RETRY_MS)
    await late.run()
    assert.deepEqual(late.stops, ['d3'], 'not tried after the retry window')
  })
})

test("the worker stops a worker that started over the cap with worker-stop, and takes Orca's stop_unknown as done", async () => {
  const root = await mkdtemp(join(tmpdir(), 'matriarch-stop-'))
  await mkdir(join(root, '.orca'), { recursive: true })
  await writeFile(join(root, CONFIG_PATH), JSON.stringify({ version: 1, limits: { maxWorkers: 1 } }))
  let rows = 1
  const calls: string[][] = []
  const orcaCli = {
    run: async (args: readonly string[]) => {
      calls.push([...args])
      if (args[1] === 'worker-list') return { workers: Array.from({ length: rows }, (_, i) => ({ dispatchId: `d${rows - i}`, runId: 'r1', taskId: `t${rows - i}`, workerState: 'running' })) }
      if (args[1] === 'run-list') return { runs: [{ id: 'r1', objective: '[matriarch:acme/app:n] x' }] }
      if (args[1] === 'worker-stop') throw new OrcaRefusal('stop_unknown', 'agent exit not proven')
      return {}
    }
  }
  const exec = async (file: string, args: readonly string[]) => {
    if (file !== 'git') return { code: 1, stdout: '', stderr: '' }
    if (args.includes('--git-common-dir')) return { code: 0, stdout: `${root}/.git\n`, stderr: '' }
    if (args.includes('remote.origin.url')) return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: {
      'workspace.list': { workspaces: [{ id: 'ws-main', kind: 'worktree', name: 'main', path: root, branch: 'refs/heads/main', hostId: 'local' }], truncated: false },
      'statusBar.update': { ok: true }
    },
    settings: { autopilot: true, pollSeconds: 45 },
    storage: { 'supervisor:acme/app': 'run:r1', 'mailbox:acme/app': 'term_mailbox' }
  })
  const github: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
  const worker = await mountWorker({ default: createWorker({ exec, github, orcaCli, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot'],
    hooks: ['agent.tool.before', 'agent.launch.before']
  })
  try {
    await worker.command('refresh')
    rows = 2
    await worker.command('refresh')
    assert.deepEqual(calls.filter((c) => c[1] === 'worker-stop'), [['orchestration', 'worker-stop', '--dispatch', 'd2', '--json']].map((c) => c.slice(0, 4)))
    const told = calls.find((c) => c[1] === 'send' && c.includes('Stopped a worker that started over a limit'))
    assert.ok(told, 'the supervisor is told')
    assert.ok(told!.includes('run:r1'))
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
