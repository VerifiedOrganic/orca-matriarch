import { assert, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps } from './engine.ts'
import type { Action } from './plan.ts'
import { findTaggedRun, supervisorBrief, supervisorLaunchArgs, supervisorTag, workerStart } from './supervisor.ts'
import { check, config, pr } from './testing/fixtures.ts'

test('the brief tags the Run, gives exact worker settings per tier and the PR contract', () => {
  const c = config((x) => (x.workers.tiers = { small: { agent: 'claude', model: 'claude-sonnet-5-5' } }))
  const tag = supervisorTag('acme/app', 'n1')
  const brief = supervisorBrief({ repo: 'acme/app', objective: 'Add SSO login', tag, base: 'main', config: c })
  assert.ok(brief.includes("The user's objective: Add SSO login"))
  assert.ok(brief.includes(`run-create --objective '${tag} <the agreed objective in one line>'`))
  assert.ok(brief.includes("--agent 'codex' --model 'gpt-6-astra' --effort 'high'"))
  assert.ok(brief.includes("small: orca orchestration worker-start --task <taskId> --worktree path:<worktree path> --agent 'claude' --model 'claude-sonnet-5-5'"))
  assert.ok(brief.includes('orca worktree create --repo'))
  assert.ok(brief.includes('never stop to wait for the user'))
  assert.ok(brief.includes('The user merges each PR'), 'manual merge mode: the user merges')
  const auto = supervisorBrief({ repo: 'acme/app', objective: 'x', tag, base: 'main', config: validateConfig({ merge: { mode: 'auto' } }).config })
  assert.ok(auto.includes('Never ask the user to merge'))
  assert.ok(brief.includes('Matriarch-Task: <taskId>'))
  assert.ok(brief.includes('Do not review or merge PRs yourself'))
  assert.equal(workerStart({ agent: "it's" }), "orca orchestration worker-start --task <taskId> --worktree path:<worktree path> --agent 'it'\\''s' --json")
})

test('finds the tagged Run in run-list output', () => {
  const tag = supervisorTag('acme/app', 'n1')
  assert.equal(findTaggedRun({ runs: [{ id: 'r0', objective: 'other' }, { id: 'r1', objective: `${tag} Add SSO` }] }, tag), 'r1')
  assert.equal(findTaggedRun({ runs: [] }, tag), null)
})

test('once its Run is found, escalations go to the supervisor instead of you', async () => {
  const store = new Map<string, unknown>([['supervisor:pending:acme/app', { tag: '[matriarch:acme/app:n1]', at: 1 }]])
  const executed: Action[] = []
  const failing = pr({ ci: 'failing', checks: [check('test', 'failure')] })
  const deps: EngineDeps = {
    now: () => 1_000,
    log: () => {},
    workspaces: async () => [{ id: 'ws1', kind: 'worktree', name: 'login', path: '/r/wt', branch: 'refs/heads/feature/login', hostId: 'local' }],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig({ supervisor: { agent: 'claude', model: 'claude-opus-5-5' }, review: { enabled: false } }),
    github: {
      listOpen: async () => ({ viewer: 'me', rate: null, prs: [{ number: 12, headRef: 'feature/login', headSha: failing.headSha, author: 'me', updatedAt: failing.updatedAt, rollup: 'FAILURE' }] }),
      detail: async () => ({ pr: failing, rate: null })
    },
    workers: async () => [],
    activity: () => null,
    supervisor: async (repo) => (store.get(`supervisor:${repo}`) as string | undefined) ?? null,
    findRun: async (tag) => (tag === '[matriarch:acme/app:n1]' ? 'run-7' : null),
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor: { execute: async (a) => (executed.push(a), { ok: true }) }
  }
  const board = await tick(deps, { autopilot: true })
  assert.equal(store.get('supervisor:acme/app'), 'run:run-7')
  assert.deepEqual(board.repos[0].supervisor, { agent: 'claude', model: 'claude-opus-5-5', run: 'run:run-7', pending: false, terminal: null, workers: 0 })
  // No worker owns the branch, so the CI failure goes to the supervisor's Run, not straight to you.
  const e = executed[0] as Extract<Action, { kind: 'escalate' }>
  assert.equal(e.kind, 'escalate')
  assert.equal(e.to, 'supervisor')
  assert.equal(e.address, 'run:run-7')
})

