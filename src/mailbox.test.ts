// Matriarch's mailbox (mailbox.ts): every message handled once, replies matched to what Matriarch
// sent, the supervisor learned from its replies, and an answered escalation given its time.
// The shapes are those Orca 1.4.257 gave on a live mailbox.
import { assert, describe, test } from 'orca/testing'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import type { Executor } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { emptyHistory, insertLog } from './history.ts'
import { emptyLedger, ledgerKey, loadLedger, loadRepoEscalations, repoEscalationsKey, type PrLedger } from './ledger.ts'
import {
  applyReply, CATCH_UP_MS, createMailReader, emptyMailState, learnedSenders, learnSender, loadMailState, MAIL_WINDOW_MS, mailKey, newMail, parseMail,
  prOfSubject, recordSent, routeMail, takeMail, takenQuestions, whoReplied, type MailIdentities, type MailMessage, type MailReader, type MailReply,
  type MailState, type SentMail
} from './mailbox.ts'
import type { Action } from './plan.ts'
import { plan } from './plan.ts'
import type { LogEntry } from './protocol.ts'
import { OrcaRefusal } from './orca-cli.ts'
import { check, input, pr, SHA } from './testing/fixtures.ts'
import { supervisorSenders } from './worker.ts'

const T0 = 1_800_000_000_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const MAILBOX = 'term_6cd066ec-71c9-4d2e-ac42-a9b535b5bd82'
const SUPERVISOR = 'orca_session_id:claude_6976f2cb_1733_430d_838b_c98f76a94ff6'

/** A message as `check --peek --full --json` gave it for seaway's mailbox. */
function stored(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    run_id: 'run_989bb853ebdd',
    delivery_contract: 'current_delivery',
    from_handle: SUPERVISOR,
    to_handle: MAILBOX,
    subject: 'Re: Escalation: Matriarch needs a decision on seawaycd/seaway #4',
    body: 'PR #4 is intentionally still a draft: it is waiting on the P2 EGM gate.',
    type: 'status',
    priority: 'normal',
    thread_id: 'msg_9aac1c30b381',
    payload: null,
    created_at: iso(T0),
    delivered_at: null,
    ...over
  }
}
const msg = (id: string, over: Record<string, unknown> = {}): MailMessage => parseMail({ messages: [stored(id, over)] })[0]
/** Who the agents of a Run are: the supervisor addresses Matriarch knows, and its workers'. */
const known = (supervisors: string[] = [], workers: string[] = []): MailIdentities => ({ supervisorsOf: async () => supervisors, workersOf: () => new Set(workers) })
const take = (box: { reader: MailReader }, state: MailState, over: { supervisor?: string | null; now?: number; ids?: MailIdentities; log?: (m: string) => void } = {}) =>
  takeMail({ reader: box.reader, address: MAILBOX, state, supervisor: over.supervisor === undefined ? 'run:run_989bb853ebdd' : over.supervisor, ids: over.ids ?? known(), now: over.now ?? T0, log: over.log ?? (() => {}) })

describe('reading the mailbox', () => {
  test('takes the full record Orca stores, and leaves out one whose words did not come', () => {
    const [m] = parseMail({ ok: true, result: undefined, messages: [stored('msg_1c2dd5eb8a3b'), { id: 'msg_x', type: 'status' }] })
    assert.deepEqual(m, {
      id: 'msg_1c2dd5eb8a3b', from: SUPERVISOR, to: MAILBOX, subject: 'Re: Escalation: Matriarch needs a decision on seawaycd/seaway #4',
      body: 'PR #4 is intentionally still a draft: it is waiting on the P2 EGM gate.', threadId: 'msg_9aac1c30b381', runId: 'run_989bb853ebdd', at: T0
    })
    assert.equal(parseMail({ messages: [{ id: 'msg_x', type: 'status' }] }).length, 0)
    assert.deepEqual(parseMail(null), [])
  })

  test('knows the PR from each subject Matriarch writes, also as Orca relabelled an older escalation', () => {
    for (const [subject, n] of [
      ['Re: Rejected escalation: #2 needs a follow-up: AI review asks for changes on #2, round 1/3', 2],
      ['Re: Escalation: Matriarch needs a decision on seawaycd/seaway #4', 4],
      ['Re: seawaycd/seaway #8 is still a draft', 8],
      ['Re: #10 needs a follow-up: AI review asks for changes on #10, round 1/3', 10],
      ['#3 merged: rebase #4 onto main', 4],
      ['CI failed on #12 (a1b2c3d), round 1/3', 12],
      ['Re: Re: #12 conflicts with main, round 1/2', 12],
      ['Review feedback on #7, round 2/3', 7]
    ] as const) assert.equal(prOfSubject(subject), n, subject)
    for (const subject of ['Re: Worker settings changed', 'New objective: acme/app#5 Fix login', 'Re: Matriarch: no need to ask the user to merge']) assert.equal(prOfSubject(subject), null, subject)
  })
})

