// Flaky CI: a check that failed on the infrastructure runs once more before a worker gets it.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Exec, ExecResult } from './exec.ts'
import { createExecutor, type Executor } from './executor.ts'
import { FLAKY_SIGNS, flakyReason } from './flaky.ts'
import { createGitHub, normalizePr, type CheckInfo, type GitHub, type PrSnapshot } from './github.ts'
import { createGitLab, normalizeMr } from './gitlab.ts'
import { checkKey, emptyLedger, ledgerKey, record, recordRefusedRerun, type PrLedger } from './ledger.ts'
import { createOrcaCli } from './orca-cli.ts'
import { plan, RERUN_START_MS, type Action } from './plan.ts'
import { check, config, input, pr, SHA } from './testing/fixtures.ts'
import { detailData, fakeGlab, HOST, KEY, REPO } from './testing/gitlab.ts'

const kinds = (actions: Action[]) => actions.map((a) => a.kind)
const job = (name: string, state: CheckInfo['state'], jobId: number, runId: number | null = null): CheckInfo => ({ ...check(name, state, jobId), runId })

describe('telling a flaky failure from a real one', () => {
  test("a lost runner, GitLab's own reasons, and a registry or git remote out of reach look flaky", () => {
    const flaky: [string, string][] = [
      ['##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.', 'the runner shut down'],
      ['The self-hosted runner: box-3 lost communication with the server.', 'the runner lost its connection'],
      ['The hosted runner encountered an error while running your job. (Error Type: Disconnect).', 'the hosted runner failed'],
      ['failure_reason: runner_system_failure', 'the GitLab runner failed'],
      ['failure_reason: stuck_or_timeout_failure\nERROR: Job failed', 'the job got stuck waiting for a runner'],
      ['npm ERR! code ECONNRESET', 'the npm registry could not be reached'],
      ['npm ERR! network request to https://registry.npmjs.org/left-pad failed, reason: socket hang up', 'the npm registry could not be reached'],
      [' ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/left-pad: request to https://registry.npmjs.org/left-pad failed', 'the npm registry could not be reached'],
      ['error An unexpected error occurred: "https://registry.yarnpkg.com/left-pad: ESOCKETTIMEDOUT".', 'the yarn registry could not be reached'],
      ["fatal: unable to access 'https://github.com/acme/app/': Could not resolve host: github.com", 'git could not reach the remote'],
      ['error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502', 'git lost its connection to the remote'],
      ['Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout', 'the container registry could not be reached'],
      ['toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating.', "Docker Hub's pull rate limit"],
      ['##[error]API rate limit exceeded for installation ID 1234.', "GitHub's API rate limit"]
    ]
    for (const [text, why] of flaky) assert.equal(flakyReason(text), why, text)
  })

  test("a test's own output, a warning about something that recovered, and real errors are real failures", () => {
    const real = [
      // Tests whose names or assertions mention the network.
      '  ✕ retries the upload on ECONNRESET (12 ms)',
      '  ✕ returns 429 Too Many Requests when the limit is hit (4 ms)',
      'AssertionError: expected "rate limit exceeded" to equal "ok"',
      'not ok 3 - handles npm ERR! code ECONNRESET',
      "it('fails over on lost communication with the server')",
      // The app under test, or the PR's own configuration.
      'curl: (22) The requested URL returned error: 502 Bad Gateway',
      'Error: getaddrinfo EAI_AGAIN postgres',
      'Error: connect ETIMEDOUT 10.0.0.5:5432',
      // Something that failed and recovered, or did not matter.
      'Warning: Failed to restore: Cache service responded with 503 Service Unavailable',
      'npm WARN retry will retry, error on last attempt: Error: read ECONNRESET',
      // Plain failures.
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2',
      'Error: Timeout of 2000ms exceeded. For async tests and hooks, ensure "done()" is called',
      'The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 360 minutes.',
      "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
      '##[error]Process completed with exit code 1.',
      'failure_reason: script_failure',
      ''
    ]
    for (const text of real) assert.equal(flakyReason(text), null, text)
    assert.ok(FLAKY_SIGNS.length > 0)
  })
})

