// Flaky CI: a check that failed on the infrastructure runs once more before a worker gets it.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Exec, ExecResult } from './exec.ts'
import { createExecutor, type Executor } from './executor.ts'
import { FLAKY_SIGNS, flakyReason } from './flaky.ts'
import { createGitHub, type GitHub, type PrSnapshot } from './github.ts'
import { createGitLab, normalizeMr } from './gitlab.ts'
import { checkKey, emptyLedger, ledgerKey, record, type PrLedger } from './ledger.ts'
import { createOrcaCli } from './orca-cli.ts'
import { plan, type Action } from './plan.ts'
import { check, config, input, pr, SHA } from './testing/fixtures.ts'
import { detailData, fakeGlab, HOST, KEY, REPO } from './testing/gitlab.ts'

const kinds = (actions: Action[]) => actions.map((a) => a.kind)

describe('telling a flaky failure from a real one', () => {
  test('a lost runner, the network, a rate limit and GitLab runner failures look flaky', () => {
    const flaky: [string, string][] = [
      ['##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.', 'the runner shut down'],
      ['The self-hosted runner: box-3 lost communication with the server.', 'the runner lost its connection'],
      ['The hosted runner encountered an error while running your job.', 'the hosted runner failed'],
      ['npm ERR! code ECONNRESET', 'a network connection failed'],
      ['Error: connect ETIMEDOUT 140.82.112.3:443', 'a network connection failed'],
      ['getaddrinfo EAI_AGAIN registry.npmjs.org', 'a network connection failed'],
      ['fatal: unable to access: Could not resolve host: github.com', 'a host name did not resolve'],
      ['error: RPC failed; HTTP 502 Bad Gateway', 'a server was unavailable'],
      ['received unexpected HTTP status: 503 Service Unavailable', 'a server was unavailable'],
      ['net/http: TLS handshake timeout', 'a TLS handshake timed out'],
      ['toomanyrequests: 429 Too Many Requests', 'a rate limit'],
      ['API rate limit exceeded for installation', 'a rate limit'],
      ['failure_reason: runner_system_failure', 'the GitLab runner failed'],
      ['failure_reason: stuck_or_timeout_failure\nERROR: Job failed', 'the job got stuck waiting for a runner']
    ]
    for (const [text, why] of flaky) assert.equal(flakyReason(text), why, text)
  })

  test('failing tests, compile errors and tests that time out are real failures', () => {
    const real = [
      'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 2',
      'Error: Timeout of 2000ms exceeded. For async tests and hooks, ensure "done()" is called',
      'thrown: "Exceeded timeout of 5000 ms for a test."',
      'The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 360 minutes.',
      "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
      '##[error]Process completed with exit code 1.',
      'failure_reason: script_failure',
      'expected status 503 but got 200',
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
    assert.deepEqual(p.actions, [{ kind: 'rerun-check', sha: SHA, check: check('test', 'failure', 7), why: 'the runner shut down' }])
    assert.match(p.reason, /re-running test \(the runner shut down\) once/)
    const ran = record(judged('the runner shut down'), p.actions[0], 5)
    // Running again: the board says so.
    const pending = pr({ ci: 'pending', checks: [check('test', 'pending', 9), check('lint', 'success', 8)] })
    assert.equal(plan(input({ pr: pending }, ran)).reason, 're-running test (the runner shut down) once')
    // It failed again: now the worker gets it.
    assert.deepEqual(kinds(plan(input({ pr: failing }, ran)).actions), ['send-ci-failure'])
  })

  test('a real failure goes to the worker, and so does every failure with re-runs off', () => {
    assert.deepEqual(kinds(plan(input({ pr: failing }, judged(null))).actions), ['send-ci-failure'])
    assert.deepEqual(kinds(plan(input({ pr: failing }, emptyLedger())).actions), ['send-ci-failure'], 'not judged: as before')
    const off = config((c) => (c.fix.ci.rerunFlaky = false))
    assert.deepEqual(kinds(plan(input({ pr: failing, config: off }, judged('a rate limit'))).actions), ['send-ci-failure'])
    // A status from another CI (no job id) cannot be re-run.
    const external = pr({ ci: 'failing', checks: [check('ci/circle', 'failure', null)] })
    assert.deepEqual(kinds(plan(input({ pr: external }, judged('a rate limit', 'ci/circle'))).actions), ['send-ci-failure'])
  })

  test('only the flaky checks run again; the real failure waits for them, then goes alone', () => {
    const both = pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'failure', 6)] })
    const ledger: PrLedger = { ...emptyLedger(), flaky: { [checkKey(SHA, 'test')]: null, [checkKey(SHA, 'build')]: 'a rate limit' } }
    const p = plan(input({ pr: both }, ledger))
    assert.deepEqual(p.actions.map((a) => (a.kind === 'rerun-check' ? a.check.name : a.kind)), ['build'])
    const ran = record(ledger, p.actions[0], 5)
    const waiting = plan(input({ pr: pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'pending', 10)] }) }, ran))
    assert.deepEqual(waiting.actions, [])
    assert.match(waiting.reason, /failing: test; re-running build \(a rate limit\) once/)
    const sent = plan(input({ pr: pr({ ci: 'failing', checks: [check('test', 'failure', 7), check('build', 'success', 10)] }) }, ran))
    assert.deepEqual(kinds(sent.actions), ['send-ci-failure'])
    assert.ok(sent.actions[0].kind === 'send-ci-failure' && sent.actions[0].checks.map((c) => c.name).join() === 'test')
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
  function harness(prs: PrSnapshot[], details: Record<string, string>) {
    const store = new Map<string, unknown>()
    const executed: Action[] = []
    const read: string[][] = []
    const github: GitHub = {
      async listOpen() {
        return { viewer: 'me', rate: null, prs: prs.map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: p.author, updatedAt: p.updatedAt, rollup: p.ci })) }
      },
      async detail(_repo, number) {
        const p = prs.find((x) => x.number === number)
        return { pr: p ? { ...p, fetchedAt: T0 } : null, rate: null }
      },
      async failureDetails(_repo, checks) {
        read.push(checks.map((c) => c.name))
        return details
      }
    }
    const executor: Executor = { execute: async (a) => (executed.push(a), { ok: true }) }
    const deps: EngineDeps = {
      now: () => T0,
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
    return { deps, store, executed, read }
  }

  test('a check that failed on a lost runner is re-run once; failing again, it goes to the worker', async () => {
    const prs = [pr({ number: 12, ci: 'failing', checks: [check('test', 'failure', 7)] })]
    const h = harness(prs, { test: 'The runner has received a shutdown signal.' })
    const dry = await tick(h.deps, { autopilot: false })
    assert.equal(h.executed.length, 0)
    assert.deepEqual(dry.tracks[0].next, ['re-run test once: the runner shut down'])
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check'])
    assert.deepEqual(h.read, [['test']], 'read once for this commit and check, even across ticks')
    assert.equal((h.store.get(ledgerKey('acme/app', 12)) as PrLedger).reruns?.[checkKey(SHA, 'test')]?.why, 'the runner shut down')
    // The re-run failed too.
    prs[0] = { ...prs[0], checks: [check('test', 'failure', 11)], updatedAt: '2026-11-10T11:00:00Z' }
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['rerun-check', 'send-ci-failure'])
  })

  test('a real failure is read once and goes straight to the worker', async () => {
    const h = harness([pr({ number: 12, ci: 'failing', checks: [check('test', 'failure', 7)] })], { test: 'AssertionError: 1 !== 2' })
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((a) => a.kind), ['send-ci-failure'])
  })
})

