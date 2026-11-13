import { assert, describe, test } from 'orca/testing'
import type { ReviewerSpec } from './config.ts'
import { blockingReason, unlockedResume, createCrew, LATE_VERDICT_MS, PROBE_AFTER_MS, REVIEWER_TIMEOUT_MS, type Crew, type CrewDeps } from './crew.ts'
import { createLockdown, type Lockdown } from './lockdown.ts'
import type { Exec } from './exec.ts'
import { emptyLedger } from './ledger.ts'
import type { OrcaCli } from './orca-cli.ts'
import { plan, type Action } from './plan.ts'
import { aggregate, findingsMessage, githubReview, mergeFindings, parseVerdict, reviewerBrief, verdictPath, type Finding } from './review.ts'
import { config, input, owner, pr, SHA } from './testing/fixtures.ts'
import { reviewGuard } from './worker.ts'

const R = (name: string, agent: string, blocking = true): ReviewerSpec => ({ name, agent, model: `${agent}-model`, blocking })
const F = (over: Partial<Finding> = {}): Finding => ({ severity: 'major', file: 'src/a.ts', line: 10, title: 'Null check missing on user', detail: 'd', suggestion: '', ...over })

describe('verdicts', () => {
  test('parse tolerates wording and a fenced block, and rejects nonsense', () => {
    const v = parseVerdict('Here:\n```json\n{"verdict":"changes requested","summary":"s","findings":[{"severity":"HIGH","path":"a.ts","line":3,"title":"t"}]}\n```')
    assert.equal(v?.verdict, 'request_changes')
    assert.deepEqual([v?.findings[0].severity, v?.findings[0].file], ['major', 'a.ts'])
    assert.equal(parseVerdict('{"verdict":"maybe"}'), null)
    assert.equal(parseVerdict('not json'), null)
  })

  test('two reviewers on the same line and issue merge into one finding with both names', () => {
    const merged = mergeFindings([
      { reviewer: 'correctness', findings: [F({ severity: 'minor' })] },
      { reviewer: 'security', findings: [F({ line: 12, title: 'Missing null check on user', severity: 'blocker' }), F({ file: 'b.ts', title: 'Other' })] }
    ])
    assert.equal(merged.length, 2)
    assert.deepEqual(merged[0].reviewers, ['correctness', 'security'])
    assert.equal(merged[0].severity, 'blocker')
  })

  test('pass policies', () => {
    const approve = { verdict: 'approve' as const, summary: '', findings: [] }
    const changes = { verdict: 'request_changes' as const, summary: '', findings: [F()] }
    const review = config().review
    const results = [{ reviewer: R('a', 'claude'), verdict: approve }, { reviewer: R('b', 'codex'), verdict: changes }, { reviewer: R('c', 'grok', false), verdict: approve }]
    assert.equal(aggregate(results, { ...review, pass: 'all-blocking-approve' }).verdict, 'changes')
    assert.equal(aggregate(results, { ...review, pass: 'majority' }).verdict, 'pass')
    assert.equal(aggregate(results, { ...review, pass: 'no-blockers', blockAt: 'blocker' }).verdict, 'pass')
    const out = aggregate(results, review)
    assert.equal(out.blocking.length, 1)
    assert.match(out.summary, /b: request changes/)
  })

  test('the brief names the verdict file, the base and the last round\'s open findings', () => {
    const brief = reviewerBrief({ pr: pr(), reviewer: { ...R('security', 'codex'), focus: 'authz' }, round: 2, maxRounds: 3, previous: { sha: 'f'.repeat(40), findings: [{ ...F(), reviewers: ['security'] }] } })
    assert.ok(brief.includes(verdictPath(SHA, 'security')))
    assert.ok(brief.includes('git diff origin/main...HEAD'))
    assert.ok(brief.includes('Your focus: authz'))
    assert.ok(brief.includes('Null check missing on user'))
  })

  test('the GitHub review is a marked comment review with only blocking, line-anchored findings inline', () => {
    const outcome = aggregate([{ reviewer: R('a', 'claude'), verdict: { verdict: 'request_changes', summary: '', findings: [F(), F({ file: null, line: null, title: 'General', severity: 'blocker' }), F({ severity: 'nit', title: 'Style', file: 'c.ts' })] } }], config().review)
    const g = githubReview(pr(), outcome, 1)
    assert.ok(g.body.startsWith('<!-- matriarch:review round=1'))
    assert.deepEqual(g.comments.map((c) => c.path), ['src/a.ts'])
  })
})

