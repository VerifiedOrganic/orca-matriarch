// The worker against Orca's mock host: requests, settings, events and the status bar.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
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
