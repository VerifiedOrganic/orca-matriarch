// The worker against Orca's mock host: requests, settings, events and the status bar.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { CONFIG_PATH } from './config.ts'
import type { Exec } from './exec.ts'
import type { GitHub } from './github.ts'
import { emptyBoard, type Board } from './protocol.ts'
import { ActivityTracker, createWorker, deactivate, failedBoard, statusText } from './worker.ts'

const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not in tests' })
const noGitHub: GitHub = {
  listOpen: async () => ({ viewer: 'me', prs: [], rate: null }),
  detail: async () => ({ pr: null, rate: null })
}

test('answers the board, toggles autopilot and updates the status bar', async () => {
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: { 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true } },
    settings: { autopilot: false, pollSeconds: 45 }
  })
  const worker = await mountWorker({ default: createWorker({ exec: noExec, github: noGitHub, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot']
  })
  const board = (await worker.request('board.refresh')) as Board
  assert.equal(board.autopilot, false)
  assert.deepEqual(board.tracks, [])

  const on = (await worker.request('autopilot.set', { on: true })) as Board
  assert.equal(on.autopilot, true)
  assert.equal(host.data().settings.autopilot, true)
  assert.ok(host.callsOf('statusBar.update').length >= 2)
  assert.ok(worker.posts.some((p) => p.event === 'board.changed'))

  await worker.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'p1', state: 'working', receivedAt: 5 })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('activity folds panes into one state per workspace', () => {
  const a = new ActivityTracker()
  a.note('p1', 'ws1', 'done', 1)
  a.note('p2', 'ws1', 'working', 2)
  a.note('p3', 'ws2', 'waiting', 3)
  assert.equal(a.forWorkspace('ws1')?.activity, 'working')
  assert.equal(a.forWorkspace('ws2')?.activity, 'waiting')
  assert.equal(a.forWorkspace('none'), null)
  // An agent event names the worktree `<repoId>::<path>`; the workspace list names it by identity.
  a.note('p4', 'repo1::/w/p0', 'working', 4)
  assert.equal(a.forWorkspace('identity:wt2:local:x', 5, '/w/p0')?.activity, 'working')
})

test('activity takes an agent in a terminal whose worker Orca saw exit as done, whatever it last said', () => {
  const a = new ActivityTracker()
  // A worker stopped mid-turn never said it was done.
  a.note('p-stopped', 'ws1', 'working', 1, 'term_stopped')
  assert.equal(a.forWorkspace('ws1', 5)?.activity, 'working')
  assert.deepEqual(a.forWorkspace('ws1', 5, undefined, new Set(['term_stopped'])), { activity: 'done', since: 1, agent: null })
  // Another agent there still counts as it says, and so does one whose events named no terminal.
  a.note('p-next', 'ws1', 'waiting', 2, 'term_next')
  a.note('p-unnamed', 'ws2', 'working', 3)
  assert.equal(a.forWorkspace('ws1', 5, undefined, new Set(['term_stopped']))?.activity, 'waiting')
  assert.equal(a.forWorkspace('ws1', 5, undefined, new Set(['term_stopped', 'term_next']))?.activity, 'done')
  assert.equal(a.forWorkspace('ws2', 5, undefined, new Set(['term_stopped']))?.activity, 'working')
  // An event that names no terminal keeps the one the pane was heard in.
  a.note('p-stopped', 'ws1', 'blocked', 6)
  assert.equal(a.forWorkspace('ws1', 7)?.activity, 'waiting')
  assert.equal(a.forWorkspace('ws1', 7, undefined, new Set(['term_stopped', 'term_next']))?.activity, 'done')
  // A state heard again that only names its terminal is worth saving, and still began when first heard.
  a.note('p-prompt', 'ws3', 'blocked', 10)
  assert.equal(a.note('p-prompt', 'ws3', 'blocked', 20, 'term_prompt'), true)
  assert.equal(a.note('p-prompt', 'ws3', 'blocked', 30, 'term_prompt'), false)
  assert.equal(a.forWorkspace('ws3', 40)?.since, 10)
})