function crewHarness(files: Record<string, string>, opts: { lockdown?: Lockdown; hookRuns?: boolean; terminals?: Record<string, string[]> } = {}) {
  const calls: string[][] = []
  let now = 1_000
  const store = new Map<string, unknown>()
  let crew: Crew | null = null
  const orca: OrcaCli = {
    async run(args) {
      calls.push([...args])
      if (args[0] === 'worktree' && args[1] === 'create') return { worktree: { path: '/wt/review-12' } }
      if (args[0] === 'terminal' && args[1] === 'list') return { terminals: Object.keys(opts.terminals ?? {}).map((handle) => ({ handle })) }
      if (args[0] === 'terminal' && args[1] === 'read') return { terminal: { tail: opts.terminals?.[args[3]] ?? [] } }
      if (args[0] === 'terminal' && args[1] === 'close' && opts.terminals) delete opts.terminals[args[3]]
      if (args[0] === 'agent' && args[1] === 'launch') {
        // Orca runs the launch hook while it starts the agent, unless it timed out.
        if (opts.lockdown && opts.hookRuns !== false) {
          const decision = opts.lockdown.onLaunch({ agent: args[3], workspaceId: 'repo1::/wt/review-12', command: `${args[3]} --dangerously-skip-permissions 'brief'` }, crew!.guard())
          if (decision && 'deny' in decision) throw new Error(decision.deny)
        }
        return { outcome: { kind: 'terminal', handle: `term-${args[3]}` } }
      }
      return {}
    }
  }
  const exec: Exec = async (_file, args) => ({ code: 0, stdout: args.includes('rev-parse') ? `${SHA}\n` : '', stderr: '' })
  const deps: CrewDeps = {
    orca,
    exec,
    readFile: async (path) => files[path] ?? null,
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    now: () => now,
    log: () => {},
    workspaceIdFor: async () => 'ws-review',
    lockdown: opts.lockdown,
    lockConfirmMs: 0
  }
  crew = createCrew(deps)
  return { crew, calls, store, advance: (ms: number) => (now += ms) }
}

describe('review crew', () => {
  const reviewers = [R('correctness', 'claude'), R('security', 'codex')]

  test('a round: pinned worktree, one agent per reviewer on its model, verdicts, cleanup', async () => {
    const files: Record<string, string> = {}
    const h = crewHarness(files)
    const run = await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers })
    assert.equal(run.status, 'running')
    const create = h.calls.find((c) => c[1] === 'create')!
    assert.ok(create.includes('origin/feature/login') && create.includes('--setup') && create.includes('--no-parent'))
    const launches = h.calls.filter((c) => c[1] === 'launch')
    assert.deepEqual(launches.map((c) => [c[3], c[c.indexOf('--model') + 1], c[c.indexOf('--surface') + 1]]), [['claude', 'claude-model', 'terminal'], ['codex', 'codex-model', 'terminal']])
    assert.ok(h.crew.guard().ids.has('ws-review'))

    assert.deepEqual(await h.crew.poll(), [], 'nothing settles before the verdicts exist')
    files[`/wt/review-12/${verdictPath(SHA, 'correctness')}`] = '{"verdict":"approve","summary":"ok","findings":[]}'
    files[`/wt/review-12/${verdictPath(SHA, 'security')}`] = '{"verdict":"approve","summary":"ok","findings":[{"severity":"minor","file":"a.ts","line":1,"title":"t"}]}'
    const done = await h.crew.poll()
    assert.equal(done.length, 1)
    assert.equal(done[0].outcome?.verdict, 'pass')
    assert.ok(h.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm' && c.includes('--delete-branch')))
    assert.equal(h.crew.guard().ids.size, 0)
    assert.equal((await h.crew.get('acme/app', 12, SHA))?.cleaned, true)
  })

  test('a blocking reviewer that never writes a verdict fails the round after the timeout', async () => {
    const files: Record<string, string> = {}
    const h = crewHarness(files)
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers })
    files[`/wt/review-12/${verdictPath(SHA, 'correctness')}`] = '{"verdict":"approve","summary":"","findings":[]}'
    await h.crew.poll()
    h.advance(REVIEWER_TIMEOUT_MS + 1)
    const [run] = await h.crew.poll()
    assert.equal(run.status, 'failed')
    assert.match(run.error ?? '', /blocking reviewer/)
    assert.ok(!h.calls.some((c) => c[1] === 'rm'), 'a failed round keeps its worktree to inspect')
  })
})

