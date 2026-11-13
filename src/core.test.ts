import { assert, describe, test } from 'orca/testing'
import { parseConfig, validateConfig } from './config.ts'
import type { Exec, ExecResult } from './exec.ts'
import { createExecutor, tailLog } from './executor.ts'
import { actionableThreads, ciStateOf, createGitHub, normalizePr, parseGitHubRemote } from './github.ts'
import { matchingGlobs } from './glob.ts'
import { emptyHistory, noteLane, prune, windowed } from './history.ts'
import { loadLedger } from './ledger.ts'
import { createdTerminal, createOrcaCli, OrcaRefusal, OrcaUnavailable, parseWorkerList, sendMessage } from './orca-cli.ts'
import { draftMessage } from './messages.ts'
import { check, config, pr, SHA } from './testing/fixtures.ts'

function fakeExec(reply: (file: string, args: readonly string[]) => Partial<ExecResult>) {
  const calls: { file: string; args: readonly string[]; input?: string }[] = []
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, input: options?.input })
    return { code: 0, stdout: '', stderr: '', ...reply(file, args) }
  }
  return { exec, calls }
}

describe('config', () => {
  test('an empty object gives the defaults with no complaints', () => {
    const r = validateConfig({})
    assert.deepEqual(r.errors, [])
    assert.equal(r.config.merge.mode, 'manual')
    assert.equal(r.config.reviewers.length, 2)
  })

  test('bad values fall back to defaults and are reported by path', () => {
    const r = validateConfig({ merge: { mode: 'yolo' }, fix: { ci: { maxRounds: 0 } }, reviewers: [{ name: 'Bad Name', agent: 'claude' }] })
    assert.equal(r.config.merge.mode, 'manual')
    assert.equal(r.config.fix.ci.maxRounds, 3)
    assert.ok(r.errors.some((e) => e.startsWith('merge.mode')))
    assert.ok(r.errors.some((e) => e.startsWith('fix.ci.maxRounds')))
    assert.ok(r.errors.some((e) => e.startsWith('reviewers[0].name')))
  })

  test('warns when Orca cannot pass a model to the agent, and on unknown keys', () => {
    const r = validateConfig({ reviewers: [{ name: 'style', agent: 'aider', model: 'gpt-x' }], extra: 1 })
    assert.ok(r.warnings.some((w) => w.includes('cannot pass --model to aider')))
    assert.ok(r.warnings.some((w) => w.includes('config.extra')))
  })

  test('reviewers are read-only; only an agent Matriarch cannot lock down may opt out', () => {
    const r = validateConfig({
      reviewers: [
        { name: 'style', agent: 'gemini' },
        { name: 'docs', agent: 'opencode', readOnly: false },
        { name: 'deep', agent: 'claude', readOnly: false }
      ]
    })
    assert.deepEqual(r.errors, [])
    assert.ok(r.warnings.some((w) => w.startsWith('reviewers[0]') && w.includes('"readOnly": false')))
    assert.ok(r.warnings.some((w) => w.startsWith('reviewers[1]') && w.includes('usual permissions')))
    assert.ok(r.warnings.some((w) => w.startsWith('reviewers[2].readOnly: ignored')))
    assert.deepEqual(r.config.reviewers.map((x) => x.readOnly), [undefined, false, undefined])
  })

  test('effort needs a model, reviewers need unique names, JSON must parse', () => {
    const r = validateConfig({ supervisor: { agent: 'claude', effort: 'high' }, reviewers: [{ name: 'a', agent: 'claude' }, { name: 'a', agent: 'codex' }] })
    assert.ok(r.errors.some((e) => e.startsWith('supervisor.effort')))
    assert.equal(r.config.reviewers.length, 1)
    assert.ok(parseConfig('{ nope').errors[0].includes('not valid JSON'))
  })
})

