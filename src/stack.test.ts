// Stacked PRs: a PR whose base is another PR's branch merges only after it, is moved to where
// its parent merged, and is rebased off the parent's commits before it merges itself.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Exec, ExecResult } from './exec.ts'
import { createExecutor, type Executor } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { normalizeMr } from './gitlab.ts'
import { emptyLedger, ledgerKey, loadLedger, record, type PrLedger, type StackParent } from './ledger.ts'
import { restackMessage } from './messages.ts'
import { createOrcaCli } from './orca-cli.ts'
import { plan, restackCommand, type Action } from './plan.ts'
import { config, input, owner, pr, SHA } from './testing/fixtures.ts'
import { detailData, fakeGlab, HOST, KEY, REPO } from './testing/gitlab.ts'

const PARENT_SHA = 'f00dfeed00000000000000000000000000000000'
const NEW_SHA = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
const kinds = (actions: Action[]) => actions.map((a) => a.kind)
// A review that passed and was already posted, so these tests see only the stack and merge steps.
const passed = (l: PrLedger = emptyLedger(), sha = SHA): PrLedger => ({ ...l, reviews: { [sha]: { round: 1, status: 'done', startedAt: 1, verdict: 'pass', published: true } } })
const parent = (over: Partial<StackParent> = {}): StackParent => ({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA, baseRef: 'main', state: 'OPEN', ...over })
const child = pr({ number: 12, baseRef: 'feature/auth' })
const auto = config((c) => (c.merge.mode = 'auto'))