describe('planning a flaky check', () => {
  const failing = pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('lint', 'success', 8)] })
  const judged = (why: string | null, name = 'test'): PrLedger => ({ ...emptyLedger(), flaky: { [checkKey(SHA, name)]: why } })

  test('it is re-run once, then a second failure goes to the worker', () => {
    const p = plan(input({ pr: failing }, judged('the runner shut down')))
    assert.equal(p.lane, 'awaiting-ci')
    assert.deepEqual(p.actions, [{ kind: 'rerun-check', sha: SHA, checks: [check('test', 'failure', 7)], why: 'the runner shut down' }])
    assert.match(p.reason, /re-running test \(the runner shut down\) once/)
    const ran = record(judged('the runner shut down'), p.actions[0], 5)
    assert.deepEqual(ran.reruns?.[checkKey(SHA, 'test')], { at: 5, why: 'the runner shut down', jobId: 7 })
    // Running again: the board says so.
    const pending = pr({ ci: 'pending', checks: [check('test', 'pending', 9), check('lint', 'success', 8)] })
    assert.equal(plan(input({ pr: pending }, ran)).reason, 're-running test (the runner shut down) once')
    // The new attempt (a new job id) failed too: now the worker gets it.
    assert.deepEqual(kinds(plan(input({ pr: pr({ ci: 'failing', checks: [check('test', 'failure', 9)] }) }, ran)).actions), ['send-ci-failure'])
  })

  test('the failed attempt still showing right after the re-run is starting again, not failing again', () => {
    const ran = record(judged('the runner shut down'), { kind: 'rerun-check', sha: SHA, checks: [check('test', 'failure', 7)], why: 'the runner shut down' }, 1_000_000)
    const stale = plan(input({ pr: failing, now: 1_000_000 + 30_000 }, ran))
    assert.equal(stale.lane, 'awaiting-ci')
    assert.deepEqual(stale.actions, [])
    assert.equal(stale.reason, 're-running test (the runner shut down) once')
    // A forge that never shows the new attempt does not hold it for ever.
    assert.deepEqual(kinds(plan(input({ pr: failing, now: 1_000_000 + RERUN_START_MS }, ran)).actions), ['send-ci-failure'])
  })

  test('a re-run the forge refused is not asked for again: the failure goes to the worker', () => {
    const action: Extract<Action, { kind: 'rerun-check' }> = { kind: 'rerun-check', sha: SHA, checks: [check('test', 'failure', 7)], why: 'the runner shut down' }
    const refused = recordRefusedRerun(judged('the runner shut down'), action, 1_000_000, 'HTTP 403 Resource not accessible by integration')
    assert.equal(refused.reruns?.[checkKey(SHA, 'test')]?.error, 'HTTP 403 Resource not accessible by integration')
    const p = plan(input({ pr: failing, now: 1_000_000 + 1000 }, refused))
    assert.deepEqual(kinds(p.actions), ['send-ci-failure'])
  })

  test('a real failure goes to the worker, and so does every failure with re-runs off or no Actions job', () => {
    assert.deepEqual(kinds(plan(input({ pr: failing }, judged(null))).actions), ['send-ci-failure'])
    assert.deepEqual(kinds(plan(input({ pr: failing }, emptyLedger())).actions), ['send-ci-failure'], 'not judged: as before')
    const off = config((c) => (c.fix.ci.rerunFlaky = false))
    assert.deepEqual(kinds(plan(input({ pr: failing, config: off }, judged('a rate limit'))).actions), ['send-ci-failure'])
    // A status or another app's check (no Actions job) cannot be re-run.
    const external = pr({ ci: 'failing', checks: [check('ci/circle', 'failure', null)] })
    assert.deepEqual(kinds(plan(input({ pr: external }, judged('a rate limit', 'ci/circle'))).actions), ['send-ci-failure'])
  })

  test('only the flaky checks run again; the real failure waits for them, then goes alone', () => {
    const both = pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'failure', 6)] })
    const ledger: PrLedger = { ...emptyLedger(), flaky: { [checkKey(SHA, 'test')]: null, [checkKey(SHA, 'build')]: 'a rate limit' } }
    const p = plan(input({ pr: both }, ledger))
    assert.deepEqual(p.actions.map((a) => (a.kind === 'rerun-check' ? a.checks.map((c) => c.name).join() : a.kind)), ['build'])
    const ran = record(ledger, p.actions[0], 5)
    const waiting = plan(input({ pr: pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'pending', 10)] }) }, ran))
    assert.deepEqual(waiting.actions, [])
    assert.match(waiting.reason, /failing: test; re-running build \(a rate limit\) once/)
    const sent = plan(input({ pr: pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'success', 10)] }) }, ran))
    assert.deepEqual(kinds(sent.actions), ['send-ci-failure'])
    assert.ok(sent.actions[0].kind === 'send-ci-failure' && sent.actions[0].checks.map((c) => c.name).join() === 'test')
  })

  test('flaky jobs of one workflow run go together; jobs of different runs, apart', () => {
    const checks = [job('test (1)', 'failure', 1, 500), job('test (2)', 'failure', 2, 500), job('e2e', 'failure', 3, 600)]
    const ledger: PrLedger = { ...emptyLedger(), flaky: Object.fromEntries(checks.map((c) => [checkKey(SHA, c.name), 'the runner shut down'])) }
    const p = plan(input({ pr: pr({ ci: 'failing', checks }) }, ledger))
    assert.deepEqual(p.actions.map((a) => (a.kind === 'rerun-check' ? a.checks.map((c) => c.name) : [])), [['test (1)', 'test (2)'], ['e2e']])
  })

  test('nothing is re-run once the failure already went to the worker', () => {
    const sent: PrLedger = { ...judged('a rate limit'), ci: { [SHA]: { at: 1, signature: 'test' } } }
    assert.deepEqual(plan(input({ pr: failing }, sent)).actions, [])
  })

  test('the setting defaults to on and is checked like the others', () => {
    assert.equal(validateConfig({}).config.fix.ci.rerunFlaky, true)
    assert.equal(validateConfig({ fix: { ci: { rerunFlaky: false } } }).config.fix.ci.rerunFlaky, false)
    const bad = validateConfig({ fix: { ci: { rerunFlaky: 'yes' }, comments: { rerunFlaky: true } } })
    assert.equal(bad.config.fix.ci.rerunFlaky, true)
    assert.ok(bad.errors.some((e) => e.includes('fix.ci.rerunFlaky')))
    assert.ok([...bad.errors, ...bad.warnings].some((e) => e.includes('fix.comments')))
  })
})

