// The activity log: what Matriarch did on a track and why, recorded only for what it carried out.
import type { JsonValue } from 'orca/host'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { logEntry, markEntry } from './activity.ts'
import { validateConfig } from './config.ts'
import { describe as plannedAs, tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Exec } from './exec.ts'
import type { Executor, Outcome } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { addLog, emptyHistory, historyKey, loadHistory, noteLane, prune } from './history.ts'
import type { Action } from './plan.ts'
import { check, pr, SHA } from './testing/fixtures.ts'
import { createWorker, deactivate } from './worker.ts'

const T0 = 1_800_000_000_000

describe('the log in a track history', () => {
  test('a new lane goes in with its reason; a new reason in the same lane does not', () => {
    let h = noteLane(emptyHistory(), 'awaiting-ci', 'CI running', 100)
    h = noteLane(h, 'awaiting-ci', 'CI running (2 of 3 checks done)', 200)
    h = noteLane(h, 'fixing-ci', 'CI failing on abc: test', 300)
    assert.deepEqual(h.log.map((e) => [e.kind, e.lane, e.text]), [['lane', 'awaiting-ci', 'CI running'], ['lane', 'fixing-ci', 'CI failing on abc: test']])
  })

  test('is pruned to the window and capped, and an older history without one reads as empty', () => {
    let h = emptyHistory()
    for (let i = 0; i < 400; i++) h = addLog(h, { at: i, kind: 'push', text: `commit ${i}` })
    const kept = prune(h, 1000, 700)
    assert.equal(kept.log.length, 100, 'only what is in the window')
    assert.equal(kept.log[0].text, 'commit 300')
    assert.equal(prune(h, 400, 10_000).log.length, 300, 'capped')
    assert.deepEqual(loadHistory({ v: 1, segments: [], marks: [] }).log, [])
  })
})

describe('log lines', () => {
  const send: Action = { kind: 'send-ci-failure', to: 'dispatch:d1', sha: SHA, round: 1, checks: [check('test', 'failure')], signature: 'test' }

  test('a message says who it went to, its subject, and why it went to the supervisor', () => {
    const direct = logEntry(send, { ok: true, sent: { to: 'worker', subject: 'CI failed on #12' } }, 5, 'github', plannedAs(send))
    assert.deepEqual(direct, { at: 5, kind: 'send-ci-failure', text: 'Sent the worker 1 failing check (test), round 1', to: 'worker', subject: 'CI failed on #12' })
    const relayed = logEntry(send, { ok: true, sent: { to: 'supervisor', subject: '#12 needs a follow-up', note: 'its worker had finished, so the supervisor got it' } }, 5, 'github', plannedAs(send))
    assert.equal(relayed.text, 'Sent the supervisor 1 failing check (test), round 1 (its worker had finished, so the supervisor got it)')
  })

  test('a failure says what was tried and why it failed', () => {
    const merge: Action = { kind: 'merge', sha: SHA, method: 'squash' }
    const e = logEntry(merge, { ok: false, error: 'the base branch moved' }, 5, 'github', plannedAs(merge))
    assert.equal(e.text, 'Tried to merge a1b2c3d (squash)')
    assert.equal(e.error, 'the base branch moved')
    assert.equal(logEntry(merge, { ok: true }, 5, 'gitlab', plannedAs(merge, 'gitlab')).text, 'Asked GitLab to merge a1b2c3d (squash)')
  })

  test('a branch update the forge cannot do reads as a request to the worker', () => {
    const update: Action = { kind: 'update-branch', sha: SHA, method: 'merge' }
    const e = logEntry(update, { ok: true, sent: { to: 'worker', subject: '#12 is behind main' } }, 5, 'gitlab', plannedAs(update, 'gitlab'))
    assert.equal(e.text, 'Asked the worker to merge its base in (GitLab cannot)')
  })

  test('an action it has no words for shows up by its kind', () => {
    const unknown = { kind: 'teleport', base: 'main' } as unknown as Action
    assert.equal(logEntry(unknown, { ok: true }, 5, 'github', 'teleport').text, 'teleport')
  })

  test('a stacked PR moved and rebased, and a flaky check run again, say what happened and why', () => {
    const retarget: Action = { kind: 'retarget', sha: SHA, parent: 11, from: 'feat/a', base: 'main' }
    assert.equal(logEntry(retarget, { ok: true }, 5, 'github', plannedAs(retarget)).text, 'Moved the PR from feat/a onto main: #11, which it was stacked on, merged')
    assert.equal(logEntry(retarget, { ok: true }, 5, 'gitlab', plannedAs(retarget, 'gitlab')).text, 'Moved the merge request from feat/a onto main: #11, which it was stacked on, merged')
    const restack: Action = { kind: 'send-restack', to: 'dispatch:d1', sha: SHA, parent: 11, parentSha: SHA, base: 'main' }
    assert.match(logEntry(restack, { ok: true, sent: { to: 'worker', subject: '#12: rebase off #11' } }, 5, 'github', plannedAs(restack)).text, /^Asked the worker to rebase off #11's commits onto main, now that #11 merged/)
    const rerun: Action = { kind: 'rerun-check', sha: SHA, checks: [check('test', 'failure'), check('lint', 'failure')], why: 'the runner lost connection' }
    assert.equal(logEntry(rerun, { ok: true }, 5, 'github', plannedAs(rerun)).text, 'Re-ran test, lint once: the runner lost connection')
  })

  test('a new commit and a finished review read as what came in', () => {
    assert.equal(markEntry({ at: 1, kind: 'push', label: 'pushed abc1234' }).text, 'New commit: abc1234')
    assert.equal(markEntry({ at: 1, kind: 'review-done', label: '2 of 2 approve' }).text, 'AI review finished: 2 of 2 approve')
  })
})

function harness(prs: PrSnapshot[], reply: (a: Action) => Outcome) {
  const store = new Map<string, unknown>()
  let now = T0
  const github: GitHub = {
    async listOpen() {
      return { viewer: 'me', rate: null, prs: prs.map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: p.author, updatedAt: p.updatedAt, rollup: p.ci })) }
    },
    async detail(_repo, number) {
      const p = prs.find((x) => x.number === number)
      return { pr: p ? { ...p, fetchedAt: now } : null, rate: null }
    }
  }
  const executor: Executor = { execute: async (a) => reply(a) }
  const workspaces: Workspace[] = [{ id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }]
  const deps: EngineDeps = {
    now: () => now,
    log: () => {},
    workspaces: async () => workspaces,
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig({ review: { enabled: false } }),
    github,
    workers: async () => [{ dispatchId: 'd-login', worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: 'codex', model: null, state: 'idle' }],
    activity: () => null,
    supervisor: async () => 'run:r1',
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor
  }
  return { deps, log: () => loadHistory(store.get(historyKey('ws-login'))).log, advance: (ms: number) => (now += ms) }
}