describe('reviewers start locked down', () => {
  test('each launch is confirmed read-only by the hook, in its own agent\'s mode', async () => {
    const h = crewHarness({}, { lockdown: createLockdown(() => 1_000) })
    const run = await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude'), R('security', 'codex')] })
    assert.equal(run.status, 'running')
    assert.deepEqual(run.reviewers.map((r) => [r.status, r.lock]), [['running', 'claude-dontask'], ['running', 'codex-sandbox']])
  })

  test('a reviewer Orca started without the lockdown is stopped at once', async () => {
    const h = crewHarness({}, { lockdown: createLockdown(() => 1_000), hookRuns: false })
    const run = await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude'), R('security', 'codex')] })
    assert.deepEqual(h.calls.filter((c) => c[0] === 'terminal' && c[1] === 'close').map((c) => c[3]), ['term-claude', 'term-codex'])
    assert.ok(run.reviewers.every((r) => r.status === 'failed' && /lockdown/.test(r.error ?? '')))
    assert.equal(run.status, 'failed')
    assert.match(run.error ?? '', /no reviewer could be started \(correctness: stopped/)
    assert.ok(h.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm'), 'nothing is reviewing, so the worktree goes now')
  })

  test('another agent is not started unless readOnly is false, and then runs unlocked', async () => {
    const h = crewHarness({}, { lockdown: createLockdown(() => 1_000) })
    const run = await h.crew.start({
      pr: pr(), root: '/r', config: config(), round: 1,
      reviewers: [R('style', 'gemini'), { ...R('docs', 'opencode'), readOnly: false }, R('security', 'codex')]
    })
    assert.deepEqual(h.calls.filter((c) => c[1] === 'launch').map((c) => c[3]), ['opencode', 'codex'], 'gemini is never launched')
    assert.match(run.reviewers[0].error ?? '', /readOnly/)
    assert.deepEqual(run.reviewers.slice(1).map((r) => [r.status, r.lock]), [['running', 'off'], ['running', 'codex-sandbox']])
  })
})

describe('read-only reviewers', () => {
  const guard = { ids: new Set(['ws-review']), paths: ['/wt/review-12'] }
  test('edits are refused in a review worktree, except the verdict file', () => {
    assert.ok(reviewGuard({ tool: 'Edit', workspaceId: 'ws-review', input: { file_path: '/wt/review-12/src/a.ts' } }, guard))
    assert.equal(reviewGuard({ tool: 'Write', workspaceId: 'ws-review', input: { file_path: `/wt/review-12/${verdictPath(SHA, 'x')}` } }, guard), null)
    assert.ok(reviewGuard({ tool: 'Bash', workspaceId: 'ws-review', input: { command: 'git push origin HEAD' } }, guard))
    assert.equal(reviewGuard({ tool: 'Bash', workspaceId: 'ws-review', input: { command: 'git diff origin/main...HEAD' } }, guard), null)
  })
  test('a review worktree is recognised by its Orca id even before the id was learned', () => {
    const early = { ids: new Set<string>(), paths: ['/wt/review-12'] }
    assert.ok(reviewGuard({ tool: 'Bash', workspaceId: 'repo1::/wt/review-12', input: { command: 'git push origin HEAD' } }, early))
    assert.equal(reviewGuard({ tool: 'Bash', workspaceId: 'repo1::/wt/review-123', input: { command: 'git push origin HEAD' } }, early), null)
  })

  test('other workspaces are untouched', () => {
    assert.equal(reviewGuard({ tool: 'Edit', workspaceId: 'ws-worker', input: { file_path: '/wt/login/src/a.ts' } }, guard), null)
    assert.ok(reviewGuard({ tool: 'Write', workspaceId: null, input: { file_path: '/wt/review-12/src/a.ts' } }, guard), 'matched by path when Orca cannot name the workspace')
  })
})

describe('planner after a review', () => {
  const changes = { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'changes' as const, findings: 2 } } }
  const kinds = (a: Action[]) => a.map((x) => x.kind)
  const local = config((c) => (c.review.publish = 'orca-only'))

  test('sends the findings to the owning worker once', () => {
    assert.deepEqual(kinds(plan(input({ config: local }, changes)).actions), ['send-findings'])
    const delivered = { ...changes, reviews: { [SHA]: { ...changes.reviews[SHA], delivered: true } } }
    assert.deepEqual(plan(input({ config: local }, delivered)).actions, [])
  })

  test('with no worker to fix it, it escalates; with publish "github" it posts once', () => {
    assert.deepEqual(kinds(plan(input({ config: local, owner: owner({ address: null }) }, changes)).actions), ['escalate'])
    const gh = config((c) => (c.review.publish = 'github'))
    assert.deepEqual(kinds(plan(input({ config: gh }, changes)).actions), ['publish-review', 'send-findings'])
    const passed = { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'pass' as const } } }
    assert.deepEqual(kinds(plan(input({ config: gh }, passed)).actions), ['publish-review', 'notify'])
  })
})

