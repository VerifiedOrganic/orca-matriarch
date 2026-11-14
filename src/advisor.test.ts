import { assert, describe, test } from 'orca/testing'
import {
  adviceQuestions, ADVICE_MAX_MS, advisorBrief, answerPath, createAdvisor, MAX_QUEUED, outputLines, parseAnswer, parseMail,
  type AdviceRun, type Advisor, type AdvisorDeps, type MailItem
} from './advisor.ts'
import { validateConfig, type AdvisorSpec, type MatriarchConfig } from './config.ts'
import { createCrew, REVIEW_BRANCH_PREFIX, REVIEWER_TIMEOUT_MS } from './crew.ts'
import { tick, type EngineDeps } from './engine.ts'
import type { Exec } from './exec.ts'
import { createExecutor } from './executor.ts'
import { isVerdictFile } from './guard.ts'
import { createLockdown, type Lockdown } from './lockdown.ts'
import { OrcaRefusal, type OrcaCli } from './orca-cli.ts'
import { advisorMessage, supervisorBrief, supervisorTag } from './supervisor.ts'
import { config, pr } from './testing/fixtures.ts'
import { createMailboxes, joinGuards, reviewGuard } from './worker.ts'

const FABLE: AdvisorSpec = { agent: 'claude', model: 'claude-fable-5-2', effort: 'max' }
const withAdvisor = (advisor: AdvisorSpec | null = FABLE): MatriarchConfig => config((c) => (c.advisor = advisor))
const mail = (id: string, subject: string, body = ''): MailItem => ({ id, from: 'term_sup', subject, body, complete: true })
const at = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1]

