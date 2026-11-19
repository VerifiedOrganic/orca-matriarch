import { assert, describe, test } from 'orca/testing'
import { emptyLedger, record, type PrLedger } from './ledger.ts'
import { CI_GRACE_MS, DRAFT_NUDGE_MS, MERGE_TIMEOUT_MS, plan, selectReviewers, type Action } from './plan.ts'
import { check, config, input, owner, pr, SHA, thread } from './testing/fixtures.ts'

const kinds = (actions: Action[]) => actions.map((a) => a.kind)
// A review that passed and was already posted, so these tests see only the merge gate.
const passReview = (l: PrLedger = emptyLedger()): PrLedger => ({ ...l, reviews: { [SHA]: { round: 1, status: 'done', startedAt: 1, verdict: 'pass', published: true } } })

describe('lanes before any action', () => {
  test('a worker mid-turn is never interrupted', () => {
    const p = plan(input({ owner: owner({ activity: 'working' }), pr: pr({ ci: 'failing', checks: [check('test', 'failure')] }) }))
    assert.equal(p.lane, 'working')
    assert.deepEqual(p.actions, [])
  })

  test('merged, closed and draft PRs only report', () => {
    assert.equal(plan(input({ pr: pr({ state: 'MERGED' }) })).lane, 'merged')
    assert.equal(plan(input({ pr: pr({ state: 'CLOSED' }) })).lane, 'closed')
    assert.equal(plan(input({ pr: pr({ draft: true }) })).lane, 'draft')
    // A draft someone is working on is work, not idle; a draft whose worker is stuck needs someone.
    assert.equal(plan(input({ pr: pr({ draft: true }), owner: owner({ activity: 'working' }) })).lane, 'working')
    assert.equal(plan(input({ pr: pr({ draft: true }), owner: owner({ activity: 'waiting' }) })).lane, 'needs-you')
    assert.equal(plan(input({ pr: pr({ draft: true }), owner: owner({ activity: 'done' }) })).lane, 'draft')
  })

  test('a draft nobody works on gets the supervisor asked once per commit to mark it ready', () => {
    const quiet = (over: Partial<Parameters<typeof input>[0]>) =>
      plan(input({ pr: pr({ draft: true }), owner: owner({ activity: 'done' }), ledger: { ...emptyLedger(), heads: { [SHA]: 0 } }, ...over }))
    // Too soon, or no supervisor to ask: nothing.
    assert.deepEqual(quiet({ now: DRAFT_NUDGE_MS - 1, supervisor: 'run:r1' }).actions, [])
    assert.deepEqual(quiet({ now: DRAFT_NUDGE_MS, supervisor: null }).actions, [])
    // Then the supervisor, never you.
    const asked = quiet({ now: DRAFT_NUDGE_MS, supervisor: 'run:r1' })
    assert.equal(asked.lane, 'draft')
    assert.deepEqual(asked.actions.map((a) => [a.kind, a.kind === 'escalate' ? a.to : null]), [['escalate', 'supervisor']])
    assert.ok(asked.actions[0].kind === 'escalate' && asked.actions[0].reason.includes('mark it ready (gh pr ready 12)'))
    // Once per commit.
    const again = plan(input({ pr: pr({ draft: true }), owner: owner({ activity: 'done' }), supervisor: 'run:r1', now: DRAFT_NUDGE_MS * 4,
      ledger: { ...emptyLedger(), heads: { [SHA]: 0 }, escalations: { [`draft:${SHA}:supervisor`]: { to: 'supervisor', at: 1, reason: 'r' } } } }))
    assert.deepEqual(again.actions, [])
  })

  test('a worker mid-turn is building the PR, or fixing it, and the board says which', () => {
    const busy = owner({ activity: 'working' })
    const lane = (ledger: PrLedger, o = busy, draft = false) => plan(input({ pr: pr({ draft }), owner: o, ledger })).lane
    // Its builder's first turn: still building.
    assert.equal(lane({ ...emptyLedger(), builder: { address: 'dispatch:d1', done: false } }), 'working')
    // What Matriarch sent it for this commit.
    assert.equal(lane({ ...emptyLedger(), ci: { [SHA]: { at: 1, signature: 's' } } }), 'fixing-ci')
    assert.equal(lane({ ...emptyLedger(), conflicts: { [SHA]: { at: 1 } } }), 'fixing-conflict')
    assert.equal(lane({ ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done', startedAt: 1, endedAt: 2, verdict: 'changes', findings: 1, delivered: true } } }), 'fixing-review')
    // Another worker took it over (a heavier tier after a failed gate), or the builder came back.
    assert.equal(lane({ ...emptyLedger(), builder: { address: 'dispatch:d0', done: true } }), 'fixing')
    assert.equal(lane({ ...emptyLedger(), builder: { address: 'dispatch:d1', done: true } }, busy, true), 'fixing')
    assert.ok(plan(input({ pr: pr({ draft: true }), owner: busy, ledger: { ...emptyLedger(), builder: { address: 'dispatch:d0', done: true } } })).reason.startsWith('draft PR; codex is fixing it'))
  })

  test('a worker waiting for input escalates to the supervisor first', () => {
    const p = plan(input({ owner: owner({ activity: 'waiting', since: 42 }), supervisor: 'run:r1' }))
    assert.equal(p.lane, 'needs-you')
    assert.deepEqual(kinds(p.actions), ['escalate'])
    assert.equal((p.actions[0] as Extract<Action, { kind: 'escalate' }>).to, 'supervisor')
  })
})

describe('CI fixes', () => {
  const failing = pr({ ci: 'failing', checks: [check('lint', 'failure', 7), check('test', 'success')] })

  test('waits until every check finished, so one message has every failure', () => {
    const p = plan(input({ pr: pr({ ci: 'failing', checks: [check('lint', 'failure'), check('e2e', 'pending')] }) }))
    assert.equal(p.lane, 'awaiting-ci')
    assert.deepEqual(p.actions, [])
  })

  test('sends the failing checks to the owning worker, round 1', () => {
    const p = plan(input({ pr: failing }))
    assert.equal(p.lane, 'fixing-ci')
    const a = p.actions[0] as Extract<Action, { kind: 'send-ci-failure' }>
    assert.equal(a.kind, 'send-ci-failure')
    assert.equal(a.to, 'dispatch:d1')
    assert.equal(a.round, 1)
    assert.deepEqual(a.checks.map((c) => c.name), ['lint'])
  })

  test('never sends twice for the same commit and failure set', () => {
    const first = plan(input({ pr: failing }))
    const ledger = record(emptyLedger(), first.actions[0], 5)
    const again = plan(input({ pr: failing }, ledger))
    assert.equal(again.lane, 'fixing-ci')
    assert.deepEqual(again.actions, [])
  })

  test('after maxRounds commits it escalates: supervisor, then you once the quiet period passes', () => {
    let ledger = emptyLedger()
    for (let i = 0; i < 3; i++) ledger = { ...ledger, ci: { ...ledger.ci, [`sha${i}`]: { at: i, signature: 'lint' } } }
    const sup = plan(input({ pr: failing, supervisor: 'run:r1' }, ledger))
    assert.equal(sup.lane, 'fixing-ci')
    const e = sup.actions[0] as Extract<Action, { kind: 'escalate' }>
    assert.equal(e.to, 'supervisor')
    assert.equal(e.address, 'run:r1')

    ledger = record(ledger, e, 1_000_000)
    assert.deepEqual(plan(input({ pr: failing, supervisor: 'run:r1', now: 1_000_000 + 60_000 }, ledger)).actions, [])
    const human = plan(input({ pr: failing, supervisor: 'run:r1', now: 1_000_000 + 31 * 60_000 }, ledger))
    assert.equal(human.lane, 'needs-you')
    assert.equal((human.actions[0] as Extract<Action, { kind: 'escalate' }>).to, 'human')
  })

  test('without a supervised worker it escalates instead of guessing an address', () => {
    const p = plan(input({ pr: failing, owner: owner({ address: null }) }))
    assert.deepEqual(kinds(p.actions), ['escalate'])
    assert.equal(p.lane, 'needs-you')
  })

  test('fixes switched off put the PR in front of you', () => {
    const p = plan(input({ pr: failing, config: config((c) => (c.fix.ci.enabled = false)) }))
    assert.equal(p.lane, 'needs-you')
    assert.deepEqual(kinds(p.actions), ['notify'])
  })
})

describe('conflicts and comments', () => {
  test('a conflict asks the worker to rebase', () => {
    const p = plan(input({ pr: pr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' }) }))
    assert.equal(p.lane, 'fixing-conflict')
    assert.deepEqual(kinds(p.actions), ['send-rebase'])
  })

  test('comments go in one batch; new ones on the same commit go without a new round', () => {
    const p1 = plan(input({ pr: pr({ threads: [thread('t1'), thread('t2')] }) }))
    const a1 = p1.actions[0] as Extract<Action, { kind: 'send-comments' }>
    assert.deepEqual(a1.threads.map((t) => t.id), ['t1', 't2'])
    assert.equal(a1.round, 1)
    const ledger = record(emptyLedger(), a1, 5)
    const p2 = plan(input({ pr: pr({ threads: [thread('t1'), thread('t2'), thread('t3')] }) }, ledger))
    const a2 = p2.actions[0] as Extract<Action, { kind: 'send-comments' }>
    assert.deepEqual(a2.threads.map((t) => t.id), ['t3'])
    assert.equal(a2.round, 1)
  })

  test("Matriarch's own threads, resolved threads and bot summaries are not feedback", () => {
    const p = plan(
      input({
        pr: pr({ threads: [thread('a', { ours: true }), thread('b', { resolved: true }), thread('c', { bot: true, path: null, line: null })] }),
        config: config((c) => (c.review.enabled = false))
      })
    )
    assert.equal(p.lane, 'ready')
  })
})

describe('AI review', () => {
  test("starts once CI is green, moving reviewers off the author's agent rather than dropping them", () => {
    const p = plan(input({ owner: owner({ agent: 'codex' }) }))
    assert.equal(p.lane, 'ai-review')
    const a = p.actions[0] as Extract<Action, { kind: 'start-review' }>
    assert.equal(a.kind, 'start-review')
    // The default crew: correctness on Claude, security on Codex. Codex wrote it, so security
    // reviews on Claude, still with its own focus and still blocking.
    assert.deepEqual(a.reviewers.map((r) => [r.name, r.agent, r.blocking, r.focus]), [
      ['correctness', 'claude', true, 'bugs, edge cases, missing tests'],
      ['security', 'claude', true, 'authz, injection, secrets, unsafe input']
    ])
    assert.match(p.reason, /security on claude\b.*, since codex wrote it/)
  })

  test("a moved reviewer takes the other reviewer's agent, model and thinking level, and keeps the rest of its own", () => {
    const c = config((x) => {
      x.reviewers = [
        { name: 'deep', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', blocking: true },
        { name: 'security', agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh', blocking: false, focus: 'secrets' }
      ]
    })
    const sel = selectReviewers(c, 'codex')
    assert.deepEqual(sel.reviewers[1], { name: 'security', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', blocking: false, focus: 'secrets' })
    assert.equal(sel.note, 'security on claude (claude-opus-5-5), since codex wrote it')
    assert.deepEqual(selectReviewers(c, 'opencode'), { reviewers: c.reviewers, note: null }, 'no reviewer on the author\'s agent: unchanged')
    c.review.differentProviderThanAuthor = false
    assert.deepEqual(selectReviewers(c, 'codex').reviewers, c.reviewers, 'off: every reviewer on its own agent')
  })

  test('a reviewer moves only onto an agent Matriarch starts read-only, never onto one let off the lockdown', () => {
    // grok runs without the lockdown, by the person's choice for "style" alone.
    const c = config((x) => {
      x.reviewers = [
        { name: 'bugs', agent: 'claude', blocking: true },
        { name: 'style', agent: 'grok', blocking: false, readOnly: false },
        { name: 'security', agent: 'codex', model: 'gpt-6-astra', blocking: true }
      ]
    })
    const sel = selectReviewers(c, 'claude')
    assert.deepEqual(sel.reviewers[0], { name: 'bugs', agent: 'codex', model: 'gpt-6-astra', blocking: true }, 'onto codex, past grok')
    assert.ok(!('readOnly' in sel.reviewers[0]))
    // With only grok to move to, nothing moves: every reviewer runs on its own agent.
    c.reviewers = c.reviewers.filter((r) => r.name !== 'security')
    const none = selectReviewers(c, 'claude')
    assert.deepEqual(none.reviewers, c.reviewers)
    assert.match(none.note ?? '', /no reviewer to move off claude/)
  })

  test("a light change gets one reviewer, moved off the author's agent like the rest", () => {
    const p = plan(input({ owner: owner({ agent: 'claude' }), pr: pr({ files: ['README.md'] }) }))
    const a = p.actions[0] as Extract<Action, { kind: 'start-review' }>
    assert.deepEqual(a.reviewers.map((r) => [r.name, r.agent]), [['correctness', 'codex']])
  })

  test('keeps every reviewer when all share the author\'s agent', () => {
    const c = config((x) => x.reviewers.forEach((r) => (r.agent = 'codex')))
    const sel = selectReviewers(c, 'codex')
    assert.equal(sel.reviewers.length, 2)
    assert.match(sel.note ?? '', /author/)
  })

  test('waits for a review slot, then reports running and changes requested', () => {
    assert.deepEqual(plan(input({ reviewSlotFree: false })).actions, [])
    const running = { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'running' as const, startedAt: 1 } } }
    assert.equal(plan(input({}, running)).lane, 'ai-review')
    const changes = { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'changes' as const, findings: 2 } } }
    assert.equal(plan(input({}, changes)).lane, 'fixing-review')
  })

  test('after maxRounds review rounds it escalates', () => {
    const l = { ...emptyLedger(), reviews: { s1: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'changes' as const }, s2: { round: 2, status: 'done' as const, startedAt: 2, verdict: 'changes' as const }, s3: { round: 3, status: 'done' as const, startedAt: 3, verdict: 'changes' as const } } }
    const p = plan(input({}, l))
    assert.deepEqual(kinds(p.actions), ['escalate'])
  })
})

describe('merge gate', () => {
  test('manual mode stops at ready and notifies once per commit', () => {
    const p = plan(input({}, passReview()))
    assert.equal(p.lane, 'ready')
    assert.deepEqual(kinds(p.actions), ['notify'])
    const after = plan(input({}, record(passReview(), p.actions[0], 9)))
    assert.deepEqual(after.actions, [])
  })

  test('auto mode merges the reviewed commit, one PR per base branch at a time', () => {
    const auto = config((c) => (c.merge.mode = 'auto'))
    const p = plan(input({ config: auto }, passReview()))
    assert.equal(p.lane, 'merging')
    assert.deepEqual(p.actions, [{ kind: 'merge', sha: SHA, method: 'squash' }])
    const queued = plan(input({ config: auto, mergeSlotFree: false }, passReview()))
    assert.equal(queued.lane, 'ready')
    assert.deepEqual(queued.actions, [])
  })

  test('a branch behind its base is updated mechanically in auto mode, and left to you in manual', () => {
    const auto = config((c) => (c.merge.mode = 'auto'))
    const p = plan(input({ config: auto, pr: pr({ mergeState: 'BEHIND' }) }, passReview()))
    assert.deepEqual(p.actions, [{ kind: 'update-branch', sha: SHA, method: 'rebase' }])
    const manual = plan(input({ pr: pr({ mergeState: 'BEHIND' }) }, passReview()))
    assert.equal(manual.lane, 'ready')
    assert.deepEqual(manual.actions, [])
  })

  test('branch protection that needs a person, or a protected path, stops for you', () => {
    assert.equal(plan(input({ pr: pr({ mergeState: 'BLOCKED' }) }, passReview())).lane, 'needs-you')
    const guarded = config((c) => (c.merge.requireHuman = ['migrations/**']))
    const p = plan(input({ config: guarded, pr: pr({ files: ['migrations/001_init.sql'] }) }, passReview()))
    assert.equal(p.lane, 'needs-you')
    assert.match(p.reason, /migrations/)
  })

  test('unknown mergeability waits instead of merging', () => {
    const p = plan(input({ config: config((c) => (c.merge.mode = 'auto')), pr: pr({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }) }, passReview()))
    assert.equal(p.lane, 'awaiting-ci')
    assert.deepEqual(p.actions, [])
  })

  test('a failed merge escalates', () => {
    const l = { ...passReview(), merge: { sha: SHA, at: 1, status: 'failed' as const, error: 'HEAD changed' } }
    const p = plan(input({ supervisor: 'run:r1' }, l))
    assert.deepEqual(kinds(p.actions), ['escalate'])
  })
})

describe('base branch health', () => {
  test('auto mode pauses merging while the base is red, and asks the supervisor to fix it', () => {
    const auto = config((c) => (c.merge.mode = 'auto'))
    const passed = { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'pass' as const, published: true } } }
    const p = plan(input({ config: auto, supervisor: 'run:r1', baseRed: { sha: 'base1' } }, passed))
    assert.equal(p.lane, 'ready')
    assert.match(p.reason, /paused/)
    assert.deepEqual(kinds(p.actions), ['escalate'])
  })
})

describe('review trigger', () => {
  const pendingCi = pr({ ci: 'pending', checks: [check('e2e', 'pending')] })
  test('"ci-green" waits for CI; "pr-open" starts the crew while CI runs', () => {
    assert.equal(plan(input({ pr: pendingCi })).lane, 'awaiting-ci')
    const p = plan(input({ pr: pendingCi, config: config((c) => (c.review.trigger = 'pr-open')) }))
    assert.equal(p.lane, 'ai-review')
    assert.deepEqual(kinds(p.actions), ['start-review'])
  })

  test('a superseded round does not use up one of the review rounds', () => {
    const l = { ...emptyLedger(), reviews: { s1: { round: 1, status: 'failed' as const, startedAt: 1, superseded: true }, s2: { round: 2, status: 'failed' as const, startedAt: 2, superseded: true }, s3: { round: 3, status: 'failed' as const, startedAt: 3, superseded: true } } }
    const p = plan(input({}, l))
    assert.deepEqual(kinds(p.actions), ['start-review'])
  })
})

describe('second review pass: planner', () => {
  test('passing rounds do not use up the cap; rounds that asked for changes do', () => {
    const passes = { ...emptyLedger(), reviews: { a: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'pass' as const }, b: { round: 1, status: 'done' as const, startedAt: 2, verdict: 'pass' as const }, c: { round: 1, status: 'done' as const, startedAt: 3, verdict: 'pass' as const } } }
    assert.deepEqual(kinds(plan(input({}, passes)).actions), ['start-review'])
    const changes = { ...emptyLedger(), reviews: { a: { round: 1, status: 'done' as const, startedAt: 1, verdict: 'changes' as const }, b: { round: 2, status: 'failed' as const, startedAt: 2 }, c: { round: 3, status: 'done' as const, startedAt: 3, verdict: 'changes' as const } } }
    assert.deepEqual(kinds(plan(input({}, changes)).actions), ['escalate'])
  })

  test('no checks on a brand-new commit is not green yet', () => {
    const none = pr({ ci: 'none', checks: [] })
    const seenNow = { ...emptyLedger(), heads: { [SHA]: 1_000_000 } }
    assert.equal(plan(input({ pr: none, now: 1_000_000 + 60_000 }, seenNow)).lane, 'awaiting-ci')
    assert.equal(plan(input({ pr: none, now: 1_000_000 + CI_GRACE_MS + 1 }, seenNow)).lane, 'ai-review')
  })

  test('a merge that never completes escalates instead of showing merging forever', () => {
    const l = { ...passReview(), merge: { sha: SHA, at: 1_000_000, status: 'requested' as const } }
    assert.equal(plan(input({ now: 1_000_000 + 60_000 }, l)).lane, 'merging')
    assert.deepEqual(kinds(plan(input({ now: 1_000_000 + MERGE_TIMEOUT_MS + 1 }, l)).actions), ['escalate'])
  })

  test('cut-short thread or check lists stop the merge gate', () => {
    const auto = config((c) => (c.merge.mode = 'auto'))
    assert.equal(plan(input({ config: auto, pr: pr({ threadsTruncated: true }) }, passReview())).lane, 'needs-you')
    assert.equal(plan(input({ config: auto, pr: pr({ checksTruncated: true }) }, passReview())).lane, 'needs-you')
  })
})

describe('a repository with no CI', () => {
  test('does not wait for checks that will never come', () => {
    const fresh = pr({ ci: 'none', checks: [] })
    const ledger = { ...emptyLedger(), heads: { [fresh.headSha]: 1_000 } }
    const waits = plan(input({ pr: fresh, ledger, now: 2_000, baseHasChecks: true }))
    assert.equal(waits.lane, 'awaiting-ci')
    const goes = plan(input({ pr: fresh, ledger, now: 2_000, baseHasChecks: false }))
    assert.notEqual(goes.reason, `waiting for checks to start on ${fresh.headSha.slice(0, 7)}`)
    // Once checks have shown up on the PR, a gap in them is waited out again.
    const gap = plan(input({ pr: fresh, ledger: { ...ledger, ciSeen: true }, now: 2_000, baseHasChecks: false }))
    assert.equal(gap.lane, 'awaiting-ci')
  })
})

describe('a light change', () => {
  const docs = pr({ files: ['README.md', 'docs/guide.md'] })
  const startOf = (p: ReturnType<typeof plan>) => p.actions.find((a) => a.kind === 'start-review') as Extract<Action, { kind: 'start-review' }> | undefined
  // An author on neither default reviewer's agent, so the whole crew of two would run.
  const author = owner({ agent: 'opencode' })
  const crewOf = (p: ReturnType<typeof plan>) => startOf(p)?.reviewers.map((r) => r.name)
  const none = config((x) => (x.review.light.crew = 'none'))

  test('gets one reviewer, the first that must approve', () => {
    const c = config((x) => (x.reviewers = [
      { name: 'style', agent: 'claude', blocking: false },
      { name: 'correctness', agent: 'claude', blocking: true },
      { name: 'security', agent: 'claude', blocking: true }
    ]))
    const p = plan(input({ pr: docs, config: c, owner: owner({ agent: 'codex' }) }))
    assert.deepEqual(crewOf(p), ['correctness'])
    assert.ok(p.reason.includes('a light change (only **/*.md): one reviewer'), p.reason)
  })

  test('with no reviewer that must approve, the first one', () => {
    const c = config((x) => (x.reviewers = [{ name: 'style', agent: 'claude', blocking: false }, { name: 'docs', agent: 'claude', blocking: false }]))
    assert.deepEqual(crewOf(plan(input({ pr: docs, config: c, owner: author }))), ['style'])
  })

  test('with crew "none" skips the AI review and says so at the merge gate', () => {
    const p = plan(input({ pr: docs, config: none }))
    assert.equal(p.lane, 'ready')
    assert.ok(!startOf(p))
    assert.equal(p.reason, 'ready to merge; AI review skipped: a light change (only **/*.md)')
  })

  test('with crew "none", a round already on this commit still decides: running, or asking for changes', () => {
    const running = plan(input({ pr: docs, config: none, ledger: { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'running', startedAt: 1 } } } }))
    assert.equal(running.lane, 'ai-review')
    const changes = plan(input({ pr: docs, config: none, ledger: { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'done', startedAt: 1, endedAt: 2, verdict: 'changes', findings: 2 } } } }))
    assert.equal(changes.lane, 'fixing-review')
    assert.ok(changes.actions.some((a) => a.kind === 'send-findings'))
    // A failed round does not hold a light change up.
    const failed = plan(input({ pr: docs, config: none, ledger: { ...emptyLedger(), reviews: { [SHA]: { round: 1, status: 'failed', startedAt: 1, endedAt: 2 } } } }))
    assert.equal(failed.lane, 'ready')
  })

  test('is not one when a file falls outside the paths, the list is cut short, empty, or the paths are off', () => {
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['README.md', 'src/a.ts'] }), config: none, owner: author })))?.length, 2)
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['README.md'], filesTruncated: true }), config: none, owner: author })))?.length, 2)
    assert.equal(crewOf(plan(input({ pr: pr({ files: [] }), config: none, owner: author })))?.length, 2)
    const off = config((x) => (x.review.light = { paths: [], crew: 'none' }))
    assert.equal(crewOf(plan(input({ pr: docs, config: off, owner: author })))?.length, 2)
  })

  test('renamed or copied files, or a forge that cannot say, get the full crew', () => {
    // `git mv src/auth/session.ts docs/session.md` lists only the new path, which looks like docs.
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['docs/session.md'], renamed: ['docs/session.md'] }), config: none, owner: author })))?.length, 2)
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['docs/session.md'], renamed: null }), config: none, owner: author })))?.length, 2)
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['docs/session.md'], renamed: undefined }), config: none, owner: author })))?.length, 2)
  })

  test("agents' instructions and tools' config always get the full crew, even when they match the paths", () => {
    const everything = config((x) => (x.review.light = { paths: ['**'], crew: 'none' }))
    for (const file of ['AGENTS.md', 'pkg/CLAUDE.md', 'GEMINI.md', 'skills/x/SKILL.md', 'a.prompt.md', '.github/copilot-instructions.md', '.cursorrules', '.windsurfrules',
      '.claude/settings.json', 'sub/.cursor/rules/x.mdc', '.github/workflows/ci.yml', '.agents/x.md', '.codex/config.toml', '.omp/x.md', '.opencode/agent.md']) {
      assert.equal(crewOf(plan(input({ pr: pr({ files: ['README.md', file] }), config: everything, owner: author })))?.length, 2, file)
    }
    // The defaults: docs only, and not text files that build or configure anything.
    for (const file of ['requirements.txt', 'CMakeLists.txt', 'docs/conf.py', 'docs/page.mdx']) {
      assert.equal(crewOf(plan(input({ pr: pr({ files: [file] }), config: none, owner: author })))?.length, 2, file)
    }
    for (const file of ['README.md', 'docs/guide.rst', 'docs/manual.adoc']) assert.equal(plan(input({ pr: pr({ files: [file] }), config: none })).lane, 'ready', file)
  })

  test('the full-crew list holds in any case, and covers Orca, Gemini and the other agents\' folders', () => {
    // On a case-insensitive disk (macOS), claude.md steers an agent as CLAUDE.md does.
    for (const file of ['claude.md', 'Agents.md', 'docs/Gemini.MD', '.Claude/settings.md', 'pkg/.GITHUB/notes.md', 'skills/x/skill.md', 'conventions.md',
      '.orca/matriarch.md', '.gemini/styleguide.md', '.windsurf/rules/x.md', '.continue/rules/x.md', '.roo/rules/x.md', '.kiro/steering/x.md',
      '.junie/guidelines.md', '.clinerules/x.md', '.clinerules', '.aider.conf.md']) {
      assert.equal(crewOf(plan(input({ pr: pr({ files: ['README.md', file] }), config: none, owner: author })))?.length, 2, file)
    }
    // The light paths themselves keep their case: they decide what may get less review.
    const upper = config((x) => (x.review.light = { paths: ['**/*.md'], crew: 'none' }))
    assert.equal(crewOf(plan(input({ pr: pr({ files: ['NOTES.MD'] }), config: upper, owner: author })))?.length, 2)
  })
})

describe('protected paths', () => {
  test('match in any case, so a PR cannot slip past them by changing a letter', () => {
    const c = config((x) => {
      x.merge.requireHuman = ['src/auth/**']
      x.review.enabled = false
    })
    const p = plan(input({ pr: pr({ files: ['SRC/Auth/session.ts'] }), config: c }))
    assert.equal(p.lane, 'needs-you')
    assert.match(p.reason, /touches protected paths \(src\/auth\/\*\*\)/)
  })
})