test("activity keeps each pane's terminal across a restart, and loads state saved before it did", () => {
  const now = 1_000_000
  const before = new ActivityTracker()
  before.note('p1', 'ws1', 'working', now - 60_000, 'term_a')
  before.note('p2', 'ws1', 'waiting', now - 30_000)
  const saved = JSON.parse(JSON.stringify(before.serialize()))
  assert.deepEqual(saved, {
    p1: { workspaceId: 'ws1', state: 'working', at: now - 60_000, terminal: 'term_a' },
    p2: { workspaceId: 'ws1', state: 'waiting', at: now - 30_000 }
  })
  const after = new ActivityTracker()
  after.restore(saved, now)
  assert.equal(after.forWorkspace('ws1', now)?.activity, 'working')
  assert.equal(after.forWorkspace('ws1', now, undefined, new Set(['term_a']))?.activity, 'waiting')
  // Saved by a version that kept no terminals (and saved its restored flag): judged as before.
  const old = new ActivityTracker()
  old.restore({ p1: { workspaceId: 'ws1', state: 'working', at: now - 60_000, restored: true } }, now)
  assert.equal(old.forWorkspace('ws1', now, undefined, new Set(['term_a']))?.activity, 'working')
})

test('the status bar text counts lanes and says when it is a dry run', () => {
  const base = { ready: true, at: 0, autopilot: false, since: 0, repos: [], errors: [], attention: [], rate: null }
  const t = (lane: Board['tracks'][number]['lane']) => ({ lane }) as Board['tracks'][number]
  const s = statusText({ ...base, tracks: [t('needs-you'), t('working'), t('building'), t('fixing-ci')] })
  assert.equal(s.text, 'Matriarch 1 need you · 1 fixing · 2 running (dry run)')
  assert.equal(s.tone, 'danger')
})

test('a check that fails outright says so on the board and in the status bar, and a good one clears it', async () => {
  let broken = false
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: {
      'workspace.list': { workspaces: [], truncated: false },
      'statusBar.update': { ok: true },
      // The autopilot switch is read first in every check: once Orca cannot answer, the check throws.
      'settings.get': () => {
        if (broken) throw hostError('settings_unavailable', 'settings went away')
        return { settings: { autopilot: false, pollSeconds: 45 } }
      }
    }
  })
  const worker = await mountWorker({ default: createWorker({ exec: noExec, github: noGitHub, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot']
  })
  const good = (await worker.request('board.refresh')) as Board
  assert.ok(!good.errors.some((e) => e.startsWith("Matriarch's last check failed")))
  broken = true
  const failed = (await worker.request('board.refresh')) as Board
  assert.ok(failed.errors.some((e) => e.startsWith("Matriarch's last check failed") && e.includes('it tries again by itself')), failed.errors.join(' | '))
  const last = host.callsOf('statusBar.update').at(-1) as { text?: string; tone?: string } | undefined
  assert.deepEqual([last?.text, last?.tone], ['Matriarch: check failed', 'warning'])
  broken = false
  const again = (await worker.request('board.refresh')) as Board
  assert.ok(!again.errors.some((e) => e.startsWith("Matriarch's last check failed")))
  await worker.deactivate()
})

test("the status bar tooltip fits Orca's 256 characters, whatever the problems say", () => {
  const board: Board = { ...emptyBoard(0), ready: true, errors: Array.from({ length: 6 }, (_, i) => `acme/app${i}: ${'a long problem '.repeat(6)}`) }
  const s = statusText(board)
  assert.ok(s.tooltip.length <= 256, `${s.tooltip.length}`)
  assert.ok(s.tooltip.startsWith('Dry run: watching, not acting'), 'the mode before the problems')
  assert.ok(failedBoard(board, new Error('x'.repeat(400))).status.tooltip.length <= 256)
  // And the text fits its 64, with every lane group counted.
  const lanes = ['needs-you', 'fixing-ci', 'ai-review', 'working', 'awaiting-ci', 'ready'] as const
  const busy: Board = { ...board, autopilot: true, tracks: lanes.map((lane, i) => ({ key: `k${i}`, repo: 'acme/app', lane })) as unknown as Board['tracks'] }
  assert.ok(statusText(busy).text.length <= 64, statusText(busy).text)
  assert.ok(statusText({ ...busy, autopilot: false }).text.length <= 64)
})