describe('reviewers stuck on a prompt', () => {
  test('a quiet reviewer whose terminal shows a blocking prompt is flagged for you', async () => {
    const files: Record<string, string> = {}
    const orcaRuns: string[][] = []
    const alerts: string[] = []
    // Terminals answer here: the Claude pane shows the bypass-permissions warning.
    const crew = createCrew({
      orca: {
        async run(args) {
          orcaRuns.push([...args])
          if (args[1] === 'create') return { worktree: { path: '/wt/review-12', id: 'repo1::/wt/review-12' } }
          if (args[1] === 'launch') return { outcome: { kind: 'terminal' } } // no handle in the receipt
          if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [{ handle: 'term-a' }, { handle: 'term-b' }] }
          if (args[0] === 'terminal' && args[1] === 'read') {
            return { terminal: { tail: args[3] === 'term-b' ? ['WARNING: Claude Code running in Bypass Permissions mode', '❯ No, exit'] : ['working…'] } }
          }
          return {}
        }
      },
      exec: async (_f, args) => ({ code: 0, stdout: args.includes('rev-parse') ? `${SHA}\n` : '', stderr: '' }),
      readFile: async (p) => files[p] ?? null,
      store: (() => {
        const m = new Map<string, unknown>()
        return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: unknown) => void m.set(k, v) }
      })(),
      now: (() => {
        let t = 0
        return () => (t += 30_000)
      })(),
      log: () => {},
      workspaceIdFor: async () => null,
      alert: async (_run, r) => void alerts.push(`${r.name}:${r.blockedTerminal}`)
    })
    await crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude')] })
    assert.ok(orcaRuns.some((a) => a[0] === 'worktree' && a[1] === 'set' && a.includes('--pr') && a.includes('Matriarch review · #12 · a1b2c3d')), 'labelled in the sidebar')
    assert.ok(crew.guard().ids.has('repo1::/wt/review-12'), 'the workspace id comes from the create receipt')
    await crew.poll() // 30 s quiet: too early to look
    await crew.poll() // 60 s quiet: its terminals are checked
    const run = await crew.get('acme/app', 12, SHA)
    assert.match(run?.reviewers[0].blocked ?? '', /bypass-permissions/)
    assert.ok(orcaRuns.some((a) => a[0] === 'terminal' && a[1] === 'list'))
    assert.deepEqual(alerts, ['correctness:term-b'], 'one alert, naming the terminal with the prompt')
    // Well past the timeout, it still waits for the person instead of failing the round.
    for (let i = 0; i < 70; i++) await crew.poll()
    const later = await crew.get('acme/app', 12, SHA)
    assert.equal(later?.status, 'running')
    assert.equal(later?.reviewers[0].status, 'running')
    assert.equal(alerts.length, 1, 'no repeat alerts while it stays stuck')
  })
})