/** A mailbox over a list of stored messages, unread until marked; and a Run's mailbox for what Matriarch sent there. */
function mailbox(opts: { unread?: Record<string, unknown>[]; read?: Record<string, unknown>[]; run?: Record<string, unknown>[]; gone?: boolean } = {}) {
  let unread = [...(opts.unread ?? [])]
  let read = [...(opts.read ?? [])]
  const late: Record<string, unknown>[] = []
  const calls: string[] = []
  const reader: MailReader = {
    unread: async () => {
      calls.push('unread')
      if (opts.gone) throw new OrcaRefusal('terminal_handle_stale', 'gone')
      return parseMail({ messages: unread })
    },
    recent: async () => (calls.push('recent'), parseMail({ messages: [...unread, ...read] })),
    markRead: async () => {
      calls.push('markRead')
      const batch = [...unread, ...late]
      read = [...read, ...batch]
      unread = []
      late.length = 0
      return parseMail({ messages: batch })
    },
    runMail: async (run) => (calls.push(`runMail ${run}`), parseMail({ messages: opts.run ?? [] }))
  }
  return { reader, calls, arrive: (m: Record<string, unknown>) => void unread.push(m), arriveLate: (m: Record<string, unknown>) => void late.push(m) }
}

describe('taking mail', () => {
  test("handles what an older Matriarch marked read without reading it, through the catch-up read, each message once", async () => {
    // As seaway's mailbox was: every reply read already, none handled.
    const box = mailbox({
      read: [stored('msg_r1', { thread_id: 'msg_esc4' }), stored('msg_r2', { thread_id: 'msg_draft8', subject: 'Re: seawaycd/seaway #8 is still a draft', body: 'Marked it ready.', created_at: iso(T0 + 60_000) })],
      // What Matriarch sent the supervisor's Run before it kept a record, as Orca still has it.
      run: [
        stored('msg_esc4', { from_handle: MAILBOX, to_handle: 'run:run_989bb853ebdd', subject: 'Escalation: Matriarch needs a decision on seawaycd/seaway #4', body: '#4 has been a draft for 60 min…', thread_id: null }),
        stored('msg_draft8', { from_handle: MAILBOX, to_handle: 'run:run_989bb853ebdd', subject: 'seawaycd/seaway #8 is still a draft', thread_id: null }),
        // Not Matriarch's: a worker's report in the same Run is no thread Matriarch started.
        stored('msg_other', { from_handle: 'orca_session_id:worker', to_handle: 'run:run_989bb853ebdd', thread_id: null })
      ]
    })
    const taken = await take(box, emptyMailState(), { now: T0 + 120_000 })
    assert.deepEqual(taken.replies.map((r) => [r.message.id, r.sent.number, r.sent.kind, r.who]), [['msg_r1', 4, 'escalate', 'supervisor'], ['msg_r2', 8, 'draft', 'supervisor']])
    assert.deepEqual(learnedSenders(taken.state, 'run:run_989bb853ebdd'), [SUPERVISOR], 'the first chat to reply, with no supervisor known, is learned')
    assert.deepEqual(Object.keys(taken.state.handled).sort(), ['msg_r1', 'msg_r2'])
    assert.equal(box.calls.filter((c) => c.startsWith('runMail')).length, 1, "the Run's mailbox is read once for both")
    assert.ok(!box.calls.includes('markRead'), 'nothing unread to mark')
    // The next tick, within the half hour: only the unread are read, and nothing is taken again.
    const again = await take(box, taken.state, { now: T0 + 180_000 })
    assert.deepEqual([again.replies.length, box.calls.filter((c) => c === 'recent').length], [0, 1])
    // After it, the recent mail is read again, and still nothing is taken twice.
    const later = await take(box, again.state, { now: T0 + 120_000 + CATCH_UP_MS })
    assert.deepEqual([later.replies.length, box.calls.filter((c) => c === 'recent').length], [0, 2])
  })

  test('takes the unread, marks them read as a courtesy, and takes what arrived in between from that batch', async () => {
    const box = mailbox({ unread: [stored('msg_q', { subject: 'Advice: one PR or two?', thread_id: null })] })
    box.arriveLate(stored('msg_q2', { subject: 'Advice: and the backfill?', thread_id: null }))
    const state = { ...emptyMailState(), caughtUpAt: T0 }
    const taken = await take(box, state, { supervisor: 'run:r1', now: T0 + 1000 })
    assert.deepEqual(taken.state.pending.map((q) => q.id), ['msg_q', 'msg_q2'], 'pending until the advisor stores them')
    assert.deepEqual(box.calls, ['unread', 'markRead'])
    assert.deepEqual(takenQuestions(taken.state, ['msg_q']).pending.map((q) => q.id), ['msg_q2'])
  })

  test("mail from Matriarch's own mailboxes is not a reply, mail older than a week is not taken, and the rest is dropped and logged", async () => {
    const logs: string[] = []
    const box = mailbox({
      unread: [
        stored('msg_self', { from_handle: MAILBOX, subject: 'Matriarch live check (ignore)', thread_id: null }),
        stored('msg_old', { created_at: iso(T0 - MAIL_WINDOW_MS - 1) }),
        stored('msg_cold', { from_handle: 'term_someone', subject: 'Please merge everything', thread_id: null })
      ]
    })
    const taken = await take(box, { ...emptyMailState(), caughtUpAt: T0 }, { supervisor: 'run:r1', log: (m) => void logs.push(m) })
    assert.deepEqual([taken.state.pending.length, taken.replies.length, taken.loose.length], [0, 0, 0])
    assert.ok(logs.some((l) => /so it is dropped: "Please merge everything" from term_someone/.test(l)))
    assert.ok(!('msg_old' in taken.state.handled))
  })

  test("a reply whose thread is gone from Orca shows in its PR's log by its subject, only from the supervisor or a worker, and does nothing more", async () => {
    const gone = (id: string, from: string) => stored(id, { from_handle: from, thread_id: 'msg_gone', subject: 'Re: #10 needs a follow-up: AI review asks for changes on #10, round 1/3' })
    const box = mailbox({ unread: [gone('msg_s', SUPERVISOR), gone('msg_w', 'term_worker'), gone('msg_x', 'term_stranger')] })
    const taken = await take(box, { ...emptyMailState(), caughtUpAt: T0 }, { ids: known([SUPERVISOR], ['term_worker']) })
    assert.deepEqual(taken.loose.map((l) => [l.message.id, l.number, l.who]), [['msg_s', 10, 'supervisor'], ['msg_w', 10, 'worker']])
    assert.deepEqual(taken.replies, [])
    assert.deepEqual(learnedSenders(taken.state, 'run:run_989bb853ebdd'), [], 'no thread of its own: no sender learned')
  })

  test('a reply filed under no Run, or another Run than the supervisor\'s, is not looked up in Orca; a thread found twice is kept once', async () => {
    const box = mailbox({
      unread: [stored('msg_u', { run_id: 'run_unbound', thread_id: 'msg_x' }), stored('msg_o', { run_id: 'run_other', thread_id: 'msg_x' })],
      run: [stored('msg_esc4', { from_handle: MAILBOX, to_handle: 'run:run_989bb853ebdd', thread_id: null })]
    })
    await take(box, { ...emptyMailState(), caughtUpAt: T0 })
    assert.ok(!box.calls.some((c) => c.startsWith('runMail')), 'no read of other mail for them')
    const twice = mailbox({
      unread: [stored('msg_a', { thread_id: 'msg_esc4' }), stored('msg_b', { thread_id: 'msg_esc4', created_at: iso(T0 + 1000) })],
      run: [stored('msg_esc4', { from_handle: MAILBOX, to_handle: 'run:run_989bb853ebdd', thread_id: null })]
    })
    const taken = await take(twice, { ...emptyMailState(), caughtUpAt: T0 }, { now: T0 + 2000 })
    assert.equal(taken.replies.length, 2)
    assert.deepEqual(taken.state.sent.map((s) => s.id), ['msg_esc4'])
  })

  test('unread and catch-up bringing the same message in one tick take it once; the week\'s edge is kept, older not', () => {
    const state = emptyMailState()
    const m = msg('m1')
    assert.deepEqual(newMail(state, [m, m, msg('m1')], T0).map((x) => x.id), ['m1'])
    const edge = msg('edge', { created_at: iso(T0 - MAIL_WINDOW_MS) })
    const past = msg('past', { created_at: iso(T0 - MAIL_WINDOW_MS - 1000) })
    assert.deepEqual(newMail(state, [edge, past], T0).map((x) => x.id), ['edge'])
  })

  test('a mailbox Orca says is gone is reported, and nothing is taken', async () => {
    const taken = await take(mailbox({ gone: true }), emptyMailState(), { supervisor: null })
    assert.equal(taken.gone, true)
  })

  test('a reply in a thread Matriarch recorded is matched without asking Orca', async () => {
    const state = loadMailState({ ...emptyMailState(), sent: [{ id: 'msg_1', at: T0, to: 'run:run_989bb853ebdd', subject: 'x', kind: 'escalate', number: 12, key: 'ci:abc:supervisor' }, { id: 'msg_2', at: T0, to: 'dispatch:d1', subject: 'CI failed on #12', kind: 'send-ci-failure', number: 12 }] })
    const routed = routeMail(state, [msg('r1', { thread_id: 'msg_1' }), msg('r2', { thread_id: 'msg_2', from_handle: 'term_worker' })], MAILBOX)
    assert.deepEqual(routed.threaded.map((r) => [r.message.id, r.sent.key ?? null]), [['r1', 'ci:abc:supervisor'], ['r2', null]])
    const store = new Map<string, unknown>()
    await recordSent({ get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) }, 'acme/app', { id: 'msg_9', from: MAILBOX }, { at: T0, to: 'run:r1', subject: 's', kind: 'settings' })
    assert.deepEqual(loadMailState(store.get(mailKey('acme/app'))).own, [MAILBOX], 'its own mailbox is known, so its own mail is never a reply')
  })
})