describe('github', () => {
  const raw = {
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'Add login',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature/login',
    headRefOid: SHA,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'CHANGES_REQUESTED',
    author: { login: 'me' },
    files: { nodes: [{ path: 'src/a.ts' }], pageInfo: { hasNextPage: false } },
    latestReviews: { nodes: [{ id: 'R1', state: 'CHANGES_REQUESTED', body: 'Needs tests', author: { login: 'bob', __typename: 'User' } }] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u', databaseId: 99 },
                  { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
                  { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 't' }
                ]
              }
            }
          }
        }
      ]
    },
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 4, comments: { nodes: [{ body: 'rename this', author: { login: 'alice', __typename: 'User' } }] } },
        { id: 'T2', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 9, comments: { nodes: [{ body: '<!-- matriarch:finding --> nit', author: { login: 'me', __typename: 'User' } }] } },
        { id: 'T3', isResolved: false, isOutdated: false, path: null, line: null, comments: { nodes: [{ body: 'Summary', author: { login: 'codecov[bot]', __typename: 'Bot' } }] } }
      ]
    }
  }

  test('normalizes checks, threads, our marker and a changes-requested review body', () => {
    const p = normalizePr(raw, 'acme/app', 5)!
    assert.equal(p.ci, 'failing')
    assert.deepEqual(p.checks.map((c) => [c.name, c.state, c.jobId]), [['test', 'failure', 99], ['build', 'pending', null], ['ci/legacy', 'success', null]])
    assert.equal(p.threads.find((t) => t.id === 'T2')?.ours, true)
    assert.equal(p.threads.find((t) => t.id === 'T3')?.bot, true)
    assert.deepEqual(actionableThreads(p).map((t) => t.id), ['T1', 'review:R1'])
  })

  test('CI state needs every check: failure wins, then pending, then cancelled', () => {
    assert.equal(ciStateOf([]), 'none')
    assert.equal(ciStateOf([check('a', 'success'), check('b', 'skipped')]), 'passing')
    assert.equal(ciStateOf([check('a', 'success'), check('b', 'cancelled')]), 'cancelled')
    assert.equal(ciStateOf([check('a', 'pending'), check('b', 'failure')]), 'failing')
  })

  test('remote URLs in https, ssh and scp forms', () => {
    assert.deepEqual(parseGitHubRemote('https://github.com/acme/app.git'), { owner: 'acme', name: 'app' })
    assert.deepEqual(parseGitHubRemote('git@github.com:acme/app.git'), { owner: 'acme', name: 'app' })
    assert.deepEqual(parseGitHubRemote('ssh://git@github.com/acme/app'), { owner: 'acme', name: 'app' })
    assert.equal(parseGitHubRemote('https://gitlab.com/acme/app.git'), null)
  })

  test('the list query pages with endCursor and passes the number as a typed field', async () => {
    let page = 0
    const { exec, calls } = fakeExec(() => {
      page++
      const pageInfo = page === 1 ? { hasNextPage: true, endCursor: 'C1' } : { hasNextPage: false }
      return { stdout: JSON.stringify({ data: { viewer: { login: 'me' }, rateLimit: { cost: 1, remaining: 4000, resetAt: 'r' }, repository: { pullRequests: { pageInfo, nodes: [{ number: page, headRefName: `b${page}`, headRefOid: SHA, updatedAt: 'x', author: { login: 'me' }, commits: { nodes: [] } }] } } } }) }
    })
    const gh = createGitHub(exec)
    const list = await gh.listOpen({ owner: 'acme', name: 'app' })
    assert.deepEqual(list.prs.map((p) => p.number), [1, 2])
    assert.ok(calls[1].args.includes('after=C1'))
    await gh.detail({ owner: 'acme', name: 'app' }, 12).catch(() => null)
    const detail = calls[2].args
    assert.equal(detail[detail.indexOf('number=12') - 1], '-F')
  })

  test('globs for protected paths', () => {
    assert.deepEqual(matchingGlobs(['migrations/**', '*.lock', '.github/workflows/*.yml'], ['migrations/2026/001.sql', 'pnpm.lock', '.github/workflows/ci.yml']), ['migrations/**', '*.lock', '.github/workflows/*.yml'])
    assert.deepEqual(matchingGlobs(['migrations/**', '*.lock'], ['src/migrations.ts', 'sub/pnpm.lock']), [])
  })
})

describe('ledger and history', () => {
  test('a damaged stored ledger loads as empty parts', () => {
    const l = loadLedger({ ci: 'oops', merge: { nope: 1 } })
    assert.deepEqual(l.ci, {})
    assert.equal(l.merge, null)
  })

  test('history extends a lane, splits on change and clips to a window', () => {
    let h = noteLane(emptyHistory(), 'working', 'a', 100)
    h = noteLane(h, 'working', 'b', 200)
    assert.equal(h.segments.length, 1)
    assert.equal(h.segments[0].reason, 'b')
    h = noteLane(h, 'fixing-ci', 'c', 300)
    assert.deepEqual(h.segments.map((s) => [s.lane, s.from, s.to]), [['working', 100, 300], ['fixing-ci', 300, null]])
    assert.deepEqual(windowed(h, 250).segments.map((s) => s.from), [250, 300])
    assert.equal(prune(h, 10_000, 1000).segments.length, 1)
  })
})