describe('late verdicts', () => {
  test('a round that timed out completes when the missing verdict arrives later', async () => {
    const files: Record<string, string> = {}
    const h = crewHarness(files)
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude'), R('security', 'codex')] })
    files[`/wt/review-12/${verdictPath(SHA, 'security')}`] = '{"verdict":"approve","summary":"","findings":[]}'
    h.advance(REVIEWER_TIMEOUT_MS + 1)
    const [failed] = await h.crew.poll()
    assert.equal(failed.status, 'failed')
    assert.equal(await h.crew.revive('acme/app', 12, SHA), null, 'nothing to adopt yet')
    files[`/wt/review-12/${verdictPath(SHA, 'correctness')}`] = '{"verdict":"approve","summary":"","findings":[]}'
    const done = await h.crew.revive('acme/app', 12, SHA)
    assert.equal(done?.status, 'done')
    assert.equal(done?.outcome?.verdict, 'pass')
    assert.ok(h.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm'), 'then the worktree is removed')
  })
})

describe('a slow reviewer is not a failed one', () => {
  function liveHarness() {
    let now = 0
    const cursor = 38
    let seconds = 0
    let talking = true
    const store = new Map<string, unknown>()
    const crew = createCrew({
      orca: {
        async run(args) {
          if (args[1] === 'create') return { worktree: { path: '/wt/review-12' } }
          if (args[1] === 'launch') return { outcome: { kind: 'terminal' } }
          if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [{ handle: 't1' }] }
          if (args[0] === 'terminal' && args[1] === 'read') {
            // Thinking: the same lines redrawn, the timer ticking; the line cursor never moves.
            if (talking) seconds += 17
            return { terminal: { tail: ['Nearly done. Collecting exact line numbers.', `✳ Nesting… (${seconds}s · still thinking)`], latestCursor: cursor } }
          }
          return {}
        }
      },
      exec: async (_f, args) => ({ code: 0, stdout: args.includes('rev-parse') ? `${SHA}\n` : '', stderr: '' }),
      readFile: async () => null,
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      now: () => now,
      log: () => {},
      workspaceIdFor: async () => null
    })
    return { crew, tick: (ms: number) => (now += ms), quiet: () => (talking = false), talk: () => (talking = true) }
  }

  test('a reviewer still producing output is never timed out', async () => {
    const h = liveHarness()
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude')] })
    for (let i = 0; i < 8; i++) {
      h.tick(10 * 60_000) // 80 minutes in all, output every look
      await h.crew.poll()
    }
    assert.equal((await h.crew.get('acme/app', 12, SHA))?.status, 'running')
    h.quiet()
    h.tick(REVIEWER_TIMEOUT_MS + 60_000)
    await h.crew.poll()
    assert.equal((await h.crew.get('acme/app', 12, SHA))?.status, 'failed', 'quiet past the limit does fail')
  })

  test('a round failed while its reviewer kept working goes back to running', async () => {
    const h = liveHarness()
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude')] })
    h.quiet()
    h.tick(PROBE_AFTER_MS + 1)
    await h.crew.poll() // first look: cursors recorded, no output yet
    h.tick(REVIEWER_TIMEOUT_MS + 1)
    await h.crew.poll()
    assert.equal((await h.crew.get('acme/app', 12, SHA))?.status, 'failed')
    // The polls already recorded where output stood, so new output resumes the round at once.
    h.talk()
    h.tick(45_000)
    const resumed = await h.crew.revive('acme/app', 12, SHA)
    assert.equal(resumed?.status, 'running')
    assert.equal(resumed?.reviewers[0].status, 'running')
  })
})

