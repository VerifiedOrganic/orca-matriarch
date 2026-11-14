import { assert, describe, test } from 'orca/testing'
import {
  adviceQuestions, ADVICE_MAX_MS, answerPath, createAdvisor, MAX_QUEUED, parseAnswer, parseMail,
  type Advisor, type AdvisorDeps, type MailItem
} from './advisor.ts'
import { validateConfig, type AdvisorSpec, type MatriarchConfig } from './config.ts'
import { REVIEW_BRANCH_PREFIX, REVIEWER_TIMEOUT_MS } from './crew.ts'
import { tick, type EngineDeps } from './engine.ts'
import type { Exec } from './exec.ts'
import { isVerdictFile } from './guard.ts'
import { createLockdown, type Lockdown } from './lockdown.ts'
import { OrcaRefusal, type OrcaCli } from './orca-cli.ts'
import { advisorMessage, supervisorBrief, supervisorTag } from './supervisor.ts'
import { config } from './testing/fixtures.ts'
import { joinGuards, reviewGuard } from './worker.ts'

const FABLE: AdvisorSpec = { agent: 'claude', model: 'claude-fable-5-2', effort: 'max' }
const withAdvisor = (advisor: AdvisorSpec | null = FABLE): MatriarchConfig => config((c) => (c.advisor = advisor))
const mail = (id: string, subject: string, body = ''): MailItem => ({ id, from: 'term_sup', subject, body })

describe('the advisor: mail and answers', () => {
  test('reads both views of a mailbox check, and takes only "Advice:" messages as questions', () => {
    const concise = parseMail({ messages: [{ id: 'm1', type: 'status', from: 'term_sup', subject: 'Advice: one PR or two?', body: 'ctx' }, { id: 'm2', from: 'd1', subject: 'Re: #12' }] })
    const full = parseMail({ messages: [{ id: 'm3', from_handle: 'run:r1', subject: 'advice:  rollback plan?', body: 'b', read: 0 }], count: 1 })
    assert.deepEqual(concise.map((m) => m.id), ['m1', 'm2'])
    assert.equal(full[0].from, 'run:r1')
    const qs = adviceQuestions([...concise, ...full], 5)
    assert.deepEqual(qs.map((q) => [q.id, q.question, q.context]), [['m1', 'one PR or two?', 'ctx'], ['m3', 'rollback plan?', 'b']])
    assert.deepEqual(parseMail(null), [])
  })

  test('an answer is {"answer": ...}, also fenced or with words around it; anything else is not one', () => {
    assert.equal(parseAnswer('{"answer": "Two PRs."}'), 'Two PRs.')
    assert.equal(parseAnswer('Here:\n```json\n{"answer":"Split it"}\n```'), 'Split it')
    assert.equal(parseAnswer('noise {"answer": "ok"} noise'), 'ok')
    assert.equal(parseAnswer('{"answer": ""}'), null)
    assert.equal(parseAnswer('{"verdict": "approve"}'), null)
    assert.equal(parseAnswer('not json'), null)
  })

  test('the answer file is in the verdict folder, so the read-only guard lets the advisor write it', () => {
    assert.ok(isVerdictFile('/wt/advice', answerPath('abc123')))
    assert.ok(answerPath('abc123').startsWith('.matriarch/review/advice-abc123/'))
  })
})

