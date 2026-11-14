// Stacked PRs: a PR whose base is another PR's branch merges only after it, is moved to where
// its parent merged, and is rebased off the parent's commits before it merges itself.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { canBeParent, stackableBranch, tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Exec, ExecResult } from './exec.ts'
import { createExecutor, type Executor } from './executor.ts'
import { createGitHub, normalizePr, type GitHub, type PrSnapshot } from './github.ts'
import { createGitLab, normalizeMr } from './gitlab.ts'
import { emptyLedger, ledgerKey, loadLedger, record, recordRefusedRetarget, type PrLedger, type StackParent } from './ledger.ts'
import { restackCommand, restackMessage } from './messages.ts'
import { createOrcaCli } from './orca-cli.ts'
import { plan, RESTACK_STALL_MS, RETARGET_TRIES, retargetBackoff, type Action } from './plan.ts'
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

  test('a move the forge refuses waits before the next try, and a few refusals go to the supervisor', () => {
    const merged = parent({ state: 'MERGED', headAtMerge: SHA })
    const action = { kind: 'retarget' as const, sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }
    let ledger = recordRefusedRetarget(passed(), action, 1_000, 'HTTP 403: Resource not accessible')
    const waiting = plan(input({ pr: child, config: auto, stack: merged, now: 1_000 + retargetBackoff(1) - 1 }, ledger))
    assert.deepEqual(waiting.actions, [], 'not every tick')
    assert.match(waiting.reason, /failed \(HTTP 403: Resource not accessible\), trying again shortly/)
    assert.deepEqual(kinds(plan(input({ pr: child, config: auto, stack: merged, now: 1_000 + retargetBackoff(1) }, ledger)).actions), ['retarget'])
    for (let i = 1; i < RETARGET_TRIES; i++) ledger = recordRefusedRetarget(ledger, action, 2_000, 'HTTP 403')
    const given = plan(input({ pr: child, config: auto, stack: merged, supervisor: 'run:r1', now: 10_000_000 }, ledger))
    assert.deepEqual(given.actions.map((a) => (a.kind === 'escalate' ? a.to : a.kind)), ['supervisor'])
    assert.match(given.reason, /refused to move the base from feature\/auth to main 3 times \(HTTP 403\): move it by hand/)
    // Once it moved, the refusals are forgotten.
    assert.equal(record(ledger, action, 3_000).retargetFailures, undefined)
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

  test('a parent whose base is its own head is no reason to move a PR', () => {
    // A fork's PR from its own main into main: retargeting "from main to main" would never end.
    const self = parent({ headRef: 'main', baseRef: 'main', state: 'MERGED', headAtMerge: SHA })
    const p = plan(input({ pr: pr({ number: 12, baseRef: 'main' }), config: auto, stack: self }, passed()))
    assert.ok(!p.actions.some((a) => a.kind === 'retarget'))
  })

  test('no rebase when the base kept the commits the branch was built on; it merges as is', () => {
    const kept = parent({ state: 'MERGED', headAtMerge: SHA, forkInBase: true })
    assert.deepEqual(kinds(plan(input({ pr: pr({ number: 12, baseRef: 'main' }), config: auto, stack: kept }, passed())).actions), ['merge'])
  })

  test('the rebase starts at the parent head the branch was built on, not the one that merged', () => {
    const amended = parent({ state: 'MERGED', headAtMerge: SHA, headSha: NEW_SHA, forkSha: PARENT_SHA })
    const p = plan(input({ pr: pr({ number: 12, baseRef: 'main' }), config: auto, stack: amended }, passed()))
    assert.deepEqual(p.actions, [{ kind: 'send-restack', to: 'dispatch:d1', sha: SHA, parent: 11, parentSha: PARENT_SHA, base: 'main' }])
  })

  test('a branch that never moves after the rebase request is escalated', () => {
    const merged = parent({ state: 'MERGED', headAtMerge: SHA })
    const moved = pr({ number: 12, baseRef: 'main' })
    const asked = record(passed(), { kind: 'send-restack', to: 'dispatch:d1', sha: SHA, parent: 11, parentSha: PARENT_SHA, base: 'main' }, 0)
    assert.deepEqual(plan(input({ pr: moved, config: auto, stack: merged, supervisor: 'run:r1', now: RESTACK_STALL_MS - 1 }, asked)).actions, [])
    const late = plan(input({ pr: moved, config: auto, stack: merged, supervisor: 'run:r1', now: RESTACK_STALL_MS }, asked))
    assert.deepEqual(late.actions.map((a) => (a.kind === 'escalate' ? a.to : a.kind)), ['supervisor'])
    assert.ok(late.actions[0].kind === 'escalate' && late.actions[0].reason.includes('has not moved'))
  })

  test('a PR whose base may be an unlisted PR waits for you to merge it, in both modes, and says so once', () => {
    for (const cfg of [auto, config()]) {
      const p = plan(input({ pr: child, config: cfg, unlistedBase: true }, passed()))
      assert.equal(p.lane, 'needs-you')
      assert.deepEqual(p.actions.map((a) => a.kind), ['notify'], 'no merge, and you hear of it')
      const told = plan(input({ pr: child, config: cfg, unlistedBase: true }, { ...passed(), notified: { [`unlisted-base:${child.headSha}`]: 1 } }))
      assert.deepEqual(told.actions, [], 'once')
    }
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
  const ws = (name: string, branch: string): Workspace => ({ id: `ws-${name}`, kind: 'worktree', name, path: `/r/wt/${name}`, branch, hostId: null })
  const WORKSPACES = [ws('auth', 'feature/auth'), ws('login', 'feature/login'), ws('profile', 'feature/profile')]
  function harness(prs: PrSnapshot[], opts: { workspaces?: Workspace[]; defaultBranch?: string; truncated?: boolean; inBase?: (sha: string, ref: string) => boolean | null } = {}) {
    const store = new Map<string, unknown>()
    const executed: Action[] = []
    const asked: [string, string][] = []
    let now = T0
    const workspaces = opts.workspaces ?? WORKSPACES
    const github: GitHub = {
      async listOpen() {
        return {
          viewer: 'me',
          rate: null,
          base: { name: opts.defaultBranch ?? 'main', sha: 'basesha', rollup: 'SUCCESS' },
          ...(opts.truncated ? { truncated: true } : {}),
          prs: prs.filter((p) => p.state === 'OPEN').map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, baseRef: p.baseRef, author: p.author, updatedAt: p.updatedAt, rollup: 'SUCCESS', ...(p.crossRepo ? { crossRepo: true } : {}) }))
        }
      },
      async detail(_repo, number) {
        const p = prs.find((x) => x.number === number)
        return { pr: p ? { ...p, fetchedAt: now } : null, rate: null }
      },
      ...(opts.inBase ? { isAncestor: async (_repo: unknown, sha: string, ref: string) => (asked.push([sha, ref]), opts.inBase!(sha, ref)) } : {})
    }
    const executor: Executor = { execute: async (a) => (executed.push(a), { ok: true }) }
    const deps: EngineDeps = {
      now: () => now,
      log: () => {},
      workspaces: async () => workspaces,
      repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
      readConfig: async () => validateConfig({ review: { enabled: false }, merge: { mode: 'auto' } }),
      github,
      workers: async () => workspaces.map((w, i) => ({ dispatchId: `d-${w.name}`, worktreeId: w.id, taskId: `t${i}`, runId: 'r1', agent: 'codex', model: null, state: 'idle' })),
      activity: () => null,
      supervisor: async () => 'run:r1',
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), keys: async () => [...store.keys()] },
      executor
    }
    return { deps, store, executed, asked, advance: (ms: number) => (now += ms) }
  }
  const ledgerOf = (h: ReturnType<typeof harness>, n: number) => h.store.get(ledgerKey('acme/app', n)) as PrLedger
  const merges = (h: ReturnType<typeof harness>) => h.executed.filter((a) => a.kind === 'merge').map((a) => (a.kind === 'merge' ? a.sha : ''))

  test('a move of the base the forge refuses is recorded, and not tried again on the next tick', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA, title: 'Auth' })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    await tick(h.deps, { autopilot: true })
    prs[0] = { ...auth, state: 'MERGED' }
    const tries: string[] = []
    h.deps.executor = { execute: async (a) => (a.kind === 'retarget' ? (tries.push(a.base), { ok: false, error: 'HTTP 403' }) : { ok: true }) }
    h.advance(60_000)
    const refused = await tick(h.deps, { autopilot: true })
    assert.deepEqual(tries, ['main'])
    assert.deepEqual(ledgerOf(h, 12).retargetFailures?.['11'], { count: 1, at: refused.at, error: 'HTTP 403' })
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(tries, ['main'], 'it waits before the next try, rather than every tick')
  })

  test('the parent merges first; the child is moved, asked to rebase, and merges after its push', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA, title: 'Auth' })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    const first = await tick(h.deps, { autopilot: true })
    assert.deepEqual(merges(h), [PARENT_SHA], 'only the parent merges')
    const card = first.tracks.find((t) => t.pr?.number === 12)!
    assert.equal(card.lane, 'ready')
    assert.equal(card.pr?.stackedOn, 11)
    assert.equal(ledgerOf(h, 12).stack?.forkSha, PARENT_SHA)

    // The parent merged, its branch kept: the child still points at it, and is moved.
    prs[0] = { ...auth, state: 'MERGED' }
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed, [{ kind: 'retarget', sha: SHA, parent: 11, from: 'feature/auth', base: 'main' }])
    assert.equal(ledgerOf(h, 12).stack?.state, 'MERGED')
    assert.equal(ledgerOf(h, 12).retargetFailures, undefined)
    assert.equal(ledgerOf(h, 12).stack?.headAtMerge, SHA)

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
    assert.deepEqual(merges(h), [NEW_SHA])
  })

  test('a parent merged with its commits kept (a merge commit, a fast-forward): no rebase, the child merges', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs, { inBase: () => true })
    await tick(h.deps, { autopilot: true })
    prs[0] = { ...auth, state: 'MERGED' }
    prs[1] = { ...login, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.asked, [[PARENT_SHA, 'main']], 'asked once, whether main has the commit the child was built on')
    assert.equal(ledgerOf(h, 12).stack?.forkInBase, true)
    assert.deepEqual(merges(h), [SHA])
  })

  test('three deep: each PR is rebased off the parent head it was built on, not the one that merged', async () => {
    const A_SHA = 'a'.repeat(40)
    const B1 = 'b1'.repeat(20)
    const B2 = 'b2'.repeat(20)
    const C1 = 'c1'.repeat(20)
    const a = pr({ number: 10, headRef: 'feature/auth', headSha: A_SHA })
    const b = pr({ number: 11, headRef: 'feature/login', baseRef: 'feature/auth', headSha: B1 })
    const c = pr({ number: 12, headRef: 'feature/profile', baseRef: 'feature/login', headSha: C1 })
    const prs = [a, b, c]
    const h = harness(prs)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(merges(h), [A_SHA])
    assert.deepEqual([ledgerOf(h, 11).stack?.forkSha, ledgerOf(h, 12).stack?.forkSha], [A_SHA, B1])
    // A merges (squashed); GitHub moves B to main; B's worker rebases it off A: B is now B2.
    prs[0] = { ...a, state: 'MERGED' }
    prs[1] = { ...b, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((x) => (x.kind === 'send-restack' ? `${x.to} ${x.parentSha}` : x.kind)), [`dispatch:d-login ${A_SHA}`])
    prs[1] = { ...prs[1], headSha: B2, updatedAt: '2026-11-10T12:00:00Z' }
    h.executed.length = 0
    h.advance(5 * 60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(merges(h), [B2], 'B merges; C still waits for it')
    assert.equal(ledgerOf(h, 12).stack?.headSha, B2)
    assert.equal(ledgerOf(h, 12).stack?.forkSha, B1, 'C was built on B1, and its own commits start there')
    // B merges: C is moved, and rebased off B1, the commit it was built on.
    prs[1] = { ...prs[1], state: 'MERGED' }
    prs[2] = { ...c, baseRef: 'main', updatedAt: '2026-11-10T13:00:00Z' }
    h.executed.length = 0
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed, [{ kind: 'send-restack', to: 'dispatch:d-profile', sha: C1, parent: 11, parentSha: B1, base: 'main' }])
  })

  test('a release PR from the default branch or a long-lived one is no parent: PRs into that branch merge there', async () => {
    // git flow: develop is the default branch, and its release PR into main is open.
    const release = pr({ number: 5, headRef: 'develop', baseRef: 'main', headSha: 'd'.repeat(40) })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'develop' })
    const flow = harness([release, login], { workspaces: [ws('develop', 'develop'), ws('login', 'feature/login')], defaultBranch: 'develop' })
    await tick(flow.deps, { autopilot: true })
    assert.equal(ledgerOf(flow, 12).stack, undefined)
    assert.ok(merges(flow).includes(SHA), 'into develop, as it asks')
    // A release branch with its back-merge PR open, and a fix into that release branch.
    const back = pr({ number: 6, headRef: 'release/2.0', baseRef: 'main', headSha: 'e'.repeat(40) })
    const fix = pr({ number: 13, headRef: 'feature/login', baseRef: 'release/2.0' })
    const rel = harness([back, fix], { workspaces: [ws('release', 'release/2.0'), ws('login', 'feature/login')] })
    await tick(rel.deps, { autopilot: true })
    assert.equal(ledgerOf(rel, 13).stack, undefined)
    assert.ok(merges(rel).includes(SHA))
  })

  test("a fork's PR, or one Matriarch does not follow, is no parent", async () => {
    // A contributor's PR from their fork's main, and someone else's PR: PRs into those branches are not held.
    const fork = pr({ number: 7, headRef: 'feature/auth', baseRef: 'main', author: 'me', crossRepo: true, headSha: 'f'.repeat(40) })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const h = harness([fork, login])
    await tick(h.deps, { autopilot: true })
    assert.equal(ledgerOf(h, 12).stack, undefined)
    const alice = pr({ number: 8, headRef: 'feature/auth', baseRef: 'main', author: 'alice', headSha: 'f'.repeat(40) })
    const h2 = harness([alice, login])
    await tick(h2.deps, { autopilot: true })
    assert.equal(ledgerOf(h2, 12).stack, undefined)
    assert.deepEqual(merges(h2), [SHA])
  })

  test('a PR moved off a parent that is still open is not stacked any more', async () => {
    const auth = pr({ number: 11, headRef: 'feature/auth', headSha: PARENT_SHA })
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const prs = [auth, login]
    const h = harness(prs)
    const first = await tick(h.deps, { autopilot: false })
    // Stacked first, so the second tick is what un-stacks it.
    assert.equal(ledgerOf(h, 12).stack?.number, 11)
    assert.equal(first.tracks.find((t) => t.pr?.number === 12)?.pr?.stackedOn, 11)
    prs[1] = { ...login, baseRef: 'main', updatedAt: '2026-11-10T11:00:00Z' }
    h.advance(60_000)
    const moved = await tick(h.deps, { autopilot: false })
    assert.equal(ledgerOf(h, 12).stack, undefined)
    assert.equal(moved.tracks.find((t) => t.pr?.number === 12)?.pr?.stackedOn, undefined)
  })

  test('with a cut-short PR list, a PR into a branch with a worktree here waits rather than merging blind', async () => {
    const login = pr({ number: 12, headRef: 'feature/login', baseRef: 'feature/auth' })
    const h = harness([login], { truncated: true })
    const board = await tick(h.deps, { autopilot: true })
    assert.deepEqual(merges(h), [])
    assert.match(board.tracks.find((t) => t.pr?.number === 12)!.reason, /may be another open PR's branch/)
    // Into main, or with the whole list read, it merges as usual.
    const full = harness([login])
    await tick(full.deps, { autopilot: true })
    assert.deepEqual(merges(full), [SHA])
    const intoMain = harness([pr({ number: 12, headRef: 'feature/login' })], { truncated: true })
    await tick(intoMain.deps, { autopilot: true })
    assert.deepEqual(merges(intoMain), [SHA])
  })
})