describe('the advisor: mail and answers', () => {
  test('reads both views of a mailbox check, and takes "Advice:" and "Re: Advice:" messages as questions', () => {
    const concise = parseMail({ messages: [{ id: 'm1', type: 'status', from: 'term_sup', subject: 'Advice: one PR or two?', body: 'ctx' }, { id: 'm2', from: 'd1', subject: 'Re: #12' }] })
    const full = parseMail({ messages: [{ id: 'm3', from_handle: 'run:r1', subject: 'advice:  rollback plan?', body: 'b', read: 0 }], count: 1 })
    assert.deepEqual(concise.map((m) => m.id), ['m1', 'm2'])
    assert.equal(full[0].from, 'run:r1')
    const qs = adviceQuestions([...concise, ...full, mail('m4', 'Re: Advice: and the backfill?')], 5)
    assert.deepEqual(qs.map((q) => [q.id, q.question, q.context]), [['m1', 'one PR or two?', 'ctx'], ['m3', 'rollback plan?', 'b'], ['m4', 'and the backfill?', '']])
    assert.deepEqual(parseMail(null), [])
    // A record without its subject or body was not read whole.
    assert.equal(parseMail({ messages: [{ id: 'm5', type: 'status' }] })[0].complete, false)
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

  test('the brief echoed in its terminal is not read as its output, even wrapped or framed', () => {
    const q = { id: 'm1', question: 'Is codex resume safe here?', context: 'If you see "Do you want to proceed?" or a usage limit reached banner, say so.', from: null, at: 0 }
    const brief = advisorBrief({ repo: 'acme/app', base: 'main', question: q, id: 'x1' })
    const echoed = ['│ > Is codex resume safe here? │', '  Do you want to proceed?" or a usage limit', 'reached banner, say so.']
    assert.deepEqual(outputLines([...echoed, '⏺ Reading src/session.ts'], brief), ['⏺ Reading src/session.ts'])
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

interface HarnessOptions {
  lockdown?: Lockdown
  hookRuns?: boolean
  /** A git fetch that fails. */
  fetchFails?: boolean
  /** worktree create throws, or answers with no path. */
  createFails?: 'throw' | 'no-path'
  /** agent launch throws. */
  launchFails?: boolean
  /** Workspace ids Orca lists for new worktrees, one per call (then null). */
  workspaceIds?: (string | null)[]
  store?: Map<string, unknown>
}

function advisorHarness(opts: HarnessOptions = {}) {
  let now = 1_000_000
  const store = opts.store ?? new Map<string, unknown>()
  const calls: string[][] = []
  const sent: { to: string; subject: string; body: string; from: string | null }[] = []
  const files: Record<string, string> = {}
  let inbox: { id: string; from: string; subject?: string; body?: string }[] = []
  /** Mail that arrives between the peek and the consuming check. */
  let lateMail: { id: string; from: string; subject: string; body: string }[] = []
  const tails: Record<string, string[]> = {}
  let mailbox = 'term_mail'
  const closedTerminals = new Set<string>()
  let failStartingSave = false
  let workspaceIds = [...(opts.workspaceIds ?? [])]
  let advisor: Advisor | null = null
  const state = { rmFails: false }
  const orca: OrcaCli = {
    async run(args) {
      calls.push([...args])
      const [a, b] = args
      if (a === 'orchestration' && b === 'check') {
        if (closedTerminals.has(at(args, '--terminal'))) throw new OrcaRefusal('terminal_handle_stale', 'gone')
        if (!args.includes('--peek')) {
          inbox.push(...lateMail)
          lateMail = []
        }
        const batch = inbox.map((m) => ({ ...m, type: 'status' }))
        if (!args.includes('--peek')) inbox = []
        return { messages: batch }
      }
      if (a === 'orchestration' && b === 'send') {
        const from = args.includes('--from') ? at(args, '--from') : null
        if (from && closedTerminals.has(from)) throw new OrcaRefusal('terminal_not_found', 'gone')
        sent.push({ to: at(args, '--to'), subject: at(args, '--subject'), body: at(args, '--body'), from })
        return {}
      }
      if (a === 'worktree' && b === 'create') {
        if (opts.createFails === 'throw') throw new Error('disk full')
        if (opts.createFails === 'no-path') return {}
        return { worktree: { path: `/wt/${at(args, '--name')}` } }
      }
      if (a === 'worktree' && b === 'rm') {
        if (state.rmFails) throw new Error('busy')
        return {}
      }
      if (a === 'agent' && b === 'launch') {
        if (opts.launchFails) throw new Error('no such agent')
        const agent = at(args, '--agent')
        const path = at(args, '--worktree').slice('path:'.length)
        // Orca runs the launch hook while it starts the agent, unless it timed out.
        if (opts.lockdown && opts.hookRuns !== false) {
          const decision = opts.lockdown.onLaunch({ agent, workspaceId: `repo1::${path}`, command: `${agent} --dangerously-skip-permissions 'brief'` }, advisor!.guard())
          if (decision && 'deny' in decision) throw new Error(decision.deny)
        }
        tails[`term-${agent}`] ??= ['thinking…']
        closedTerminals.delete(`term-${agent}`)
        return { outcome: { kind: 'terminal', handle: `term-${agent}` } }
      }
      if (a === 'terminal' && b === 'list') {
        return { terminals: Object.keys(tails).filter((t) => !closedTerminals.has(t)).map((handle) => ({ handle })) }
      }
      if (a === 'terminal' && b === 'read') {
        const handle = at(args, '--terminal')
        if (closedTerminals.has(handle) || !tails[handle]) throw new OrcaRefusal('terminal_handle_stale', 'gone')
        return { terminal: { tail: tails[handle] } }
      }
      if (a === 'terminal' && b === 'close') closedTerminals.add(at(args, '--terminal'))
      return {}
    }
  }
  const exec: Exec = async () => ({ code: opts.fetchFails ? 1 : 0, stdout: '', stderr: opts.fetchFails ? 'could not reach origin' : '' })
  const deps: AdvisorDeps = {
    orca,
    exec,
    now: () => now,
    log: () => {},
    store: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        const running = (v as { running?: AdviceRun | null } | null)?.running
        if (failStartingSave && running?.phase === 'starting' && running.worktree) throw new Error('storage write failed')
        store.set(k, v)
      }
    },
    readFile: async (path) => files[path] ?? null,
    workspaceIdFor: async () => (workspaceIds.length ? workspaceIds.shift()! : null),
    mailbox: async () => mailbox,
    mailboxGone: (_repo, handle) => {
      if (handle === mailbox) mailbox = `${mailbox}2`
    },
    lockdown: opts.lockdown,
    lockConfirmMs: 0
  }
  advisor = createAdvisor(deps)
  const step = (over: { acting?: boolean; supervisor?: string | null; config?: MatriarchConfig; base?: string | null } = {}) =>
    advisor!.step({ repo: 'acme/app', root: '/r', config: over.config ?? withAdvisor(), supervisor: over.supervisor === undefined ? 'run:r1' : over.supervisor, acting: over.acting ?? true, base: over.base === undefined ? 'main' : over.base })
  const creates = () => calls.filter((c) => c[0] === 'worktree' && c[1] === 'create')
  return {
    advisor, calls, sent, files, store, step, tails, state,
    ask: (id: string, question: string, body = 'context') => void inbox.push({ id, from: 'term_sup', subject: `Advice: ${question}`, body }),
    raw: (m: { id: string; from: string; subject?: string; body?: string }) => void inbox.push(m),
    arriveLate: (id: string, question: string) => void lateMail.push({ id, from: 'term_sup', subject: `Advice: ${question}`, body: '' }),
    closeTerminal: (handle: string) => closedTerminals.add(handle),
    failStartingSaves: (on: boolean) => (failStartingSave = on),
    setWorkspaceIds: (ids: (string | null)[]) => (workspaceIds = [...ids]),
    advance: (ms: number) => (now += ms),
    launches: () => calls.filter((c) => c[0] === 'agent' && c[1] === 'launch'),
    removals: () => calls.filter((c) => c[0] === 'worktree' && c[1] === 'rm').map((c) => at(c, '--worktree').slice('path:'.length)),
    path: () => `/wt/${at(creates().at(-1)!, '--name')}`,
    answer: (text: string) => {
      const name = at(creates().at(-1)!, '--name')
      files[`/wt/${name}/${answerPath(name.slice('advice-'.length))}`] = text
    },
    briefed: () => advisor!.briefed('acme/app', { role: FABLE, address: 'term_mail' })
  }
}

describe('the advisor at work', () => {
  test('a question: read-only worktree at the default branch, the advisor on its model, its answer mailed back, the worktree gone', async () => {
    const h = advisorHarness()
    // It was briefed when its chat began, so nothing more is said about the advisor.
    await h.briefed()
    h.ask('m1', 'One PR for the migration, or two?', 'The schema change and the backfill touch different files.')
    const view = await h.step()
    const create = h.calls.find((c) => c[0] === 'worktree' && c[1] === 'create')!
    assert.ok(create.includes('origin/main'), 'at the default branch')
    assert.ok(at(create, '--branch').startsWith(`${REVIEW_BRANCH_PREFIX}advice-`), 'a review branch, so the board skips it')
    const launch = h.launches()[0]
    assert.deepEqual([at(launch, '--agent'), at(launch, '--model'), at(launch, '--effort')], ['claude', 'claude-fable-5-2', 'max'])
    const prompt = at(launch, '--prompt')
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
    await h.briefed()
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
    assert.ok(at(h.launches()[1], '--prompt').includes('second'))
  })

  test('a message that arrives between the peek and the consuming check is taken too; one without subject or body is not marked read', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'first')
    h.arriveLate('m2', 'late')
    h.raw({ id: 'm3', from: 'term_sup' })
    const view = await h.step()
    assert.equal(view?.queued, 1, 'the late one waits behind the first')
    const saved = h.store.get('advice:acme/app') as { seen: string[]; queue: { question: string }[] }
    assert.deepEqual(saved.queue.map((q) => q.question), ['late'])
    assert.deepEqual(saved.seen, ['m1', 'm2'])
  })

  test('in dry run, or with no supervisor, questions wait; nothing starts and nothing is sent', async () => {
    const h = advisorHarness()
    h.ask('m1', 'q')
    const dry = await h.step({ acting: false })
    assert.deepEqual([dry?.queued, dry?.waiting], [1, 'autopilot is off'])
    assert.equal(h.launches().length, 0)
    assert.equal(h.sent.length, 0)
    const lonely = await h.step({ supervisor: null })
    assert.deepEqual([lonely?.queued, h.launches().length], [1, 0])
    await h.step()
    assert.equal(h.launches().length, 1, 'it starts once autopilot is on')
  })

  test('an answer written in dry run waits, then is delivered once', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'q')
    await h.step()
    h.answer('{"answer": "yes"}')
    await h.step({ acting: false })
    assert.equal(h.sent.length, 0, 'autopilot went off: the answer waits')
    assert.equal(h.removals().length, 1, 'the worktree goes at once')
    await h.step()
    await h.step()
    assert.deepEqual(h.sent.map((m) => m.subject), ['Advice: q'])
  })

  test('no answer: quiet for the reviewer timeout, its terminal closed, or too long; the supervisor is told', async () => {
    const quiet = advisorHarness()
    await quiet.briefed()
    quiet.ask('m1', 'q')
    await quiet.step()
    quiet.advance(REVIEWER_TIMEOUT_MS + 1)
    await quiet.step()
    assert.equal(quiet.sent.length, 1)
    assert.equal(quiet.sent[0].subject, 'Advice: q (no answer)')
    assert.ok(quiet.sent[0].body.includes('quiet for 30 min'))
    assert.ok(quiet.calls.some((c) => c[0] === 'worktree' && c[1] === 'rm'))

    const closed = advisorHarness()
    await closed.briefed()
    closed.ask('m1', 'q')
    await closed.step()
    closed.closeTerminal('term-claude')
    await closed.step()
    assert.ok(closed.sent[0].body.includes('its terminal was closed'))

    // Busy all along, but past the limit.
    const slow = advisorHarness()
    await slow.briefed()
    slow.ask('m1', 'q')
    await slow.step()
    for (let t = 0; t <= ADVICE_MAX_MS; t += 20 * 60_000) {
      slow.tails['term-claude'] = [`working ${t}`]
      slow.advance(20 * 60_000)
      await slow.step()
    }
    assert.ok(slow.sent[0].body.includes('took over 2 hours'))
  })

  test('a prompt in its terminal needs you and is not quiet, but the 2-hour limit still frees the slot', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'q')
    await h.step()
    h.tails['term-claude'] = ['Do you trust the files in this folder?']
    const view = await h.step()
    assert.ok(view?.answering?.blocked?.includes('trust'))
    assert.equal(view?.answering?.terminal, 'term-claude')
    h.advance(REVIEWER_TIMEOUT_MS * 2)
    await h.step()
    assert.equal(h.sent.length, 0, 'still waiting on a person, not timed out')
    h.advance(ADVICE_MAX_MS)
    await h.step()
    assert.ok(h.sent[0].body.includes('waited on a person past the 2-hour limit'))
    assert.equal(h.removals().length, 1)
  })

  test("the question's own words in its terminal are not a prompt, a resume or a usage limit", async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'Should workers run codex resume after a crash?', 'Orca shows "Do you want to proceed?" and "usage limit reached" there; approve this?')
    await h.step()
    const brief = at(h.launches()[0], '--prompt')
    // The agent shows its prompt back: every line of the brief, framed.
    h.tails['term-claude'] = [...brief.split('\n').map((l) => `│ ${l}`), '⏺ Reading src/worker.ts']
    const view = await h.step()
    assert.equal(view?.answering?.blocked, null)
    assert.equal(h.sent.length, 0)
    assert.ok(!h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close'), 'not closed as resumed unlocked')
  })

  test('an agent resumed without the lockdown in any terminal of its worktree is closed, and the question ends', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'q')
    await h.step()
    // Orca restored a session in another terminal of the same worktree.
    h.tails['term-restored'] = ['➜ advice codex --model gpt resume 0193a']
    await h.step()
    assert.ok(h.calls.some((c) => c[0] === 'terminal' && c[1] === 'close' && at(c, '--terminal') === 'term-restored'))
    assert.ok(h.sent[0].body.includes("without Matriarch's read-only lockdown"))
    assert.equal(h.removals().length, 1)
  })

  test('a workspace id Orca lists late is looked up again and joins the guard', async () => {
    const h = advisorHarness({ workspaceIds: [null] })
    await h.briefed()
    h.ask('m1', 'q')
    await h.step()
    assert.equal(h.advisor.guard().ids.size, 0)
    h.setWorkspaceIds(['ws-advice'])
    await h.step()
    assert.ok(h.advisor.guard().ids.has('ws-advice'))
    assert.equal(h.advisor.guard().pathOf?.get('ws-advice'), h.path())
  })

  test('start failures each tell the supervisor; a worktree made before the failure goes', async () => {
    const cases: [HarnessOptions, string][] = [
      [{ fetchFails: true }, 'git fetch failed: could not reach origin'],
      [{ createFails: 'throw' }, 'worktree create failed: disk full'],
      [{ createFails: 'no-path' }, 'worktree create gave no path'],
      [{ launchFails: true }, 'launch failed: no such agent']
    ]
    for (const [opts, words] of cases) {
      const h = advisorHarness(opts)
      await h.briefed()
      h.ask('m1', 'q')
      const view = await h.step()
      assert.ok(h.sent[0]?.body.includes(words), `${words}: ${h.sent[0]?.body}`)
      assert.equal(view?.answering, null)
      assert.equal(h.advisor.guard().paths.length, 0)
      if (opts.launchFails) assert.equal(h.removals().length, 1)
    }
  })

  test('a reload while it starts never starts a second advisor, and the worktree it made goes', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'q')
    // The save after the worktree is made fails: nothing is launched, and that worktree goes.
    h.failStartingSaves(true)
    await assert.rejects(h.step())
    assert.equal(h.launches().length, 0)
    assert.deepEqual(h.removals(), [h.path()])
    h.failStartingSaves(false)
    // Saved as starting, with its worktree, then the plugin reloaded before it launched.
    const store = new Map(h.store)
    const saved = store.get('advice:acme/app') as { running: AdviceRun }
    store.set('advice:acme/app', { ...saved, running: { ...saved.running, worktree: { path: '/wt/advice-x', workspaceId: null } } })
    store.set('advice:active', ['acme/app'])
    const again = advisorHarness({ store })
    await again.advisor.load()
    assert.deepEqual(again.advisor.guard().paths, ['/wt/advice-x'], 'guarded from the start')
    await again.step()
    assert.equal(again.launches().length, 0)
    assert.deepEqual(again.removals(), ['/wt/advice-x'])
    assert.ok(again.sent.some((m) => m.subject === 'Advice: q (no answer)' && m.body.includes('interrupted while starting')))
  })

  test('after a restart, load() guards the running worktree and the leftovers, and leftovers are removed later', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m1', 'first')
    h.ask('m2', 'second')
    await h.step()
    const first = h.path()
    h.state.rmFails = true
    h.answer('{"answer": "a"}')
    await h.step()
    const second = h.path()
    assert.notEqual(first, second)
    const after = advisorHarness({ store: new Map(h.store) })
    await after.advisor.load()
    assert.deepEqual([...after.advisor.guard().paths].sort(), [first, second].sort())
    // Removing works again: the leftover goes on the next tick.
    await after.step()
    assert.ok(after.removals().includes(first))
    assert.ok(!after.advisor.guard().paths.includes(first))
  })

  test('the supervisor learns of the advisor when it started without one, when the mailbox is replaced, and when it is turned off', async () => {
    const h = advisorHarness()
    await h.step()
    assert.deepEqual(h.sent.map((m) => m.subject), ['Advisor available'])
    assert.ok(h.sent[0].body.includes('--to term_mail'))
    await h.step()
    assert.equal(h.sent.length, 1, 'once')
    // The mailbox terminal was closed: Orca refuses it, so a new one is made and the supervisor told.
    h.closeTerminal('term_mail')
    await h.step()
    await h.step()
    assert.equal(h.sent.length, 2)
    assert.ok(h.sent[1].body.includes('--to term_mail2'))
    assert.equal(h.sent[1].from, 'term_mail2')
    // Not in dry run.
    const off = await h.step({ config: withAdvisor(null), acting: false })
    assert.equal(h.sent.length, 2)
    assert.equal(off, null)
    await h.step({ config: withAdvisor(null) })
    assert.equal(h.sent[2].subject, 'Advisor turned off')
  })

  test('turning it off mid-question stops it and drops the waiting ones, saying so; more than the queue holds is turned away', async () => {
    const h = advisorHarness()
    await h.briefed()
    h.ask('m0', 'running')
    for (let i = 1; i <= MAX_QUEUED + 1; i++) h.ask(`m${i}`, `q${i}`)
    const view = await h.step()
    assert.equal(view?.queued, MAX_QUEUED)
    assert.ok(h.sent.some((m) => m.subject === `Advice: q${MAX_QUEUED + 1} (no answer)`))
    await h.step({ config: withAdvisor(null) })
    assert.ok(h.sent.some((m) => m.subject === 'Advice: running (no answer)' && m.body.includes('turned off')))
    const dropped = h.sent.find((m) => m.subject === `Advice: ${MAX_QUEUED} waiting questions dropped`)
    assert.ok(dropped?.body.includes('- q1'))
    assert.equal(h.advisor.guard().paths.length, 0)
  })
})