describe('the advisor in the supervisor brief', () => {
  const tag = supervisorTag('acme/app', 'n1')
  test('only with an advisor: when to ask it, and the exact command to Matriarch\'s mailbox', () => {
    const brief = supervisorBrief({ repo: 'acme/app', objective: 'x', tag, base: 'main', config: withAdvisor(), advisor: { role: FABLE, address: 'term_mail' } })
    assert.ok(brief.includes('an advisor (claude claude-fable-5-2 max effort) reads the code read-only'))
    assert.ok(brief.includes("orca orchestration send --to term_mail --subject 'Advice: <the question in one line>' --body '<the context>' --json"))
    assert.ok(brief.includes('before something hard to'))
    const without = supervisorBrief({ repo: 'acme/app', objective: 'x', tag, base: 'main', config: withAdvisor(null) })
    assert.ok(!without.includes('Advice:'))
    assert.ok(!without.includes('advisor'))
  })

  test('a running supervisor is told when the advisor appears or moves, and when it is turned off', () => {
    const on = advisorMessage({ role: FABLE, address: 'term_new' })
    assert.equal(on.subject, 'Advisor available')
    assert.ok(on.body.includes('--to term_new'))
    assert.ok(on.body.includes('instead of any earlier one'))
    assert.equal(advisorMessage(null).subject, 'Advisor turned off')
  })

  test('config: off by default; a claude or codex advisor is read-only; another needs readOnly false', () => {
    assert.equal(validateConfig({}).config.advisor, null)
    const ok = validateConfig({ advisor: FABLE })
    assert.deepEqual(ok.config.advisor, FABLE)
    assert.deepEqual(ok.errors, [])
    const grok = validateConfig({ advisor: { agent: 'grok' } })
    assert.ok(grok.warnings.some((w) => w.startsWith('advisor:') && w.includes('"readOnly": false')))
    assert.equal(validateConfig({ advisor: { agent: 'grok', readOnly: false } }).config.advisor?.readOnly, false)
    assert.ok(validateConfig({ advisor: { agent: 'claude', readOnly: false } }).warnings.some((w) => w.startsWith('advisor.readOnly: ignored')))
    assert.ok(validateConfig({ advisor: 'fable' }).errors.some((e) => e.startsWith('advisor:')))
  })
})

function advisorHarness(opts: { lockdown?: Lockdown; hookRuns?: boolean } = {}) {
  let now = 1_000_000
  const store = new Map<string, unknown>()
  const calls: string[][] = []
  const sent: { to: string; subject: string; body: string; from: string | null }[] = []
  const files: Record<string, string> = {}
  let inbox: { id: string; from: string; subject: string; body: string }[] = []
  let tail: string[] = ['thinking…']
  let mailbox = 'term_mail'
  let terminalGone = false
  let advisor: Advisor | null = null
  const orca: OrcaCli = {
    async run(args) {
      calls.push([...args])
      const [a, b] = args
      if (a === 'orchestration' && b === 'check') {
        const batch = inbox.map((m) => ({ ...m, type: 'status' }))
        if (!args.includes('--peek')) inbox = []
        return { messages: batch }
      }
      if (a === 'orchestration' && b === 'send') {
        const at = (flag: string) => args[args.indexOf(flag) + 1]
        sent.push({ to: at('--to'), subject: at('--subject'), body: at('--body'), from: args.includes('--from') ? at('--from') : null })
        return {}
      }
      if (a === 'worktree' && b === 'create') return { worktree: { path: `/wt/${args[args.indexOf('--name') + 1]}`, id: `repo1::/wt/${args[args.indexOf('--name') + 1]}` } }
      if (a === 'agent' && b === 'launch') {
        const agent = args[args.indexOf('--agent') + 1]
        const path = args[args.indexOf('--worktree') + 1].slice('path:'.length)
        // Orca runs the launch hook while it starts the agent, unless it timed out.
        if (opts.lockdown && opts.hookRuns !== false) {
          const decision = opts.lockdown.onLaunch({ agent, workspaceId: `repo1::${path}`, command: `${agent} --dangerously-skip-permissions 'brief'` }, advisor!.guard())
          if (decision && 'deny' in decision) throw new Error(decision.deny)
        }
        return { outcome: { kind: 'terminal', handle: `term-${agent}` } }
      }
      if (a === 'terminal' && b === 'read') {
        if (terminalGone) throw new OrcaRefusal('terminal_handle_stale', 'gone')
        return { terminal: { tail } }
      }
      return {}
    }
  }
  const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' })
  const deps: AdvisorDeps = {
    orca,
    exec,
    now: () => now,
    log: () => {},
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    readFile: async (path) => files[path] ?? null,
    workspaceIdFor: async () => null,
    mailbox: async () => mailbox,
    lockdown: opts.lockdown,
    lockConfirmMs: 0
  }
  advisor = createAdvisor(deps)
  const step = (over: { acting?: boolean; supervisor?: string | null; config?: MatriarchConfig; base?: string | null } = {}) =>
    advisor!.step({ repo: 'acme/app', root: '/r', config: over.config ?? withAdvisor(), supervisor: over.supervisor === undefined ? 'run:r1' : over.supervisor, acting: over.acting ?? true, base: over.base === undefined ? 'main' : over.base })
  return {
    advisor, calls, sent, files, store, step,
    ask: (id: string, question: string, body = 'context') => void inbox.push({ id, from: 'term_sup', subject: `Advice: ${question}`, body }),
    setTail: (t: string[]) => (tail = t),
    setMailbox: (h: string) => (mailbox = h),
    closeTerminal: () => (terminalGone = true),
    advance: (ms: number) => (now += ms),
    launches: () => calls.filter((c) => c[0] === 'agent' && c[1] === 'launch'),
    answer: (text: string) => {
      const create = calls.filter((c) => c[0] === 'worktree' && c[1] === 'create').at(-1)!
      const name = create[create.indexOf('--name') + 1]
      files[`/wt/${name}/${answerPath(name.slice('advice-'.length))}`] = text
    }
  }
}