describe('stale and leftover review worktrees', () => {
  test('a new push stops the round on the old commit and removes its worktree', async () => {
    const h = crewHarness({})
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude')] })
    const stopped = await h.crew.supersede('acme/app', 12, 'f'.repeat(40))
    assert.equal(stopped.length, 1)
    assert.match(stopped[0].error ?? '', /superseded/)
    assert.ok(h.calls.some((c) => c[1] === 'rm'))
    assert.deepEqual(await h.crew.poll(), [], 'it is no longer polled')
    assert.deepEqual(await h.crew.supersede('acme/app', 12, SHA), [], 'the head round itself is never stopped')
  })

  test('a failed round keeps its worktree for the late-verdict window, then it is swept', async () => {
    const h = crewHarness({})
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude')] })
    h.advance(REVIEWER_TIMEOUT_MS + 1)
    await h.crew.poll() // times out: kept
    await h.crew.sweep()
    assert.ok(!h.calls.some((c) => c[1] === 'rm'), 'kept during the window')
    h.advance(LATE_VERDICT_MS + 1)
    await h.crew.sweep()
    assert.ok(h.calls.some((c) => c[1] === 'rm'), 'swept after it')
    assert.equal((await h.crew.get('acme/app', 12, SHA))?.cleaned, true)
  })
})

describe('a reviewer stopped by its account', () => {
  test('a usage limit or a rate-limit menu is recognised as needing you', () => {
    const codex = ["■ You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at", 'Nov 15th, 2026 1:34 PM.']
    assert.match(blockingReason(codex) ?? '', /usage limit/)
    const menu = ['  Approaching rate limits', '  Switch to gpt-6-luna for lower credit usage?', '› 1. Switch to gpt-6-luna']
    assert.match(blockingReason(menu) ?? '', /cheaper model/)
  })

  test('restarting one reviewer relaunches it, locked down, and leaves the others alone', async () => {
    const files: Record<string, string> = {}
    const h = crewHarness(files, { lockdown: createLockdown(() => 1_000) })
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude'), R('security', 'codex')] })
    files[`/wt/review-12/${verdictPath(SHA, 'correctness')}`] = '{"verdict":"approve","summary":"ok","findings":[]}'
    await h.crew.poll()
    const res = await h.crew.restart({ pr: pr(), config: { ...config(), reviewers: [R('correctness', 'claude'), R('security', 'codex')] }, name: 'security' })
    assert.equal(res.restarted, true)
    assert.ok(h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close' && c[3] === 'term-codex'), 'the stuck terminal is closed')
    assert.equal(h.calls.filter((c) => c[1] === 'launch' && c[3] === 'codex').length, 2)
    const run = (await h.crew.get('acme/app', 12, SHA))!
    assert.deepEqual(run.reviewers.map((r) => [r.name, r.status, r.lock ?? null]), [['correctness', 'done', 'claude-dontask'], ['security', 'running', 'codex-sandbox']])
    assert.equal((await h.crew.restart({ pr: pr(), config: config(), name: 'correctness' })).restarted, false, 'a reviewer with a verdict is not restarted')
  })
})

describe('an agent Orca resumes without the lockdown', () => {
  test('a resume line without the lockdown flags is caught; a locked one and prose are not', () => {
    assert.equal(unlockedResume(["➜  review-1-a600d56-4glx codex '-c' 'disable_paste_burst=true' 'resume' '01a1d240'"]), 'codex')
    assert.equal(unlockedResume(['➜ wt claude --resume 9f2c']), 'claude')
    assert.equal(unlockedResume(['➜ wt codex resume x --sandbox workspace-write']), null)
    assert.equal(unlockedResume(['➜ wt claude --permission-mode dontAsk --resume 9f2c']), null)
    assert.equal(unlockedResume(['Do not retry a refused command; resume reading with git']), null)
  })

  test('its terminal is closed and the reviewer starts again, locked down, at most twice', async () => {
    const terminals: Record<string, string[]> = {}
    // The hook's clock is never behind the crew's, which moves on below.
    const h = crewHarness({}, { lockdown: createLockdown(() => Number.MAX_SAFE_INTEGER), terminals })
    await h.crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [R('correctness', 'claude'), R('security', 'codex')] })
    h.advance(PROBE_AFTER_MS + 1)
    terminals['term-resumed'] = ["➜  review-12 codex '-c' 'disable_paste_burst=true' 'resume' '01a1'"]
    await h.crew.poll()
    assert.ok(h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close' && c[3] === 'term-resumed'))
    const run = (await h.crew.get('acme/app', 12, SHA))!
    const security = run.reviewers.find((r) => r.name === 'security')!
    assert.deepEqual([security.status, security.lock, security.restarts], ['running', 'codex-sandbox', 1])
    assert.equal(run.reviewers.find((r) => r.name === 'correctness')!.restarts, undefined, 'the Claude reviewer is left alone')
    // A reviewer whose agent quit (an update asking for a restart) starts again too, within the cap.
    terminals['term-codex'] = ['🎉 Update ran successfully! Please restart Codex.']
    await h.crew.poll()
    terminals['term-codex'] = ['🎉 Update ran successfully! Please restart Codex.']
    await h.crew.poll()
    const after = (await h.crew.get('acme/app', 12, SHA))!.reviewers.find((r) => r.name === 'security')!
    assert.equal(after.restarts, 2)
    assert.equal(h.calls.filter((c) => c[1] === 'launch' && c[3] === 'codex').length, 3, 'started once, then twice again, and no more')
  })
})