describe('who replied', () => {
  const toRun: SentMail = { id: 'msg_esc', at: T0, to: 'run:run_989bb853ebdd', subject: 'Escalation: …', kind: 'escalate', number: 12, key: `orphan-ci:${SHA}:supervisor` }
  const toWorker: SentMail = { id: 'msg_ci', at: T0, to: 'dispatch:d1', subject: 'CI failed on #12', kind: 'send-ci-failure', number: 12 }
  const reply = (from: string, over: Record<string, unknown> = {}) => msg('r', { from_handle: from, thread_id: 'msg_esc', ...over })

  test("a worker's terminal replying in a thread to the supervisor's Run is a worker, never learned as the supervisor", async () => {
    // Orca lets any caller reply to any message, filed under the original's Run.
    const told = await whoReplied(emptyMailState(), known([], ['term_worker_d1']), reply('term_worker_d1'), toRun)
    assert.deepEqual(told, { who: 'worker', learn: false, stranger: false })
    const state = learnSender(emptyMailState(), { message: reply('term_worker_d1'), sent: toRun, who: told.who })
    assert.deepEqual(learnedSenders(state, 'run:run_989bb853ebdd'), [])
    // A terminal that is nobody known is no one's: not the supervisor, and not learned.
    assert.deepEqual(await whoReplied(emptyMailState(), known(), reply('term_someone'), toRun), { who: 'other', learn: false, stranger: false })
  })

  test('the supervisor is a known address, or the first chat to reply while none is known; a second chat is not, and is pointed out', async () => {
    assert.deepEqual(await whoReplied(emptyMailState(), known([SUPERVISOR]), reply(SUPERVISOR), toRun), { who: 'supervisor', learn: false, stranger: false })
    assert.deepEqual(await whoReplied(emptyMailState(), known(), reply(SUPERVISOR), toRun), { who: 'supervisor', learn: true, stranger: false })
    assert.deepEqual(await whoReplied(emptyMailState(), known([SUPERVISOR]), reply('orca_session_id:claude_other'), toRun), { who: 'other', learn: false, stranger: true })
    const learned = learnSender(emptyMailState(), { message: reply(SUPERVISOR), sent: toRun, who: 'supervisor' })
    assert.deepEqual(await whoReplied(learned, known(), reply('orca_session_id:claude_other'), toRun), { who: 'other', learn: false, stranger: true }, 'the first wins')
    // A chat session that is one of its workers is never the supervisor.
    assert.deepEqual(await whoReplied(emptyMailState(), known([], ['orca_session_id:claude_w']), reply('orca_session_id:claude_w'), toRun), { who: 'worker', learn: false, stranger: false })
    // Filed under another Run than the one Matriarch wrote to.
    assert.deepEqual(await whoReplied(emptyMailState(), known([SUPERVISOR]), reply(SUPERVISOR, { run_id: 'run_other' }), toRun), { who: 'other', learn: false, stranger: false })
  })

  test("a reply in a worker's thread is the worker only from its Run's workers' addresses", async () => {
    assert.equal((await whoReplied(emptyMailState(), known([], ['term_w']), reply('term_w', { thread_id: 'msg_ci' }), toWorker)).who, 'worker')
    assert.equal((await whoReplied(emptyMailState(), known([], ['term_w']), reply('term_x', { thread_id: 'msg_ci' }), toWorker)).who, 'other')
  })
})