describe('re-running a job on each forge', () => {
  const ctx = { pr: pr(), config: config(), root: '/r' }
  function fake(reply: (args: readonly string[]) => Partial<ExecResult> = () => ({})) {
    const calls: (readonly string[])[] = []
    const exec: Exec = async (_file, args) => (calls.push(args), { code: 0, stdout: '', stderr: '', ...reply(args) })
    return { exec, calls }
  }

  test('GitHub: the one job, not its whole workflow', async () => {
    const f = fake()
    const ex = createExecutor({ exec: f.exec, orca: createOrcaCli(f.exec), notify: async () => {} })
    const out = await ex.execute({ kind: 'rerun-check', sha: SHA, check: check('test', 'failure', 77), why: 'a rate limit' }, { ...ctx, repo: { owner: 'acme', name: 'app' } })
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(f.calls[0], ['api', '-X', 'POST', 'repos/acme/app/actions/jobs/77/rerun'])
  })

  test("GitHub: a check's annotations and log tail are what is judged", async () => {
    const f = fake((args) =>
      args[1].endsWith('/annotations')
        ? { stdout: JSON.stringify([{ message: 'The self-hosted runner: box lost communication with the server.', annotation_level: 'failure' }]) }
        : { stdout: '2026-11-10T10:00:00.1Z step 1\n' }
    )
    const details = await createGitHub(f.exec).failureDetails!({ owner: 'acme', name: 'app' }, [check('test', 'failure', 77)])
    assert.deepEqual(f.calls.map((c) => c[1]), ['repos/acme/app/check-runs/77/annotations', 'repos/acme/app/actions/jobs/77/logs'])
    assert.equal(flakyReason(details.test), 'the runner lost its connection')
    assert.match(details.test, /step 1/)
  })

  test('GitLab: the job is retried where it ran, and its failure reason is judged', async () => {
    const g = fakeGlab((args) => (args.at(-1)?.endsWith('/jobs/16152393446') ? { stdout: JSON.stringify({ id: 16152393446, failure_reason: 'runner_system_failure' }) } : { stdout: 'Running on runner-1\n' }))
    const snap = normalizeMr(detailData().project.mergeRequest, KEY, HOST, 'me', 0)!
    const failed = snap.checks.filter((c) => c.state === 'failure')
    const ex = createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {} })
    assert.deepEqual(await ex.execute({ kind: 'rerun-check', sha: SHA, check: failed[0], why: 'the GitLab runner failed' }, { ...ctx, repo: REPO, pr: snap }), { ok: true })
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', HOST, '-X', 'POST', 'projects/forks%2Fme%2Fapp/jobs/16152393446/retry'])
    const details = await createGitLab(g.exec).failureDetails!(REPO, failed)
    assert.deepEqual(g.calls.slice(1).map((c) => c.args.at(-1)), ['projects/forks%2Fme%2Fapp/jobs/16152393446', 'projects/forks%2Fme%2Fapp/jobs/16152393446/trace'])
    assert.equal(flakyReason(details[failed[0].name]), 'the GitLab runner failed')
  })
})