describe('an engine tick over a flaky check', () => {
  const T0 = 1_800_000_000_000
  const workspaces: Workspace[] = [{ id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }]
  function harness(prs: PrSnapshot[], details: (checks: readonly CheckInfo[]) => Record<string, string>, opts: { refuse?: boolean } = {}) {
    const store = new Map<string, unknown>()
    const executed: Action[] = []
    const read: string[][] = []
    let now = T0
    const github: GitHub = {
      async listOpen() {
        return { viewer: 'me', rate: null, prs: prs.map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: p.author, updatedAt: p.updatedAt, rollup: p.ci })) }
      },
      async detail(_repo, number) {
        const p = prs.find((x) => x.number === number)
        return { pr: p ? { ...p, fetchedAt: now } : null, rate: null }
      },
      async failureDetails(_repo, checks) {
        read.push(checks.map((c) => c.name))
        return details(checks)
      }
    }
    const executor: Executor = {
      execute: async (a) => (executed.push(a), opts.refuse && a.kind === 'rerun-check' ? { ok: false, error: 'gh api: HTTP 403 Resource not accessible by integration' } : { ok: true })
    }
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
    return { deps, store, executed, read, advance: (ms: number) => (now += ms) }
  }
  const lostRunner = () => ({ test: 'The runner has received a shutdown signal.' })

  test('a check that failed on a lost runner is re-run once; failing again, it goes to the worker', async () => {
    const prs = [pr({ number: 12, ci: 'failing', checks: [check('test', 'failure', 7)] })]
    const h = harness(prs, lostRunner)
    const dry = await tick(h.deps, { autopilot: false })
    assert.equal(h.executed.length, 0)
    assert.deepEqual(dry.tracks[0].next, ['re-run test once: the runner shut down'])
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check'])
    // The forge still shows the failed attempt a moment later: nothing goes to the worker yet.
    h.advance(20_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check'])
    assert.deepEqual(h.read, [['test']], 'read once for this commit and check, even across ticks')
    // The new attempt failed too.
    prs[0] = { ...prs[0], checks: [check('test', 'failure', 11)], updatedAt: '2026-11-10T11:00:00Z' }
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check', 'send-ci-failure'])
  })

  test('a re-run the forge refuses is recorded, and the failure goes to the worker on the next tick', async () => {
    const h = harness([pr({ number: 12, ci: 'failing', checks: [check('test', 'failure', 7)] })], lostRunner, { refuse: true })
    const first = await tick(h.deps, { autopilot: true })
    assert.match(first.repos[0].errors.join(), /403/)
    assert.match((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).reruns?.[checkKey(SHA, 'test')]?.error ?? '', /403/)
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    h.advance(60_000)
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check', 'send-ci-failure'], 'asked once, then sent once')
  })

  test('a real failure is read once and goes straight to the worker', async () => {
    const h = harness([pr({ number: 12, ci: 'failing', checks: [check('test', 'failure', 7)] })], () => ({ test: 'AssertionError: 1 !== 2' }))
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['send-ci-failure'])
  })

  test('a forge read that fails, or says nothing of a check, counts as a real failure and is not read again', async () => {
    const both = [check('test', 'failure', 7), check('lint', 'failure', 8)]
    const thrown = harness([pr({ number: 12, ci: 'failing', checks: both })], () => {
      throw new Error('gh: HTTP 502')
    })
    const deps = { ...thrown.deps, executor: null }
    for (let i = 0; i < 3; i++) (thrown.advance(45_000), await tick(deps, { autopilot: false }))
    assert.equal(thrown.read.length, 1)
    assert.deepEqual((thrown.store.get(ledgerKey('acme/app', 12)) as PrLedger).flaky, { [checkKey(SHA, 'test')]: null, [checkKey(SHA, 'lint')]: null })
    // Only part of it answered: the rest is real.
    const partial = harness([pr({ number: 12, ci: 'failing', checks: both })], lostRunner)
    await tick(partial.deps, { autopilot: true })
    assert.deepEqual(partial.executed.map((a) => (a.kind === 'rerun-check' ? `rerun ${a.checks.map((c) => c.name)}` : a.kind)), ['rerun test'])
  })

  test('a commit with more than 40 failing checks is read once, every check keeping its verdict', async () => {
    const many = Array.from({ length: 45 }, (_, i) => check(`test (shard ${i})`, 'failure', 1000 + i))
    const h = harness([pr({ number: 12, ci: 'failing', checks: many })], () => ({}))
    const deps = { ...h.deps, readConfig: async () => validateConfig({ review: { enabled: false }, fix: { ci: { enabled: false } } }) }
    for (let i = 0; i < 5; i++) (h.advance(45_000), await tick(deps, { autopilot: true }))
    assert.equal(h.read.length, 1)
    assert.equal(Object.keys((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).flaky ?? {}).length, 45)
  })
})