describe('a reply on its PR', () => {
  const sent: SentMail = { id: 'msg_esc', at: T0, to: 'run:r1', subject: 'Escalation: Matriarch needs a decision on acme/app #12', kind: 'escalate', number: 12, key: `orphan-ci:${SHA}:supervisor` }
  const reply = (body: string, at = T0 + 60_000): MailReply => ({ message: msg('r', { body, created_at: iso(at), thread_id: 'msg_esc' }), sent, who: 'supervisor' })
  const escalated = (over: Partial<PrLedger> = {}): PrLedger => ({ ...emptyLedger(), escalations: { [`orphan-ci:${SHA}:supervisor`]: { to: 'supervisor', at: T0, reason: 'CI failing; no supervised worker owns branch feature/login' } }, ...over })

  test('answers its escalation, is its latest note, and reads as a line in its log', () => {
    const out = applyReply(escalated(), reply('A fixer is on it: dispatch ctx_4e8.'), T0 + 90_000)
    assert.equal(out.answered, `orphan-ci:${SHA}:supervisor`)
    assert.deepEqual(out.ledger.escalations[`orphan-ci:${SHA}:supervisor`].answered, { at: T0 + 60_000, text: 'A fixer is on it: dispatch ctx_4e8.', textAt: T0 + 60_000, count: 1 })
    assert.deepEqual(out.ledger.notes?.map((n) => [n.from, n.text]), [['supervisor', 'A fixer is on it: dispatch ctx_4e8.']])
    assert.deepEqual([out.entry.at, out.entry.kind, out.entry.text, out.entry.subject], [T0 + 60_000, 'reply', 'The supervisor answered the escalation: A fixer is on it: dispatch ctx_4e8.', sent.subject])
    // A second answer brings its words up to date; the window still runs from the first.
    const twice = applyReply(out.ledger, reply('Still on it.', T0 + 120_000), T0 + 130_000)
    assert.deepEqual(twice.ledger.escalations[`orphan-ci:${SHA}:supervisor`].answered, { at: T0 + 60_000, text: 'Still on it.', textAt: T0 + 120_000, count: 2 })
    // An older reply a catch-up read brings late does not overwrite the newer words.
    const late = applyReply(twice.ledger, reply('first thoughts', T0 + 30_000), T0 + 140_000)
    assert.deepEqual(late.ledger.escalations[`orphan-ci:${SHA}:supervisor`].answered, { at: T0 + 30_000, text: 'Still on it.', textAt: T0 + 120_000, count: 3 })
  })

  test('a reply to a draft nudge, or from anyone but the supervisor, answers nothing; one from someone unknown is no note', () => {
    const draft: SentMail = { ...sent, kind: 'draft', key: `draft:${SHA}:supervisor`, subject: 'acme/app #12 is still a draft' }
    const ledger = escalated({ escalations: { ...escalated().escalations, [`draft:${SHA}:supervisor`]: { to: 'supervisor', at: T0, reason: 'draft' } } })
    const d = applyReply(ledger, { ...reply('Leaving it as a draft: it waits on the gate.'), sent: draft }, T0 + 90_000)
    assert.equal(d.answered, null)
    assert.equal(d.entry.text, 'The supervisor replied: Leaving it as a draft: it waits on the gate.')
    const other = applyReply(escalated(), { ...reply('done'), who: 'other' }, T0 + 90_000)
    assert.equal(other.answered, null)
    assert.equal(other.entry.text, `A reply from ${SUPERVISOR}: done`)
    assert.equal(other.ledger.notes, undefined)
    const worker = applyReply(escalated(), { ...reply('fixed'), who: 'worker' }, T0 + 90_000)
    assert.equal(worker.answered, null)
  })

  test('a repository-wide escalation is answered in the shared record, not on the PR', () => {
    const key = 'base-red:base1:supervisor'
    const shared = { [key]: { to: 'supervisor' as const, at: T0, reason: 'merge train paused' } }
    const out = applyReply(emptyLedger(), { ...reply('Reverting the bad commit.'), sent: { ...sent, key } }, T0 + 90_000, shared)
    assert.equal(out.answered, key)
    assert.equal(out.shared[key].answered?.text, 'Reverting the bad commit.')
    assert.equal(out.ledger.escalations[key], undefined)
  })

  test('does not answer one already sent on to the person, or newer than the reply', () => {
    const toYou = escalated({ escalations: { ...escalated().escalations, [`orphan-ci:${SHA}:human`]: { to: 'human', at: T0 + 30 * 60_000, reason: 'r' } } })
    assert.equal(applyReply(toYou, reply('late answer'), T0).answered, null)
    assert.equal(applyReply(escalated(), reply('an answer from before it', T0 - 60_000), T0).answered, null)
  })

  test('mail found in Orca after the fact answers the escalation whose reason it carried', () => {
    const before: SentMail = { id: 'msg_esc', at: T0 + 2000, to: 'run:r1', subject: sent.subject, kind: 'escalate', number: 12, text: `${sent.subject}\n\nCI failing; no supervised worker owns branch feature/login\n\nDecide…` }
    const out = applyReply(escalated(), { ...reply('Handled.'), sent: before }, T0 + 90_000)
    assert.equal(out.answered, `orphan-ci:${SHA}:supervisor`)
  })

  test('a long reply keeps its whole text for the log, and its line short', () => {
    const long = 'word '.repeat(200)
    const out = applyReply(emptyLedger(), reply(long), T0)
    assert.ok(out.entry.text.length < 300 && out.entry.detail?.startsWith('word word'))
  })
})