describe('the advisor starts locked down', () => {
  test('claude is rewritten to its read-only mode in the advisor worktree, and the hardened tool guard covers it', async () => {
    const lockdown = createLockdown(() => 1_000_000)
    const h = advisorHarness({ lockdown })
    await h.briefed()
    h.ask('m1', 'q')
    const view = await h.step()
    assert.equal(view?.answering?.lock, 'read-only: Claude dontAsk mode with a read-only allowlist')
    const path = h.advisor.guard().paths[0]
    const guard = joinGuards({ ids: new Set(), paths: [] }, h.advisor.guard())
    const ws = `repo1::${path}`
    assert.ok(reviewGuard({ tool: 'Edit', workspaceId: ws, input: { file_path: `${path}/src/a.ts` } }, guard)?.deny)
    assert.equal(reviewGuard({ tool: 'Write', workspaceId: ws, input: { file_path: `${path}/${answerPath('x')}` } }, guard), null)
    // The commands whose flags run a program are refused here too.
    assert.ok(reviewGuard({ tool: 'Bash', workspaceId: ws, input: { command: 'rg --pre ./x foo' } }, guard)?.deny)
    assert.ok(reviewGuard({ tool: 'Bash', workspaceId: ws, input: { command: 'git grep -O./x foo' } }, guard)?.deny)
  })

  test('an advisor Orca started without the lockdown is stopped, and the supervisor hears there is no answer', async () => {
    const h = advisorHarness({ lockdown: createLockdown(() => 1_000_000), hookRuns: false })
    await h.briefed()
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
    assert.equal(at(launch, '--agent'), 'grok')
    assert.equal(lockdown.confirmed(h.advisor.guard().paths[0], 'grok', 0), 'off')
  })

  test('with a review round and an advisor both at work, each launch is locked down in its own worktree', async () => {
    const lockdown = createLockdown(() => 1_000_000)
    const h = advisorHarness({ lockdown })
    await h.briefed()
    h.ask('m1', 'q')
    await h.step()
    const crewOrca: OrcaCli = { run: async (args) => (args[0] === 'worktree' && args[1] === 'create' ? { worktree: { path: '/wt/review-12' } } : args[0] === 'agent' ? { outcome: { handle: 't' } } : {}) }
    const crew = createCrew({
      orca: crewOrca,
      exec: async (_f, args) => ({ code: 0, stdout: args.includes('rev-parse') ? `${pr().headSha}\n` : '', stderr: '' }),
      readFile: async () => null, store: { get: async () => null, set: async () => {} }, now: () => 1_000_000, log: () => {}, workspaceIdFor: async () => 'ws-review'
    })
    await crew.start({ pr: pr(), root: '/r', config: config(), round: 1, reviewers: [{ name: 'correctness', agent: 'codex', blocking: true }] })
    const both = joinGuards(crew.guard(), h.advisor.guard())
    assert.equal(both.paths.length, 2)
    const advice = lockdown.onLaunch({ agent: 'codex', workspaceId: `repo1::${h.path()}`, command: 'codex --dangerously-bypass-approvals-and-sandbox p' }, both)
    const review = lockdown.onLaunch({ agent: 'claude', workspaceId: 'ws-review', command: 'claude --dangerously-skip-permissions p' }, both)
    assert.ok(advice && 'mode' in advice && advice.mode === 'codex-sandbox')
    assert.ok(review && 'mode' in review && review.mode === 'claude-dontask')
    // Anywhere else, launches pass untouched.
    assert.equal(lockdown.onLaunch({ agent: 'claude', workspaceId: 'repo1::/r/wt/login', command: 'claude p' }, both), null)
  })
})