describe('which PRs can be parents', () => {
  test('only a short-lived branch of this repository, into another branch', () => {
    const p = (headRef: string, baseRef = 'main', crossRepo = false) => canBeParent({ headRef, baseRef, crossRepo }, 'main')
    assert.equal(p('feature/auth'), true)
    assert.equal(p('main', 'release'), false, 'the default branch')
    for (const b of ['master', 'develop', 'dev', 'trunk', 'staging', 'production', 'release', 'release/2.0', 'release-2.0', 'releases/1', 'v2', '1.x', '2.3.4']) assert.equal(p(b), false, b)
    assert.equal(p('feature/auth', 'main', true), false, "a fork's branch")
    assert.equal(p('feature/auth', 'feature/auth'), false, 'into its own head')
    assert.equal(stackableBranch('develop-login', 'main'), true, 'a feature branch named after one')
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

describe('reading what stacking needs from each forge', () => {
  test('GitHub: whether a branch has a commit, from compare; a fork PR is cross-repository', async () => {
    const answers: Record<string, string> = { ahead: 'true', identical: 'true', behind: 'false', diverged: 'false' }
    for (const [status, want] of Object.entries(answers)) {
      const calls: (readonly string[])[] = []
      const exec: Exec = async (_file, args): Promise<ExecResult> => (calls.push(args), { code: 0, stdout: `${status}\n`, stderr: '' })
      assert.equal(String(await createGitHub(exec).isAncestor!({ owner: 'acme', name: 'app' }, PARENT_SHA, 'main')), want, status)
      assert.deepEqual(calls[0], ['api', `repos/acme/app/compare/${PARENT_SHA}...main?per_page=1`, '--jq', '.status'])
    }
    const failed: Exec = async () => ({ code: 1, stdout: '', stderr: 'HTTP 404' })
    assert.equal(await createGitHub(failed).isAncestor!({ owner: 'acme', name: 'app' }, PARENT_SHA, 'main'), null)
    assert.equal(normalizePr({ number: 7, headRefOid: SHA, isCrossRepository: true }, 'acme/app', 0)?.crossRepo, true)
    assert.equal(normalizePr({ number: 7, headRefOid: SHA, isCrossRepository: false }, 'acme/app', 0)?.crossRepo, undefined)
  })

  test("GitLab: the merge base answers whether a branch has a commit; another project's merge request is a fork's", async () => {
    const g = fakeGlab(() => ({ stdout: JSON.stringify({ id: PARENT_SHA }) }))
    assert.equal(await createGitLab(g.exec).isAncestor!(REPO, PARENT_SHA, 'main'), true)
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', HOST, `projects/group%2Fsub%2Fapp/repository/merge_base?refs[]=${PARENT_SHA}&refs[]=main`])
    const other = fakeGlab(() => ({ stdout: JSON.stringify({ id: 'c0ffee'.padEnd(40, '0') }) }))
    assert.equal(await createGitLab(other.exec).isAncestor!(REPO, PARENT_SHA, 'main'), false)
    const mr = (source: number, target: number) => normalizeMr({ ...detailData().project.mergeRequest, sourceProjectId: source, targetProjectId: target }, KEY, HOST, 'me', 0)!
    assert.equal(mr(2, 1).crossRepo, true)
    assert.equal(mr(1, 1).crossRepo, undefined)
  })
})