test('the supervisor opens as a chat that asks what to build and waits for a go-ahead', () => {
  const c = config()
  const brief = supervisorBrief({ repo: 'acme/app', objective: '', tag: '[matriarch:acme/app:n2]', base: 'main', config: c })
  assert.ok(brief.includes('Start by asking the user what the pod should build'))
  assert.ok(brief.includes('wait for them to agree'))
  assert.ok(brief.includes("run-create --objective '[matriarch:acme/app:n2] <the agreed objective in one line>'"))
  const args = supervisorLaunchArgs(c.supervisor, '/r', brief)
  assert.deepEqual(args.slice(0, 8), ['agent', 'launch', '--agent', 'claude', '--worktree', 'path:/r', '--surface', 'chat'])
  assert.deepEqual(args.slice(-4), ['--model', 'claude-opus-5-5', '--effort', 'high'])
})

test('a supervisor chat Orca says is gone is forgotten, so the board offers a new one', async () => {
  const start = (gone: boolean) => {
    const store = new Map<string, unknown>([
      ['supervisor:pending:acme/app', { tag: '[matriarch:acme/app:n1]', at: 1 }],
      ['supervisor:terminal:acme/app', 'structured-agent-session-claude_1']
    ])
    const deps: EngineDeps = {
      now: () => 1_000,
      log: () => {},
      workspaces: async () => [{ id: 'ws1', kind: 'worktree', name: 'login', path: '/r/wt', branch: 'refs/heads/feature/login', hostId: 'local' }],
      repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
      readConfig: async () => validateConfig({ review: { enabled: false } }),
      github: { listOpen: async () => ({ viewer: 'me', rate: null, prs: [] }), detail: async () => ({ pr: null, rate: null }) },
      workers: async () => [],
      activity: () => null,
      supervisor: async () => null,
      findRun: async () => null,
      terminalGone: async (handle) => gone && handle === 'structured-agent-session-claude_1',
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      executor: null
    }
    return { deps, store }
  }
  const closed = start(true)
  const board = await tick(closed.deps, { autopilot: false })
  assert.deepEqual([board.repos[0].supervisor.pending, board.repos[0].supervisor.terminal], [false, null])
  assert.equal(closed.store.get('supervisor:pending:acme/app'), null)

  const open = start(false)
  const still = await tick(open.deps, { autopilot: false })
  assert.deepEqual([still.repos[0].supervisor.pending, still.repos[0].supervisor.terminal], [true, 'structured-agent-session-claude_1'])
})

test('a supervisor Run is found by its project even when the chat link was lost', async () => {
  const store = new Map<string, unknown>()
  const asked: string[] = []
  const deps: EngineDeps = {
    now: () => 1_000,
    log: () => {},
    workspaces: async () => [{ id: 'ws1', kind: 'worktree', name: 'main', path: '/r', branch: 'refs/heads/main', hostId: 'local' }],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig({ review: { enabled: false } }),
    github: { listOpen: async () => ({ viewer: 'me', rate: null, prs: [] }), detail: async () => ({ pr: null, rate: null }) },
    workers: async () => [],
    activity: () => null,
    supervisor: async (repo) => (store.get(`supervisor:${repo}`) as string | undefined) ?? null,
    findRun: async (tag) => (asked.push(tag), '[matriarch:acme/app:k3] Build the thing'.includes(tag) ? 'run-9' : null),
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    executor: null
  }
  const board = await tick(deps, { autopilot: false })
  assert.deepEqual(asked, ['[matriarch:acme/app:'])
  assert.equal(board.repos[0].supervisor.run, 'run:run-9')
})

test('the brief has the supervisor clean up worktrees that never become a PR', () => {
  const brief = supervisorBrief({ repo: 'acme/app', objective: 'x', tag: '[matriarch:acme/app:x]', base: 'main', config: config() })
  assert.ok(brief.includes('Worktrees that never become a PR (a gate, an audit, a spike) are yours to clean up'))
  assert.ok(brief.includes('orca worktree rm --worktree path:<path> --json'))
})

test('a new project names no models: each agent runs its own default until one is chosen', () => {
  const d = validateConfig({}).config
  assert.equal(d.supervisor.model, undefined)
  assert.equal(d.workers.default.model, undefined)
  assert.ok(d.reviewers.every((r) => r.model === undefined))
  assert.ok(supervisorBrief({ repo: 'acme/app', objective: 'x', tag: 't', base: 'main', config: d }).includes("--agent 'codex' --json"))
})