describe('planning a stacked PR', () => {
  test('while its parent is open it goes through CI and review, then waits to merge, in both merge modes', () => {
    for (const cfg of [auto, config()]) {
      const p = plan(input({ pr: child, config: cfg, stack: parent() }, passed()))
      assert.equal(p.lane, 'ready')
      assert.equal(p.reason, 'stacked on #11; merges after it')
      assert.deepEqual(p.actions, [], 'no merge and no "ready to merge" notification')
    }
    // Review still runs on it.
    const fresh = plan(input({ pr: child, config: config((c) => (c.merge.mode = 'auto')), stack: parent() }))
    assert.deepEqual(kinds(fresh.actions), ['start-review'])
    // A PR into a branch no PR has is not stacked: it merges as usual.
    assert.deepEqual(kinds(plan(input({ pr: pr({ baseRef: 'release/2' }), config: auto, stack: null }, passed())).actions), ['merge'])
  })

  test('once its parent merged it is moved to where the parent went, when the forge left it on the parent branch', () => {
    const merged = parent({ state: 'MERGED', headAtMerge: SHA })
    const p = plan(input({ pr: child, config: auto, stack: merged }, passed()))
    assert.equal(p.lane, 'awaiting-ci')
    assert.deepEqual(p.actions, [{ kind: 'retarget', sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }])
    // Moved already, the forge not showing it yet: nothing again.
    const after = plan(input({ pr: child, config: auto, stack: merged }, record(passed(), p.actions[0], 5)))
    assert.deepEqual(after.actions, [])
    assert.match(after.reason, /base moved to main/)
    // Even while its worker is busy: it is the forge's change, not the worker's.
    assert.deepEqual(kinds(plan(input({ pr: child, owner: owner({ activity: 'working' }), stack: merged }, passed())).actions), ['retarget'])
  })

  test('then its worker is asked once to rebase off the parent commits, and it merges once that is pushed', () => {
    const merged = parent({ state: 'MERGED', headAtMerge: SHA })
    const moved = pr({ number: 12, baseRef: 'main' })
    const ask = plan(input({ pr: moved, config: auto, stack: merged }, passed()))
    assert.equal(ask.lane, 'fixing-conflict')
    assert.deepEqual(ask.actions, [{ kind: 'send-restack', to: 'dispatch:d1', sha: SHA, parent: 11, parentSha: PARENT_SHA, base: 'main' }])
    // Asked: it waits, without asking again, and the board says the worker is rebasing while it works.
    const asked = record(passed(), ask.actions[0], 5)
    const waiting = plan(input({ pr: moved, config: auto, stack: merged }, asked))
    assert.deepEqual(waiting.actions, [])
    assert.match(waiting.reason, /waiting for the branch to be rebased/)
    const busy = plan(input({ pr: moved, owner: owner({ activity: 'working' }), stack: merged }, asked))
    assert.equal(busy.lane, 'fixing-conflict')
    assert.match(busy.reason, /rebasing it onto main, off the commits of #11/)
    // Pushed: a new head, reviewed, merges like any PR.
    const pushed = pr({ number: 12, baseRef: 'main', headSha: NEW_SHA })
    assert.deepEqual(kinds(plan(input({ pr: pushed, config: auto, stack: merged }, passed(asked, NEW_SHA))).actions), ['merge'])
  })

  test('with no worker on the branch, the supervisor is given the command', () => {
    const merged = parent({ state: 'MERGED', headAtMerge: SHA })
    const p = plan(input({ pr: pr({ number: 12, baseRef: 'main' }), owner: null, supervisor: 'run:r1', stack: merged }, passed()))
    assert.deepEqual(kinds(p.actions), ['escalate'])
    const a = p.actions[0]
    assert.ok(a.kind === 'escalate' && a.to === 'supervisor' && a.reason.includes(restackCommand('main', PARENT_SHA)))
  })

  test('a parent that closed without merging needs you, once', () => {
    const closed = parent({ state: 'CLOSED' })
    const p = plan(input({ pr: child, config: auto, stack: closed }, passed()))
    assert.equal(p.lane, 'needs-you')
    assert.equal(p.reason, 'stacked on #11, which closed without merging: retarget it or close it')
    assert.deepEqual(kinds(p.actions), ['notify'])
    assert.deepEqual(plan(input({ pr: child, config: auto, stack: closed }, record(passed(), p.actions[0], 5))).actions, [])
  })

  test('the rebase message names only the branch commits, onto the new base', () => {
    const m = restackMessage(pr({ number: 12, baseRef: 'main' }), 11, PARENT_SHA, 'main')
    assert.match(m.subject, /#11 merged: rebase #12 onto main/)
    assert.ok(m.body.includes(`git fetch origin && git rebase --onto origin/main ${PARENT_SHA} && git push --force-with-lease`))
  })

  test('the ledger keeps the parent, and a damaged one loads without it', () => {
    const kept = loadLedger(JSON.parse(JSON.stringify({ ...emptyLedger(), stack: parent({ state: 'MERGED', headAtMerge: SHA }) })))
    assert.deepEqual(kept.stack, parent({ state: 'MERGED', headAtMerge: SHA }))
    assert.equal(loadLedger({ stack: { number: 'x' } }).stack, undefined)
  })
})

describe('an engine tick over stacked PRs', () => {
  const T0 = 1_800_000_000_000
  const workspaces: Workspace[] = [
    { id: 'ws-auth', kind: 'worktree', name: 'auth', path: '/r/wt/auth', branch: 'feature/auth', hostId: null },
    { id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }
  ]
  function harness(prs: PrSnapshot[]) {
    const store = new Map<string, unknown>()
    const executed: Action[] = []
    let now = T0
    const github: GitHub = {
      async listOpen() {
        return { viewer: 'me', rate: null, prs: prs.filter((p) => p.state === 'OPEN').map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, baseRef: p.baseRef, author: p.author, updatedAt: p.updatedAt, rollup: p.ci })) }
      },
      async detail(_repo, number) {
        const p = prs.find((x) => x.number === number)
        return { pr: p ? { ...p, fetchedAt: now } : null, rate: null }
      }
    }
    const executor: Executor = { execute: async (a) => (executed.push(a), { ok: true }) }
    const deps: EngineDeps = {
      now: () => now,
      log: () => {},
      workspaces: async () => workspaces,
      repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
      readConfig: async () => validateConfig({ review: { enabled: false }, merge: { mode: 'auto' } }),
      github,
      workers: async () => [
        { dispatchId: 'd-auth', worktreeId: 'ws-auth', taskId: 't1', runId: 'r1', agent: 'codex', model: null, state: 'idle' },
        { dispatchId: 'd-login', worktreeId: 'ws-login', taskId: 't2', runId: 'r1', agent: 'codex', model: null, state: 'idle' }
      ],
      activity: () => null,
      supervisor: async () => 'run:r1',
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), keys: async () => [...store.keys()] },
      executor
    }
    return { deps, store, executed, advance: (ms: number) => (now += ms) }
  }

  test('the parent merges first; the child is moved, asked to rebase, and merges after its push', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA, title: 'Auth' })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    const first = await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => [a.kind, a.kind === 'merge' ? a.sha : null]), [['merge', PARENT_SHA]], 'only the parent merges')
    const card = first.tracks.find((t) => t.pr?.number === 12)!
    assert.equal(card.lane, 'ready')
    assert.equal(card.pr?.stackedOn, 11)
    assert.equal((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).stack?.number, 11)

    // The parent merged, its branch kept: the child still points at it, and is moved.
    prs[0] = { ...auth, state: 'MERGED' }
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed, [{ kind: 'retarget', sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }])
    const st = (h.store.get(ledgerKey('acme/app', 12)) as PrLedger).stack
    assert.equal(st?.state, 'MERGED')
    assert.equal(st?.headAtMerge, SHA)

    // The forge shows the new base: its worker is asked to rebase off the parent's commits.
    prs[1] = { ...login, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.executed.length = 0
    h.advance(60_000)
    const moved = await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed, [{ kind: 'send-restack', to: 'dispatch:d-login', sha: SHA, parent: 11, parentSha: PARENT_SHA, base: 'main' }])
    assert.equal(moved.tracks.find((t) => t.pr?.number === 12)?.pr?.stackedOn, undefined, 'no longer on the parent branch')

    // Nothing more until it is pushed; then it merges.
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.equal(h.executed.length, 0)
    prs[1] = { ...prs[1], headSha: NEW_SHA, updatedAt: '2026-11-10T12:00:00Z' }
    h.advance(5 * 60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => [a.kind, a.kind === 'merge' ? a.sha : null]), [['merge', NEW_SHA]])
  })

  test('a parent Matriarch never followed is looked up once it leaves the open list', async () => {
    // Someone else's PR #11 (not from an Orca worktree, so not followed), with #12 on top of it.
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA, author: 'alice' })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    await tick(h.deps, { autopilot: false })
    assert.equal((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).stack?.number, 11)
    // It merged and GitHub moved #12 to main as the branch went: #12 still carries its commits.
    prs[0] = { ...auth, state: 'MERGED' }
    prs[1] = { ...login, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.advance(60_000)
    const board = await tick(h.deps, { autopilot: false })
    const card = board.tracks.find((t) => t.pr?.number === 12)!
    assert.equal(card.lane, 'fixing-conflict')
    assert.match(card.next[0], /rebase onto main, off the commits of #11/)
  })

  test('a PR moved off a parent that is still open is not stacked any more', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    await tick(h.deps, { autopilot: false })
    prs[1] = { ...login, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.advance(60_000)
    await tick(h.deps, { autopilot: false })
    assert.equal((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).stack, undefined)
  })
})

describe('moving a PR to another base', () => {
  const ctx = { pr: pr(), config: config(), root: '/r' }

  test('GitHub: gh pr edit --base', async () => {
    const calls: (readonly string[])[] = []
    const exec: Exec = async (_file, args): Promise<ExecResult> => (calls.push(args), { code: 0, stdout: '', stderr: '' })
    const ex = createExecutor({ exec, orca: createOrcaCli(exec), notify: async () => {} })
    const out = await ex.execute({ kind: 'retarget', sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }, { ...ctx, repo: { owner: 'acme', name: 'app' } })
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(calls[0], ['pr', 'edit', '12', '--repo', 'acme/app', '--base', 'main'])
  })

  test('GitLab: the merge request target branch, on its own host', async () => {
    const g = fakeGlab(() => ({ stdout: '{}' }))
    const ex = createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {} })
    const snap = normalizeMr(detailData().project.mergeRequest, KEY, HOST, 'me', 0)!
    assert.deepEqual(await ex.execute({ kind: 'retarget', sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }, { ...ctx, repo: REPO, pr: snap }), { ok: true })
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', HOST, '-X', 'PUT', 'projects/group%2Fsub%2Fapp/merge_requests/12', '-f', 'target_branch=main'])
  })
})