describe('the jobs behind GitHub checks', () => {
  const raw = (contexts: object[]) => ({
    number: 12,
    headRefOid: SHA,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { pageInfo: { hasNextPage: false }, nodes: contexts } } } }] }
  })

  test("only a GitHub Actions check run has a job: another app's check run and a status have none", () => {
    const snap = normalizePr(
      raw([
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 71, detailsUrl: 'https://github.com/acme/app/actions/runs/500/job/71', checkSuite: { app: { slug: 'github-actions' }, workflowRun: { databaseId: 500 } } },
        { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 72, detailsUrl: 'https://github.com/acme/app/security/code-scanning', checkSuite: { app: { slug: 'github-code-scanning' }, workflowRun: null } },
        { __typename: 'CheckRun', name: 'old', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 73, detailsUrl: 'https://github.com/acme/app/actions/runs/501/job/73' },
        { __typename: 'StatusContext', context: 'ci/circle', state: 'FAILURE', targetUrl: 'https://circleci.com/x' }
      ]),
      'acme/app',
      0
    )!
    assert.deepEqual(snap.checks.map((c) => [c.name, c.jobId, c.runId]), [['test', 71, 500], ['CodeQL', null, null], ['old', 73, 501], ['ci/circle', null, null]])
  })

  test('re-runs: one job alone, several of one workflow run together', async () => {
    const calls: (readonly string[])[] = []
    const exec: Exec = async (_file, args): Promise<ExecResult> => (calls.push(args), { code: 0, stdout: '', stderr: '' })
    const gh = createGitHub(exec)
    const repo = { owner: 'acme', name: 'app' }
    assert.deepEqual(await gh.rerun(repo, [job('test', 'failure', 71, 500)]), { ok: true })
    assert.deepEqual(calls[0], ['api', '-X', 'POST', 'repos/acme/app/actions/jobs/71/rerun'])
    await gh.rerun(repo, [job('test (1)', 'failure', 71, 500), job('test (2)', 'failure', 72, 500)])
    assert.deepEqual(calls[1], ['api', '-X', 'POST', 'repos/acme/app/actions/runs/500/rerun-failed-jobs'])
    assert.equal((await gh.rerun(repo, [check('CodeQL', 'failure', null)])).ok, false)
  })

  test('through the executor, too', async () => {
    const calls: (readonly string[])[] = []
    const exec: Exec = async (_file, args): Promise<ExecResult> => (calls.push(args), { code: 0, stdout: '', stderr: '' })
    const ex = createExecutor({ exec, orca: createOrcaCli(exec), notify: async () => {} })
    const out = await ex.execute({ kind: 'rerun-check', sha: SHA, checks: [check('test', 'failure', 77)], why: 'a rate limit' }, { repo: { owner: 'acme', name: 'app' }, pr: pr(), config: config(), root: '/r' })
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(calls[0], ['api', '-X', 'POST', 'repos/acme/app/actions/jobs/77/rerun'])
  })

  test('what is judged: failure annotations (not warnings) and the log tail', async () => {
    const calls: (readonly string[])[] = []
    const exec: Exec = async (_file, args): Promise<ExecResult> => {
      calls.push(args)
      return args[1].endsWith('/annotations')
        ? {
            code: 0,
            stderr: '',
            stdout: JSON.stringify([
              { message: 'Failed to restore: Cache service responded with 503', annotation_level: 'warning' },
              { message: 'The self-hosted runner: box lost communication with the server.', annotation_level: 'failure' }
            ])
          }
        : { code: 0, stderr: '', stdout: '2026-11-10T10:00:00.1Z step 1\n' }
    }
    const details = await createGitHub(exec).failureDetails!({ owner: 'acme', name: 'app' }, [check('test', 'failure', 77)])
    assert.deepEqual(calls.map((c) => c[1]), ['repos/acme/app/check-runs/77/annotations', 'repos/acme/app/actions/jobs/77/logs'])
    assert.ok(!details.test.includes('Cache service'), 'a warning is not what failed the job')
    assert.equal(flakyReason(details.test), 'the runner lost its connection')
  })
})