test('the worker gets every finding the summary counts: the required ones, then the optional', () => {
  const outcome = aggregate(
    [{ reviewer: R('a', 'claude'), verdict: { verdict: 'request_changes', summary: '', findings: [F({ title: 'Swallowed write error' }), F({ severity: 'nit', title: 'Typo in log', file: 'docs/x.md' }), F({ severity: 'minor', title: 'Missing test', file: 'src/b.rs' })] } }],
    config().review
  )
  const m = findingsMessage(pr(), outcome, 2, 3)
  assert.match(m.body, /3 finding\(s\), 1 at or above major/)
  assert.match(m.body, /Required to pass \(1\):\n1\. \[major\].*Swallowed write error/)
  assert.match(m.body, /Optional \(2, below the blocking level\)/)
  assert.ok(m.body.includes('Typo in log') && m.body.includes('Missing test'))
})

describe('cheaper follow-up rounds and a fallback reviewer', () => {
  test('a focused follow-up round reads only what changed since the last review', () => {
    const previous = { sha: 'f'.repeat(40), findings: [{ ...F(), reviewers: ['a'] }] }
    const focused = reviewerBrief({ pr: pr(), reviewer: R('a', 'claude'), round: 2, maxRounds: 3, previous, focused: true })
    assert.ok(focused.includes(`git diff ${'f'.repeat(12)}..HEAD`))
    assert.ok(focused.includes('do not review again code that did not change'))
    const full = reviewerBrief({ pr: pr(), reviewer: R('a', 'claude'), round: 2, maxRounds: 3, previous, focused: false })
    assert.ok(full.includes('git diff origin/main...HEAD'))
    const first = reviewerBrief({ pr: pr(), reviewer: R('a', 'claude'), round: 1, maxRounds: 3, previous: null, focused: true })
    assert.ok(first.includes('git diff origin/main...HEAD'), 'the first round always reads the whole PR')
  })

  test('a reviewer whose account runs out moves to the fallback, locked down, once', async () => {
    const terminals: Record<string, string[]> = {}
    const h = crewHarness({}, { lockdown: createLockdown(() => Number.MAX_SAFE_INTEGER), terminals })
    const cfg = { ...config(), review: { ...config().review, fallback: { agent: 'claude', model: 'claude-sonnet-5-5' } } }
    await h.crew.start({ pr: pr(), root: '/r', config: cfg, round: 1, reviewers: [R('security', 'codex')] })
    h.advance(PROBE_AFTER_MS + 1)
    terminals['term-codex'] = ["■ You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits"]
    await h.crew.poll()
    const r = (await h.crew.get('acme/app', 12, SHA))!.reviewers[0]
    assert.deepEqual([r.name, r.agent, r.model, r.status, r.lock, r.fellBack], ['security', 'claude', 'claude-sonnet-5-5', 'running', 'claude-dontask', true])
    assert.ok(h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close' && c[3] === 'term-codex'))
  })
})