describe('the engine', () => {
  const failing = pr({ number: 12, ci: 'failing', checks: [check('test', 'failure')] })

  test('logs the lane, then what it sent and to whom, under autopilot', async () => {
    const h = harness([failing], () => ({ ok: true, sent: { to: 'worker', subject: 'CI failed on #12 (a1b2c3d), round 1/3' } }))
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.log().map((e) => e.kind), ['lane', 'send-ci-failure'])
    assert.equal(h.log()[1].subject, 'CI failed on #12 (a1b2c3d), round 1/3')
    assert.equal(h.log()[1].to, 'worker')
  })

  test('in dry run, logs the lane but not what it would do', async () => {
    const h = harness([failing], () => ({ ok: true }))
    const board = await tick(h.deps, { autopilot: false })
    assert.ok(board.tracks[0].next.length > 0, 'the board says what it would do')
    assert.deepEqual(h.log().map((e) => e.kind), ['lane'])
  })

  test('logs a failed action with its error, and not one it skipped on purpose', async () => {
    const failed = harness([failing], () => ({ ok: false, error: 'Orca refused the message' }))
    await tick(failed.deps, { autopilot: true })
    const e = failed.log().find((x) => x.kind === 'send-ci-failure')
    assert.equal(e?.error, 'Orca refused the message')
    assert.match(e?.text ?? '', /^Tried to send 1 failing check/)
    const skipped = harness([failing], () => ({ ok: false, skipped: 'not built yet' }))
    await tick(skipped.deps, { autopilot: true })
    assert.deepEqual(skipped.log().map((x) => x.kind), ['lane'])
  })
})

describe('the track.log request', () => {
  test('answers a track\'s log newest first, as plain JSON', async () => {
    const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not in tests' })
    const noGitHub: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
    const history = { v: 1, segments: [], marks: [], log: [{ at: 1, kind: 'lane', lane: 'working', text: 'the worker is building it' }, { at: 2, kind: 'push', text: 'New commit: abc1234' }] }
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
      results: { 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true } },
      settings: { autopilot: false, pollSeconds: 45 },
      storage: { [historyKey('ws-login')]: history as unknown as JsonValue }
    })
    const worker = await mountWorker({ default: createWorker({ exec: noExec, github: noGitHub, autoStart: false }), deactivate }, {
      host,
      events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
      commands: ['showBoard', 'refresh', 'toggleAutopilot']
    })
    const res = (await worker.request('track.log', { key: 'ws-login' })) as { key: string; entries: { text: string }[] }
    assert.deepEqual(res.entries.map((e) => e.text), ['New commit: abc1234', 'the worker is building it'])
    assert.deepEqual((await worker.request('track.log', { key: 'nothing-here' })) as unknown, { key: 'nothing-here', entries: [] })
    await worker.deactivate()
  })
})