describe("Matriarch's mailbox", () => {
  test('is reused while it lives, and made again once forgotten', async () => {
    const shown = new Set(['term_old'])
    const created: string[] = []
    const cli: OrcaCli = {
      async run(args) {
        if (args[1] === 'show') {
          if (!shown.has(at(args, '--terminal'))) throw new OrcaRefusal('terminal_not_found', 'gone')
          return {}
        }
        if (args[1] === 'create') {
          const handle = `term_${created.length + 1}`
          created.push(handle)
          shown.add(handle)
          return { terminal: { handle } }
        }
        return {}
      }
    }
    const store = new Map<string, unknown>([['mailbox:acme/app', 'term_old']])
    const boxes = createMailboxes(cli, { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) })
    assert.equal(await boxes.get('acme/app', '/r'), 'term_old')
    assert.equal(await boxes.get('acme/app', '/r'), 'term_old')
    // A handle that is no longer the one in use changes nothing.
    boxes.forget('acme/app', 'term_other')
    assert.equal(await boxes.get('acme/app', '/r'), 'term_old')
    shown.delete('term_old')
    boxes.forget('acme/app', 'term_old')
    assert.equal(await boxes.get('acme/app', '/r'), 'term_1')
    assert.equal(store.get('mailbox:acme/app'), 'term_1')
  })

  test('mail from a closed mailbox makes the executor drop it, so the next message gets a new one', async () => {
    const gone: string[] = []
    const cli: OrcaCli = { run: async () => { throw new OrcaRefusal('terminal_handle_stale', 'gone') } }
    const executor = createExecutor({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), orca: cli, notify: async () => {}, mailbox: async () => 'term_mail', mailboxGone: (_ctx, handle) => void gone.push(handle) })
    const out = await executor.execute({ kind: 'escalate', to: 'supervisor', key: 'k:supervisor', reason: 'r', address: 'run:r1' }, { repo: { owner: 'acme', name: 'app' }, pr: pr(), config: config(), root: '/r', supervisor: 'run:r1' })
    assert.equal(out.ok, false)
    assert.deepEqual(gone, ['term_mail'])
  })
})