test('a failed check leaves the last board up, saying so and how old it is, until a good one replaces it', () => {
  const last: Board = { ...emptyBoard(Date.UTC(2026, 10, 18, 9, 30)), ready: true, errors: ['acme/app: something else'] }
  const once = failedBoard(last, new Error('orca workspace.list timed out\n    at stack line'))
  assert.equal(once.board.errors[0], 'acme/app: something else')
  assert.match(once.board.errors[1], /^Matriarch's last check failed: orca workspace\.list timed out\. What shows here is from \d{1,2}:\d{2}.*; it tries again by itself\.$/)
  assert.deepEqual([once.status.text, once.status.tone], ['Matriarch: check failed', 'warning'])
  assert.equal(once.board.at, last.at, 'still the time of the last good check')
  // Failing again replaces the line rather than adding one.
  const twice = failedBoard(once.board, new Error('again'))
  assert.equal(twice.board.errors.length, 2)
  assert.match(twice.board.errors[1], /failed: again\./)
  // Before any check worked, there is no time to give.
  assert.match(failedBoard(emptyBoard(0), 'boom').board.errors[0], /Nothing has been checked yet/)
  // A full disk says what to do, in red, and replaces a failed-check line.
  const full = failedBoard(twice.board, Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
  assert.equal(full.board.errors.length, 2)
  assert.match(full.board.errors[1], /^The disk is full: .*Free some space/)
  assert.deepEqual([full.status.text, full.status.tone], ['Matriarch: disk full', 'danger'])
})

test('the status bar click opens what needs you, before the board', async () => {
  const calls: string[][] = []
  const orcaCli = { run: async (args: readonly string[]) => (calls.push([...args]), {}) }
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: { 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'commands.run': { ran: true } },
    settings: { autopilot: false, pollSeconds: 45 }
  })
  const worker = await mountWorker({ default: createWorker({ exec: noExec, github: noGitHub, orcaCli, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot']
  })
  // No attention: it shows the sidebar.
  await worker.command('showBoard')
  assert.equal(host.callsOf('commands.run').length, 1)
  // The panel's Open it button and the status bar both switch to the stuck terminal.
  assert.deepEqual(await worker.request('terminal.focus', { handle: 'term-x' }), { opened: true })
  assert.deepEqual(calls.at(-1), ['terminal', 'switch', '--terminal', 'term-x'])
  await worker.deactivate()
})

test("an agent's status event is tied to its worker by terminal, so a worker Orca saw exit no longer works", async () => {
  const root = await mkdtemp(join(tmpdir(), 'matriarch-activity-'))
  await mkdir(join(root, '.orca'), { recursive: true })
  await writeFile(join(root, CONFIG_PATH), JSON.stringify({ version: 1 }))
  const path = join(root, 'wt', 'x')
  let verdict = 'live'
  const orcaCli = {
    run: async (args: readonly string[]) =>
      args[1] === 'worker-list'
        ? { workers: [{ dispatchId: 'd1', runId: 'r1', workerState: verdict === 'live' ? 'running' : 'stopped', agentTerminalHandle: 'term_w', resource: { worktreeId: `repo1::${path}` }, projection: { liveness: { verdict } } }] }
        : {}
  }
  const exec: Exec = async (file, args) => {
    if (file !== 'git') return { code: 1, stdout: '', stderr: '' }
    if (args.includes('--git-common-dir')) return { code: 0, stdout: `${root}/.git\n`, stderr: '' }
    if (args.includes('remote.origin.url')) return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: {
      'workspace.list': { workspaces: [{ id: 'ws-x', kind: 'worktree', name: 'x', path, branch: 'refs/heads/x', hostId: 'local' }], truncated: false },
      'statusBar.update': { ok: true }
    },
    settings: { autopilot: false, pollSeconds: 45 }
  })
  const worker = await mountWorker({ default: createWorker({ exec, github: noGitHub, orcaCli, autoStart: false }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot']
  })
  const lane = async () => ((await worker.request('board.refresh')) as Board).tracks.find((t) => t.key === 'ws-x')?.lane
  try {
    await worker.emit('agent.status.changed', { workspaceId: `repo1::${path}`, paneKey: 'tab1:leaf1', terminalId: 'term_w', state: 'working', receivedAt: Date.now() })
    assert.equal(await lane(), 'building')
    // Stopped mid-turn, its agent never says it is done.
    verdict = 'exited'
    assert.equal(await lane(), 'idle')
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