describe('an answered escalation', () => {
  const orphan = pr({ number: 12, ci: 'failing', checks: [check('test', 'failure')] })
  const key = `orphan-ci:${SHA}`
  const ledger = (answered?: { at: number; text: string }): PrLedger => ({
    ...emptyLedger(),
    heads: { [SHA]: T0 - 3600_000 },
    escalations: { [`${key}:supervisor`]: { to: 'supervisor', at: T0, reason: 'r', ...(answered ? { answered } : {}) } }
  })
  const planAt = (now: number, l: PrLedger) => plan(input({ pr: orphan, owner: null, supervisor: 'run:r1', ownersKnown: true, now }, l))
  const toPerson = (actions: Action[]) => actions.find((a) => a.kind === 'escalate' && a.to === 'human')

  test('unanswered, reaches the person once the supervisor had its time', () => {
    assert.equal(toPerson(planAt(T0 + 29 * 60_000, ledger()).actions), undefined)
    assert.ok(toPerson(planAt(T0 + 31 * 60_000, ledger()).actions))
  })

  test('answered, gets that long again from its answer; still so after it, the person hears with the answer', () => {
    const answered = ledger({ at: T0 + 20 * 60_000, text: 'A fixer is on it.' })
    assert.equal(toPerson(planAt(T0 + 31 * 60_000, answered).actions), undefined, 'not at the first window')
    const late = toPerson(planAt(T0 + 51 * 60_000, answered).actions)
    assert.ok(late && late.kind === 'escalate')
    assert.match(late.reason, /The supervisor wrote 31 min ago: "A fixer is on it\.", and it is still so/)
    // Its latest words, with when it wrote them, and when it first answered.
    const twice = ledger({ at: T0 + 20 * 60_000, text: 'Still on it.', textAt: T0 + 40 * 60_000, count: 2 } as { at: number; text: string })
    assert.match(toPerson(planAt(T0 + 51 * 60_000, twice).actions)!.kind === 'escalate' ? (toPerson(planAt(T0 + 51 * 60_000, twice).actions) as { reason: string }).reason : '', /The supervisor wrote 11 min ago \(it first answered 31 min ago\): "Still on it\."/)
  })
})