describe('the advisor at work', () => {
  test('a question: read-only worktree at the default branch, the advisor on its model, its answer mailed back, the worktree gone', async () => {
    const h = advisorHarness()
    // It was briefed when its chat began, so nothing more is said about the advisor.
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m1', 'One PR for the migration, or two?', 'The schema change and the backfill touch different files.')
    const view = await h.step()
    const create = h.calls.find((c) => c[0] === 'worktree' && c[1] === 'create')!
    assert.ok(create.includes('origin/main'), 'at the default branch')
    assert.ok(create[create.indexOf('--branch') + 1].startsWith(`${REVIEW_BRANCH_PREFIX}advice-`), 'a review branch, so the board skips it')
    const launch = h.launches()[0]
    assert.deepEqual([launch[launch.indexOf('--agent') + 1], launch[launch.indexOf('--model') + 1], launch[launch.indexOf('--effort') + 1]], ['claude', 'claude-fable-5-2', 'max'])
    const prompt = launch[launch.indexOf('--prompt') + 1]
    assert.ok(prompt.includes('One PR for the migration, or two?'))
    assert.ok(prompt.includes('The schema change and the backfill touch different files.'))
    assert.ok(prompt.includes('.matriarch/review/advice-'))
    assert.equal(view?.answering?.question, 'One PR for the migration, or two?')
    assert.equal(h.advisor.guard().paths.length, 1, 'the read-only hooks know its worktree')
    assert.equal(h.sent.length, 0, 'its brief already said all of it')

    h.answer('{"answer": "Two PRs: ship the backfill behind a flag."}')
    const done = await h.step()
    assert.equal(h.sent.length, 1)
    assert.deepEqual([h.sent[0].to, h.sent[0].subject, h.sent[0].from], ['run:r1', 'Advice: One PR for the migration, or two?', 'term_mail'])
    assert.ok(h.sent[0].body.includes('Two PRs: ship the backfill behind a flag.'))
    assert.ok(h.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm' && c.includes('--delete-branch')))
    assert.equal(h.advisor.guard().paths.length, 0)
    assert.equal(done?.answering, null)
    assert.deepEqual([done?.last?.answered, done?.last?.question], [true, 'One PR for the migration, or two?'])
  })

  test('one question at a time, each once, the rest wait their turn', async () => {
    const h = advisorHarness()
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m1', 'first')
    h.ask('m2', 'second')
    const view = await h.step()
    assert.equal(h.launches().length, 1)
    assert.equal(view?.queued, 1)
    // The same message read again (a peek after a lost consume) is not a new question.
    h.ask('m2', 'second')
    assert.equal((await h.step())?.queued, 1)
    h.answer('{"answer": "a1"}')
    await h.step()
    assert.equal(h.launches().length, 2, 'the second starts once the first is answered')
    assert.ok(h.launches()[1][h.launches()[1].indexOf('--prompt') + 1].includes('second'))
  })

  test('in dry run, or with no supervisor, questions wait; nothing starts and nothing is sent', async () => {
    const h = advisorHarness()
    h.ask('m1', 'q')
    const dry = await h.step({ acting: false })
    assert.deepEqual([dry?.queued, dry?.waiting], [1, 'autopilot is off'])
    assert.equal(h.launches().length, 0)
    assert.equal(h.sent.length, 0)
    await h.step()
    assert.equal(h.launches().length, 1, 'it starts once autopilot is on')
  })

  test('no answer: quiet for the reviewer timeout, its terminal closed, or too long; the supervisor is told', async () => {
    const quiet = advisorHarness()
    await quiet.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    quiet.ask('m1', 'q')
    await quiet.step()
    quiet.advance(REVIEWER_TIMEOUT_MS + 1)
    await quiet.step()
    assert.equal(quiet.sent.length, 1)
    assert.equal(quiet.sent[0].subject, 'Advice: q (no answer)')
    assert.ok(quiet.sent[0].body.includes('quiet for 30 min'))
    assert.ok(quiet.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm'))

    const closed = advisorHarness()
    await closed.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    closed.ask('m1', 'q')
    await closed.step()
    closed.closeTerminal()
    await closed.step()
    assert.ok(closed.sent[0].body.includes('its terminal was closed'))

    // Busy all along, but past the limit.
    const slow = advisorHarness()
    await slow.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    slow.ask('m1', 'q')
    await slow.step()
    for (let t = 0; t <= ADVICE_MAX_MS; t += 20 * 60_000) {
      slow.setTail([`working ${t}`])
      slow.advance(20 * 60_000)
      await slow.step()
    }
    assert.ok(slow.sent[0].body.includes('took over 2 hours'))
  })

  test('a prompt in its terminal needs you, and does not count as quiet', async () => {
    const h = advisorHarness()
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m1', 'q')
    await h.step()
    h.setTail(['Do you trust the files in this folder?'])
    const view = await h.step()
    assert.ok(view?.answering?.blocked?.includes('trust'))
    assert.equal(view?.answering?.terminal, 'term-claude')
    h.advance(REVIEWER_TIMEOUT_MS * 2)
    await h.step()
    assert.equal(h.sent.length, 0, 'still waiting on a person, not timed out')
  })

  test('the supervisor learns of the advisor when it started without one, when the mailbox moves, and when it is turned off', async () => {
    const h = advisorHarness()
    await h.step()
    assert.deepEqual(h.sent.map((m) => m.subject), ['Advisor available'])
    assert.ok(h.sent[0].body.includes('--to term_mail'))
    await h.step()
    assert.equal(h.sent.length, 1, 'once')
    // Orca restarted: Matriarch's mailbox is a new terminal.
    h.setMailbox('term_mail2')
    await h.step()
    assert.ok(h.sent[1].body.includes('--to term_mail2'))
    // Not in dry run.
    const off = await h.step({ config: withAdvisor(null), acting: false })
    assert.equal(h.sent.length, 2)
    assert.equal(off, null)
    await h.step({ config: withAdvisor(null) })
    assert.equal(h.sent[2].subject, 'Advisor turned off')
  })

  test('turning it off mid-question stops it and says so; more than the queue holds is turned away', async () => {
    const h = advisorHarness()
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m0', 'running')
    for (let i = 1; i <= MAX_QUEUED + 1; i++) h.ask(`m${i}`, `q${i}`)
    const view = await h.step()
    assert.equal(view?.queued, MAX_QUEUED)
    assert.ok(h.sent.some((m) => m.subject === `Advice: q${MAX_QUEUED + 1} (no answer)`))
    await h.step({ config: withAdvisor(null) })
    assert.ok(h.sent.some((m) => m.subject === 'Advice: running (no answer)' && m.body.includes('turned off')))
    assert.equal(h.advisor.guard().paths.length, 0)
  })
})

describe('the advisor starts locked down', () => {
  test('claude is rewritten to its read-only mode in the advisor worktree, and the tool guard covers it', async () => {
    const lockdown = createLockdown(() => 1_000_000)
    const h = advisorHarness({ lockdown })
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m1', 'q')
    const view = await h.step()
    assert.equal(view?.answering?.lock, 'read-only: Claude dontAsk mode with a read-only allowlist')
    const path = h.advisor.guard().paths[0]
    const guard = joinGuards({ ids: new Set(), paths: [] }, h.advisor.guard())
    assert.ok(reviewGuard({ tool: 'Edit', workspaceId: `repo1::${path}`, input: { file_path: `${path}/src/a.ts` } }, guard)?.deny)
    assert.equal(reviewGuard({ tool: 'Write', workspaceId: `repo1::${path}`, input: { file_path: `${path}/${answerPath('x')}` } }, guard), null)
  })

  test('an advisor Orca started without the lockdown is stopped, and the supervisor hears there is no answer', async () => {
    const h = advisorHarness({ lockdown: createLockdown(() => 1_000_000), hookRuns: false })
    await h.advisor.briefed('acme/app', { role: FABLE, address: 'term_mail' })
    h.ask('m1', 'q')
    await h.step()
    assert.ok(h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close'))
    assert.ok(h.sent[0].body.includes("without Matriarch's read-only lockdown"))
  })

  test('an agent Matriarch cannot lock down is not offered; with readOnly false it runs exempt', async () => {
    const lockdown = createLockdown(() => 1_000_000)
    const h = advisorHarness({ lockdown })
    assert.equal(await h.step({ config: withAdvisor({ agent: 'grok' }) }), null)
    assert.equal(h.sent.length, 0)
    h.ask('m1', 'q')
    await h.step({ config: withAdvisor({ agent: 'grok', readOnly: false }) })
    const launch = h.launches()[0]
    assert.equal(launch[launch.indexOf('--agent') + 1], 'grok')
    assert.equal(lockdown.confirmed(h.advisor.guard().paths[0], 'grok', 0), 'off')
  })
})

test('the engine shows the advisor on its project, and a prompt it waits on under Needs you', async () => {
  const deps: EngineDeps = {
    now: () => 1_000,
    log: () => {},
    workspaces: async () => [],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => validateConfig({ review: { enabled: false }, advisor: FABLE }),
    github: { listOpen: async () => ({ viewer: 'me', rate: null, prs: [], base: { name: 'main', sha: 's', rollup: 'SUCCESS' } }), detail: async () => ({ pr: null, rate: null }) },
    workers: async () => [],
    activity: () => null,
    supervisor: async () => 'run:r1',
    store: { get: async () => null, set: async () => {} },
    executor: null,
    advisor: {
      step: async (input) => ({
        agent: 'claude', model: input.base, effort: null, usable: true, queued: 0, waiting: null, last: null,
        answering: { question: 'q', since: 1, blocked: 'the agent needs you to sign in', terminal: 'term-claude', workspaceId: null, lock: null }
      })
    }
  }
  // A workspace makes the project show up.
  deps.workspaces = async () => [{ id: 'ws1', kind: 'folder', name: 'app', path: '/r', branch: 'main', hostId: null }]
  const board = await tick(deps, { autopilot: false })
  assert.equal(board.repos[0].advisor?.model, 'main', 'it gets the default branch')
  assert.ok(board.attention.some((a) => a.key === 'acme/app:advisor' && a.terminal === 'term-claude'))
})