describe('the engine with the advisor', () => {
  const base = { name: 'main', sha: 's', rollup: 'SUCCESS' }
  const deps = (h: ReturnType<typeof advisorHarness>, cfg: { current: MatriarchConfig | null }): EngineDeps => ({
    now: () => 1_000_000,
    log: () => {},
    workspaces: async () => [{ id: 'ws1', kind: 'folder', name: 'app', path: '/r', branch: 'main', hostId: null }],
    repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
    readConfig: async () => (cfg.current ? { config: cfg.current, errors: [], warnings: [] } : null),
    github: { listOpen: async () => ({ viewer: 'me', rate: null, prs: [], base }), detail: async () => ({ pr: null, rate: null }) },
    workers: async () => [],
    activity: () => null,
    supervisor: async () => 'run:r1',
    store: { get: async () => null, set: async () => {} },
    executor: { execute: async () => ({ ok: true }) },
    advisor: h.advisor
  })

  test('a real advisor: started from a tick, shown on its project, and stopped when the project is turned off', async () => {
    const h = advisorHarness()
    await h.briefed()
    const cfg: { current: MatriarchConfig | null } = { current: validateConfig({ review: { enabled: false }, advisor: FABLE }).config }
    h.ask('m1', 'q')
    const board = await tick(deps(h, cfg), { autopilot: true })
    assert.equal(board.repos[0].advisor?.answering?.question, 'q')
    assert.equal(at(h.calls.find((c) => c[0] === 'worktree' && c[1] === 'create')!, '--base-branch'), 'origin/main', 'on the default branch the forge named')
    h.ask('m2', 'waiting')
    await tick(deps(h, cfg), { autopilot: true })
    // Matriarch turned off for the project: its settings are gone.
    cfg.current = null
    await tick(deps(h, cfg), { autopilot: true })
    assert.deepEqual(h.removals(), [h.path()])
    assert.equal(h.advisor.guard().paths.length, 0)
    assert.ok(h.sent.some((m) => m.subject === 'Advisor turned off'))
    assert.ok(h.sent.some((m) => m.subject === 'Advice: q (no answer)' && m.body.includes('turned off for this project')))
    assert.ok(h.sent.some((m) => m.subject === 'Advice: 1 waiting question dropped'))
    assert.equal(h.store.get('advice:acme/app'), null, 'its state is cleared')
    // Nothing more on later ticks.
    const before = h.sent.length
    await tick(deps(h, cfg), { autopilot: true })
    assert.equal(h.sent.length, before)
  })

  test('a prompt the advisor waits on shows under Needs you with its terminal', async () => {
    const h = advisorHarness()
    await h.briefed()
    const cfg: { current: MatriarchConfig | null } = { current: validateConfig({ review: { enabled: false }, advisor: FABLE }).config }
    h.ask('m1', 'q')
    await tick(deps(h, cfg), { autopilot: true })
    h.tails['term-claude'] = ['Please log in to continue']
    const board = await tick(deps(h, cfg), { autopilot: true })
    assert.ok(board.attention.some((a) => a.key === 'acme/app:advisor' && a.terminal === 'term-claude'))
  })
})