describe('the log keeps time order', () => {
  test('a reply that came earlier goes where it happened, once', () => {
    const e = (at: number, text: string): LogEntry => ({ at, kind: 'lane', text })
    let h = { ...emptyHistory(), log: [e(10, 'a'), e(30, 'c')] }
    h = insertLog(h, { at: 20, kind: 'reply', text: 'b' })
    h = insertLog(h, { at: 20, kind: 'reply', text: 'b' })
    h = insertLog(h, { at: 40, kind: 'reply', text: 'd' })
    assert.deepEqual(h.log.map((x) => x.text), ['a', 'b', 'c', 'd'])
  })
})

describe('the engine and its mailbox', () => {
  const failing = pr({ number: 12, ci: 'failing', checks: [check('test', 'failure')] })
  function engine(prs: PrSnapshot[]) {
    const store = new Map<string, unknown>()
    const executed: Action[] = []
    let now = T0
    let n = 0
    const github: GitHub = {
      listOpen: async () => ({ viewer: 'me', rate: null, prs: prs.map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, author: p.author, updatedAt: p.updatedAt, rollup: p.ci })) }),
      detail: async (_r, number) => ({ pr: { ...prs.find((p) => p.number === number)!, fetchedAt: now }, rate: null })
    }
    // Sends as the real executor reports them: who to, and the id Orca gave the message.
    const executor: Executor = {
      async execute(action) {
        executed.push(action)
        if (action.kind === 'escalate' && action.to === 'supervisor') return { ok: true, sent: { to: 'supervisor', subject: `Escalation: Matriarch needs a decision on acme/app #12`, address: action.address!, messageId: `msg_${++n}`, from: MAILBOX } }
        return { ok: true }
      }
    }
    const box = mailbox()
    const workspaces: Workspace[] = [{ id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null }]
    const deps: EngineDeps = {
      now: () => now,
      log: () => {},
      workspaces: async () => workspaces,
      repoOf: async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' }),
      readConfig: async () => validateConfig({ review: { enabled: false } }),
      github,
      // No worker owns the branch: the PR is the supervisor's to sort out.
      workers: async () => [],
      activity: () => null,
      supervisor: async () => 'run:r1',
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      executor,
      mail: box.reader,
      mailbox: async () => MAILBOX
    }
    return { deps, store, executed, box, advance: (ms: number) => (now += ms), now: () => now }
  }

  test("the supervisor's answer is on the PR: its log, its card, and the person is not told until the answer's time ran out", async () => {
    const e = engine([failing])
    await tick(e.deps, { autopilot: true })
    assert.deepEqual(e.executed.map((a) => a.kind === 'escalate' && a.to), ['supervisor'])
    // The supervisor replies in that message's thread, ten minutes later.
    e.advance(10 * 60_000)
    e.box.arrive(stored('msg_reply', { thread_id: 'msg_1', run_id: 'r1', subject: 'Re: Escalation: Matriarch needs a decision on acme/app #12', body: 'Handled: a fixer is on it (dispatch ctx_4e8).', created_at: iso(e.now() - 60_000) }))
    const board = await tick(e.deps, { autopilot: true })
    const card = board.tracks.find((t) => t.pr?.number === 12)!
    assert.deepEqual(card.pr?.note, { at: e.now() - 60_000, from: 'supervisor', text: 'Handled: a fixer is on it (dispatch ctx_4e8).' })
    const log = (e.store.get(`track:${card.key}`) as { log: LogEntry[] }).log
    assert.ok(log.some((l) => l.kind === 'reply' && l.text === 'The supervisor answered the escalation: Handled: a fixer is on it (dispatch ctx_4e8).'))
    assert.deepEqual(learnedSenders(loadMailState(e.store.get(mailKey('acme/app'))), 'run:r1'), [SUPERVISOR])
    // At the first window the person is not told: the supervisor answered.
    e.advance(25 * 60_000)
    await tick(e.deps, { autopilot: true })
    assert.ok(!e.executed.some((a) => a.kind === 'escalate' && a.to === 'human'))
    // Its own window from the answer ran out, and the PR is as it was: now the person hears, with the answer.
    e.advance(10 * 60_000)
    await tick(e.deps, { autopilot: true })
    const human = e.executed.find((a) => a.kind === 'escalate' && a.to === 'human')
    assert.ok(human && human.kind === 'escalate' && /The supervisor wrote 3\d min ago: "Handled: a fixer is on it/.test(human.reason))
    // Exactly once.
    e.advance(5 * 60_000)
    await tick(e.deps, { autopilot: true })
    assert.equal(e.executed.filter((a) => a.kind === 'escalate' && a.to === 'human').length, 1)
    assert.equal(loadLedger(e.store.get(ledgerKey('acme/app', 12))).notes?.length, 1, 'the reply is kept once')
  })

  test('in dry run the mail is read and replies are logged, and nothing is sent', async () => {
    const e = engine([failing])
    e.deps.supervisorSenders = async () => [SUPERVISOR]
    e.box.arrive(stored('msg_x', { thread_id: 'msg_gone', run_id: 'r1', subject: 'Re: #12 needs a follow-up: CI failed on #12', body: 'On it.' }))
    const board = await tick(e.deps, { autopilot: false })
    assert.deepEqual(e.executed, [])
    const card = board.tracks.find((t) => t.pr?.number === 12)!
    const log = (e.store.get(`track:${card.key}`) as { log: LogEntry[] }).log
    assert.ok(log.some((l) => l.kind === 'reply' && l.text === 'The supervisor wrote about this PR: On it.'))
  })

  test('nothing new: the mail record is not written again', async () => {
    const e = engine([failing])
    await tick(e.deps, { autopilot: false })
    let writes = 0
    const set = e.deps.store.set
    e.deps.store.set = async (k, v) => (k === mailKey('acme/app') && writes++, set(k, v))
    e.advance(60_000)
    await tick(e.deps, { autopilot: false })
    assert.equal(writes, 0)
  })

  test("a reply read while the forge's list fails lands in the log the card opens, the worktree's", async () => {
    const e = engine([failing])
    e.deps.workers = async () => [{ dispatchId: 'd1', worktreeId: 'ws-login', taskId: 't', runId: 'r1', agent: 'codex', model: null, state: null, terminal: 'term_w' }]
    e.store.set(mailKey('acme/app'), { ...emptyMailState(), sent: [{ id: 'msg_ci', at: T0, to: 'dispatch:d1', subject: 'CI failed on #12 (a1b2c3d), round 1/3', kind: 'send-ci-failure', number: 12 }] })
    const first = await tick(e.deps, { autopilot: false })
    const key = first.tracks.find((t) => t.pr?.number === 12)!.key
    assert.equal(key, 'ws-login')
    const listOpen = e.deps.github.listOpen
    e.deps.github.listOpen = async () => {
      throw new Error('API rate limit exceeded')
    }
    e.advance(60_000)
    e.box.arrive(stored('msg_w', { from_handle: 'term_w', run_id: 'r1', thread_id: 'msg_ci', subject: 'Re: CI failed on #12 (a1b2c3d), round 1/3', body: 'Fixed in the next push.', created_at: iso(e.now()) }))
    await tick(e.deps, { autopilot: false })
    e.deps.github.listOpen = listOpen
    e.advance(60_000)
    await tick(e.deps, { autopilot: false })
    const log = (e.store.get(`track:${key}`) as { log: LogEntry[] }).log
    assert.ok(log.some((l) => l.kind === 'reply' && l.text === 'The worker replied: Fixed in the next push.'))
  })

  test("a question survives a failure between reading it and the advisor's save, and is handed over until the advisor stored it", async () => {
    const e = engine([failing])
    const handed: string[][] = []
    let fail = true
    e.deps.advisor = {
      step: async (input) => {
        handed.push((input.questions ?? []).map((q) => q.id))
        if (fail) throw new Error('storage write failed')
        return null
      }
    }
    e.box.arrive(stored('msg_q', { subject: 'Advice: one PR or two?', thread_id: null }))
    await tick(e.deps, { autopilot: true })
    assert.deepEqual(loadMailState(e.store.get(mailKey('acme/app'))).pending.map((q) => q.id), ['msg_q'], 'still pending: the advisor did not store it')
    fail = false
    e.advance(60_000)
    await tick(e.deps, { autopilot: true })
    e.advance(60_000)
    await tick(e.deps, { autopilot: true })
    assert.deepEqual(handed, [['msg_q'], ['msg_q'], []])
    assert.deepEqual(loadMailState(e.store.get(mailKey('acme/app'))).pending, [])
  })

  test('the card shows only a reply since the PR\'s current head', async () => {
    const e = engine([failing])
    e.store.set(ledgerKey('acme/app', 12), { ...emptyLedger(), heads: { [SHA]: T0 }, notes: [{ at: T0 - 3600_000, from: 'supervisor', subject: 's', text: 'about an older commit' }] })
    const board = await tick(e.deps, { autopilot: false })
    assert.equal(board.tracks.find((t) => t.pr?.number === 12)!.pr?.note, undefined)
  })

  test('CI red on the base with two ready PRs: one escalation, answered once for both, and the person told once after its time', async () => {
    const a = pr({ number: 12 })
    const b = pr({ number: 13, headRef: 'feature/b', headSha: 'b'.repeat(40) })
    const e = engine([a, b])
    e.deps.workspaces = async () => [
      { id: 'ws-login', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: 'feature/login', hostId: null },
      { id: 'ws-b', kind: 'worktree', name: 'b', path: '/r/wt/b', branch: 'feature/b', hostId: null }
    ]
    e.deps.readConfig = async () => validateConfig({ review: { enabled: false }, merge: { mode: 'auto' } })
    const list = e.deps.github.listOpen
    e.deps.github.listOpen = async (...args) => ({ ...(await list(...args)), base: { name: 'main', sha: 'base1', rollup: 'FAILURE' } })
    e.store.set(ledgerKey('acme/app', 12), { heads: { [SHA]: 0 } })
    e.store.set(ledgerKey('acme/app', 13), { heads: { ['b'.repeat(40)]: 0 } })
    await tick(e.deps, { autopilot: true })
    const toSupervisor = e.executed.filter((x) => x.kind === 'escalate' && x.to === 'supervisor')
    assert.equal(toSupervisor.length, 1, 'one problem, raised once')
    e.advance(10 * 60_000)
    e.box.arrive(stored('msg_reply', { run_id: 'r1', thread_id: 'msg_1', subject: 'Re: Escalation: Matriarch needs a decision on acme/app #12', body: 'Reverting the bad commit now.', created_at: iso(e.now()) }))
    await tick(e.deps, { autopilot: true })
    const shared = loadRepoEscalations(e.store.get(repoEscalationsKey('acme/app')))
    assert.equal(shared['base-red:base1:supervisor'].answered?.text, 'Reverting the bad commit now.')
    // Past the first window, inside the answered one: neither PR goes to the person.
    e.advance(21 * 60_000)
    await tick(e.deps, { autopilot: true })
    assert.equal(e.executed.filter((x) => x.kind === 'escalate' && x.to === 'human').length, 0)
    // Its time ran out with the base still red: the person hears once, with the answer.
    e.advance(10 * 60_000)
    await tick(e.deps, { autopilot: true })
    e.advance(60_000)
    await tick(e.deps, { autopilot: true })
    const human = e.executed.filter((x) => x.kind === 'escalate' && x.to === 'human')
    assert.equal(human.length, 1)
    assert.match((human[0] as { reason: string }).reason, /Reverting the bad commit now/)
  })

  test('a project with no mailbox gets none made for reading', async () => {
    const e = engine([failing])
    e.deps.mailbox = async () => null
    await tick(e.deps, { autopilot: false })
    assert.deepEqual(e.box.calls, [])
  })
})