describe('orca CLI adapter', () => {
  test('reads the result envelope and tells refusals from an unreachable runtime', async () => {
    const ok = createOrcaCli(fakeExec(() => ({ stdout: '{"ok":true,"result":{"x":1}}' })).exec)
    assert.deepEqual(await ok.run(['status']), { x: 1 })
    const refused = createOrcaCli(fakeExec(() => ({ code: 1, stdout: '{"ok":false,"error":{"code":"dispatch_not_found","message":"gone"}}' })).exec)
    await assert.rejects(refused.run(['x']), (e: unknown) => e instanceof OrcaRefusal && e.code === 'dispatch_not_found')
    const down = createOrcaCli(fakeExec(() => ({ code: 1, stdout: '{"ok":false,"error":{"code":"runtime_unavailable"}}' })).exec)
    await assert.rejects(down.run(['x']), (e: unknown) => e instanceof OrcaUnavailable)
    const missing = createOrcaCli(fakeExec(() => ({ code: 127 })).exec)
    await assert.rejects(missing.run(['x']), (e: unknown) => e instanceof OrcaUnavailable)
  })

  test('worker-list rows from the projection shape and from flat fallbacks', () => {
    const rows = parseWorkerList({ workers: [{ dispatchId: 'd1', resource: { worktreeId: 'w1' }, launch: { effective: { agent: 'codex', model: 'm' } } }, { id: 'd2', worktreeId: 'w2', agent: 'claude' }, { nothing: true }] })
    assert.deepEqual(rows.map((r) => [r.dispatchId, r.worktreeId, r.agent, r.model]), [['d1', 'w1', 'codex', 'm'], ['d2', 'w2', 'claude', null]])
  })

  test('worker-list as Orca 1.4.257 gives it: --full, and the concise view', () => {
    const wt = 'repo1::/w/app/login'
    const full = parseWorkerList({ workers: [
      { dispatchId: 'ctx_live', runId: 'run_9', workerState: 'ready', resource: { worktreeId: wt }, projection: { provider: { id: 'opencode', model: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017' }, liveness: { verdict: 'live' } } },
      { dispatchId: 'ctx_failed', runId: 'run_9', workerState: 'failed', resource: { worktreeId: wt }, projection: { provider: null, liveness: { verdict: 'exited' } } }
    ] })
    assert.deepEqual(full.map((r) => [r.dispatchId, r.worktreeId, r.runId, r.agent, r.model, r.live]), [
      ['ctx_live', wt, 'run_9', 'opencode', 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', true],
      ['ctx_failed', wt, 'run_9', null, null, false]
    ])
    const concise = parseWorkerList({ workers: [{ dispatchId: 'ctx_live', state: 'ready', liveness: 'live', agent: 'opencode/deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', workspace: wt }] })
    assert.deepEqual([concise[0].worktreeId, concise[0].agent, concise[0].model, concise[0].live], [wt, 'opencode', 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', true])
  })

  test('mail goes out from Matriarch\'s own terminal when it has one', async () => {
    const f = fakeExec(() => ({ stdout: '{"ok":true,"result":{}}' }))
    await sendMessage(createOrcaCli(f.exec), { to: 'dispatch:d1', subject: 's', body: 'b', from: 'term_mailbox' })
    assert.deepEqual(f.calls[0].args.slice(-3), ['--from', 'term_mailbox', '--json'])
    assert.equal(createdTerminal({ terminal: { handle: 'term_x', tabId: 't' } }), 'term_x')
  })

  test('send passes the address, subject, body and type', async () => {
    const f = fakeExec(() => ({ stdout: '{"ok":true,"result":{}}' }))
    await sendMessage(createOrcaCli(f.exec), { to: 'run:r1', subject: 's', body: 'b', type: 'escalation' })
    assert.deepEqual(f.calls[0].args, ['orchestration', 'send', '--to', 'run:r1', '--subject', 's', '--body', 'b', '--type', 'escalation', '--json'])
  })
})

describe('executor', () => {
  const ctx = { repo: { owner: 'acme', name: 'app' }, pr: pr(), config: config(), root: '/r' }

  test('work for a finished worker goes to the supervisor, who alone can start a follow-up', async () => {
    const sent: string[][] = []
    const refuse = (args: readonly string[]) =>
      args.includes('dispatch:d1')
        ? { code: 1, stdout: '{"ok":false,"error":{"code":"forbidden","message":"worker-start needs the coordinator bound to the Run, or a worker on an active Dispatch in it."}}' }
        : { stdout: '{"ok":true,"result":{}}' }
    const f = fakeExec((_file, args) => (sent.push([...args]), refuse(args)))
    const ex = createExecutor({ exec: f.exec, orca: createOrcaCli(f.exec), notify: async () => {}, mailbox: async () => 'term_mailbox' })
    const action = { kind: 'send-rebase', to: 'dispatch:d1', sha: SHA, base: 'main', round: 1 } as const
    // Known finished: straight to the supervisor.
    const finished = { ...ctx, supervisor: 'run:r1', worktree: '/r/wt/login', ownerLive: false }
    assert.deepEqual(await ex.execute(action, finished), { ok: true })
    const first = sent.at(-1)!
    assert.equal(first[first.indexOf('--to') + 1], 'run:r1')
    assert.ok(!first.includes('--type'), 'plain mail: Orca takes --type escalation only from a worker')
    assert.match(first[first.indexOf('--body') + 1], /worker-start --worktree path:\/r\/wt\/login/)
    assert.equal(first[first.indexOf('--from') + 1], 'term_mailbox')
    // Not known to be finished: Orca refuses, and it goes to the supervisor after all.
    sent.length = 0
    assert.deepEqual(await ex.execute(action, { ...finished, ownerLive: null }), { ok: true })
    assert.deepEqual(sent.map((a) => a[a.indexOf('--to') + 1]), ['dispatch:d1', 'run:r1'])
  })

  test('merges only the reviewed commit, without --admin', async () => {
    const f = fakeExec(() => ({}))
    const ex = createExecutor({ exec: f.exec, orca: createOrcaCli(f.exec), notify: async () => {} })
    assert.deepEqual(await ex.execute({ kind: 'merge', sha: SHA, method: 'squash' }, ctx), { ok: true })
    assert.deepEqual(f.calls[0].args, ['pr', 'merge', '12', '--repo', 'acme/app', '--squash', '--match-head-commit', SHA, '--delete-branch'])
    assert.ok(!f.calls[0].args.includes('--admin'))
  })

  test('a CI failure message carries each failing job\'s log tail', async () => {
    const f = fakeExec((file, args) => (file === 'gh' ? { stdout: '2026-11-10T10:00:00.1Z step 1\n2026-11-10T10:00:01.2Z \u001b[31mError: boom\u001b[0m\n' } : args[0] === 'orchestration' ? { stdout: '{"ok":true,"result":{}}' } : {}))
    const ex = createExecutor({ exec: f.exec, orca: createOrcaCli(f.exec), notify: async () => {} })
    const out = await ex.execute({ kind: 'send-ci-failure', to: 'dispatch:d1', sha: SHA, round: 1, checks: [check('test', 'failure', 99)], signature: 'test' }, ctx)
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(f.calls[0].args, ['api', 'repos/acme/app/actions/jobs/99/logs'])
    const send = f.calls[1].args
    const body = send[send.indexOf('--body') + 1]
    assert.match(body, /Error: boom/)
    assert.ok(!body.includes('\u001b'), 'no colour codes reach the agent')
  })

  test('without a review crew, start-review is skipped, not failed', async () => {
    const f = fakeExec(() => ({}))
    const ex = createExecutor({ exec: f.exec, orca: createOrcaCli(f.exec), notify: async () => {} })
    const out = await ex.execute({ kind: 'start-review', sha: SHA, round: 1, reviewers: [] }, ctx)
    assert.equal(out.ok, false)
    assert.ok(out.skipped)
  })

  test('log tails drop timestamps, colour and blank lines', () => {
    assert.equal(tailLog('2026-11-10T10:00:00.0000000Z a\n\n\u001b[1mb\u001b[0m\nc', 2), 'b\nc')
  })
})

test('asking the supervisor about a quiet draft is plain mail, not an escalation', () => {
  const m = draftMessage(pr({ number: 4, title: 'P2' }), '#4 has been a draft for 15 min with nobody working on it.')
  assert.equal(m.subject, 'acme/app #4 is still a draft')
  assert.ok(!/stuck|decision|escalat/i.test(m.subject + m.body))
})