describe('re-running a GitLab job', () => {
  test('each job is retried where it ran, and its failure reason is judged', async () => {
    const g = fakeGlab((args) => (args.at(-1)?.endsWith('/jobs/16152393446') ? { stdout: JSON.stringify({ id: 16152393446, failure_reason: 'runner_system_failure' }) } : { stdout: 'Running on runner-1\n' }))
    const snap = normalizeMr(detailData().project.mergeRequest, KEY, HOST, 'me', 0)!
    const failed = snap.checks.filter((c) => c.state === 'failure')
    const ex = createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {} })
    const ctx = { repo: REPO, pr: snap, config: config(), root: '/r' }
    assert.deepEqual(await ex.execute({ kind: 'rerun-check', sha: SHA, checks: [failed[0]], why: 'the GitLab runner failed' }, ctx), { ok: true })
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', HOST, '-X', 'POST', 'projects/forks%2Fme%2Fapp/jobs/16152393446/retry'])
    const details = await createGitLab(g.exec).failureDetails!(REPO, failed)
    assert.deepEqual(g.calls.slice(1).map((c) => c.args.at(-1)), ['projects/forks%2Fme%2Fapp/jobs/16152393446', 'projects/forks%2Fme%2Fapp/jobs/16152393446/trace'])
    assert.equal(flakyReason(details[failed[0].name]), 'the GitLab runner failed')
  })
})