test('the reader asks Orca as 1.4.257 takes it, and finds a Run\'s mail across Orca when the Run cannot be asked directly', async () => {
  const calls: string[][] = []
  const all = [stored('msg_a', { to_handle: 'run:r1', from_handle: MAILBOX, thread_id: null }), stored('msg_b', { to_handle: 'run:r2', from_handle: MAILBOX, thread_id: null })]
  const cli = {
    run: async (args: readonly string[]) => {
      calls.push([...args])
      if (args[1] === 'inbox' && args.includes('run:r1')) throw new OrcaRefusal('invalid_argument', 'not a terminal')
      return { messages: args[1] === 'inbox' && !args.includes('--terminal') ? all : [] }
    }
  }
  const reader = createMailReader(cli)
  await reader.unread(MAILBOX)
  await reader.recent(MAILBOX)
  await reader.markRead(MAILBOX)
  assert.deepEqual((await reader.runMail('run:r1')).map((m) => m.id), ['msg_a'])
  assert.deepEqual(calls.map((c) => c.join(' ')), [
    `orchestration check --terminal ${MAILBOX} --peek --full`,
    `orchestration inbox --terminal ${MAILBOX} --limit 500 --full`,
    `orchestration check --terminal ${MAILBOX} --full`,
    'orchestration inbox --terminal run:r1 --limit 500 --full',
    'orchestration inbox --limit 500 --full'
  ])
})

test("the supervisor's addresses include the senders of its replies in Matriarch's threads with its Run", async () => {
  const store = new Map<string, unknown>([[mailKey('acme/app'), { ...emptyMailState(), senders: { [SUPERVISOR]: { run: 'run:r1', at: T0 }, 'orca_session_id:old': { run: 'run:r0', at: T0 } } }]])
  const cli = { run: async () => ({ run: { coordinator_handle: null } }) }
  assert.deepEqual(await supervisorSenders(cli, { get: async (k) => store.get(k) ?? null }, 'acme/app', 'run:r1'), [SUPERVISOR])
})
