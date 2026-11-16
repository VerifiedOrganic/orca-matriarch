// The worker against Orca's mock host: requests, settings, events and the status bar.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { CONFIG_PATH } from './config.ts'
import type { Exec } from './exec.ts'
import type { GitHub } from './github.ts'
import type { Board } from './protocol.ts'
import { ActivityTracker, createWorker, deactivate, statusText } from './worker.ts'

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
