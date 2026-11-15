// Matriarch's mailbox: what comes into it, and what Matriarch sent from it.
//
// Matriarch sends its mail (CI failures and findings to workers, escalations, draft nudges and
// notices to the supervisor's Run) from a terminal of its own in each project (worker.ts,
// createMailboxes), and that terminal is where answers come back: the supervisor replying to an
// escalation or a nudge, a worker replying to a fix request, and the questions the supervisor asks
// the advisor. Each tick Matriarch reads the mailbox and handles every message it has not handled
// before. Its own record of handled messages is the source of truth, not Orca's unread mark: an
// older Matriarch marked mail read without reading it, and anything else might, so every half
// hour it also reads the recent mail, read or not. Marking read is only a courtesy that keeps the
// unread read each tick small.
//
// A reply is matched to what Matriarch sent by its thread (Orca gives a reply the id of the
// message it answers as `thread_id`). What Matriarch sent before it kept a record is found in the
// Run's own mailbox, where Orca keeps it. A message that is neither a question nor a reply in a
// thread Matriarch started is logged and dropped: the mailbox is no way to hand Matriarch work.
import type { JsonValue } from 'orca/host'
import { repoWide, type Escalation, type PrLedger, type SupervisorNote } from './ledger.ts'
import { GONE_TERMINAL, OrcaRefusal, sendFrom, type Mailbox, type OrcaCli, type SentReceipt } from './orca-cli.ts'
import type { LogEntry } from './protocol.ts'
import { clip, obj, str } from './values.ts'

/** Mail older than this is not handled, and the record of what was handled and sent goes with it. */
export const MAIL_WINDOW_MS = 7 * 24 * 3600_000
/** How often the recent mail is read too, read or not: what else marked read is still handled. */
export const CATCH_UP_MS = 30 * 60_000
/** The recent mail read then: Orca answers the newest first, this many at most. */
export const RECENT_LIMIT = 500
const MAX_SENT = 500
const MAX_OWN = 10
const MAX_SENDERS = 20
/** A reply as kept with its PR (its latest note on the card) and in its activity log. */
export const NOTE_MAX = 2000
export const DETAIL_MAX = 4000

/** One message in a mailbox, as Orca stores it (`check --full`, `inbox --full`). */
export interface MailMessage {
  id: string
  from: string | null
  to: string | null
  subject: string
  body: string
  /** The message it answers (a reply), or the first of its thread. */
  threadId: string | null
  runId: string | null
  /** When Orca stored it; 0 when it did not say. */
  at: number
}

/**
 * The messages in a `check --json` or `inbox --json` reply. Only full records, each with its
 * subject or body: a message whose words did not come is not read, so it is not taken as handled.
 */
export function parseMail(result: unknown): MailMessage[] {
  const r = obj(result)
  const list = Array.isArray(r.messages) ? r.messages : Array.isArray(result) ? result : []
  const out: MailMessage[] = []
  for (const m of list) {
    const o = obj(m)
    const id = str(o.id)
    if (!id || (typeof o.subject !== 'string' && typeof o.body !== 'string')) continue
    const at = Date.parse(str(o.created_at) ?? '')
    out.push({
      id,
      from: str(o.from_handle) ?? str(o.from),
      to: str(o.to_handle) ?? str(o.to),
      subject: typeof o.subject === 'string' ? o.subject : '',
      body: typeof o.body === 'string' ? o.body : '',
      threadId: str(o.thread_id),
      runId: str(o.run_id),
      at: Number.isFinite(at) ? at : 0
    })
  }
  return out
}

/** A message Matriarch sent, kept so a reply in its thread is known to be about it. */
export interface SentMail {
  id: string
  at: number
  /** Where it went: `run:<id>` (the supervisor) or `dispatch:<id>` (a worker). */
  to: string
  subject: string
  /** What it was: the action's kind (escalate, send-ci-failure, ...), or settings, limits, issue, stop, advice. */
  kind: string
  /** The PR it was about. */
  number?: number
  /** The escalation it raised (the ledger's key), so a reply can answer it. */
  key?: string
  /**
   * Its text, cut short: kept only for mail found in Orca after the fact (sent before Matriarch
   * kept this record), to tell which escalation it raised.
   */
  text?: string
}

export interface MailState {
  v: 1
  /** Messages handled, by id, with when Orca stored each: pruned with the window. */
  handled: Record<string, number>
  sent: SentMail[]
  /** The mailboxes Matriarch sent from here, current and past: its own mail is never a reply. */
  own: string[]
  /** Who the supervisor of a Run was seen to be: the sender of its replies in threads Matriarch started there. */
  senders: Record<string, { run: string; at: number }>
  /** When the recent mail was last read, read or not. */
  caughtUpAt: number | null
  /** Questions read for the advisor that it has not stored yet (takenQuestions). */
  pending: MailMessage[]
}

export const mailKey = (repo: string): string => `mail:${repo}`

export function emptyMailState(): MailState {
  return { v: 1, handled: {}, sent: [], own: [], senders: {}, caughtUpAt: null, pending: [] }
}

export function loadMailState(raw: unknown): MailState {
  const r = obj(raw)
  const handled: Record<string, number> = {}
  for (const [id, at] of Object.entries(obj(r.handled))) if (typeof at === 'number') handled[id] = at
  const senders: MailState['senders'] = {}
  for (const [who, v] of Object.entries(obj(r.senders))) {
    const s = obj(v)
    if (typeof s.run === 'string' && typeof s.at === 'number') senders[who] = { run: s.run, at: s.at }
  }
  return {
    v: 1,
    handled,
    sent: (Array.isArray(r.sent) ? r.sent : []).filter((s): s is SentMail => typeof obj(s).id === 'string' && typeof obj(s).to === 'string' && typeof obj(s).at === 'number'),
    own: (Array.isArray(r.own) ? r.own : []).filter((h): h is string => typeof h === 'string'),
    senders,
    caughtUpAt: typeof r.caughtUpAt === 'number' ? r.caughtUpAt : null,
    pending: (Array.isArray(r.pending) ? r.pending : []).filter((m): m is MailMessage => typeof obj(m).id === 'string' && typeof obj(m).subject === 'string' && typeof obj(m).at === 'number')
  }
}

/** Drops what is older than the window, and caps the rest. */
export function pruneMail(state: MailState, now: number): MailState {
  const cutoff = now - MAIL_WINDOW_MS
  const handled = Object.fromEntries(Object.entries(state.handled).filter(([, at]) => at >= cutoff))
  const sent = state.sent.filter((s) => s.at >= cutoff).slice(-MAX_SENT)
  const senders = Object.fromEntries(Object.entries(state.senders).sort(([, a], [, b]) => a.at - b.at).slice(-MAX_SENDERS))
  const pending = state.pending.filter((m) => m.at === 0 || m.at >= cutoff).slice(-MAX_PENDING)
  return { ...state, handled, sent, own: state.own.slice(-MAX_OWN), senders, pending }
}

/** The store, as much of it as the mail record needs. */
export interface MailStore {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
}

/**
 * Keeps what Matriarch just sent, so a reply in its thread is known. A message Orca gave no id
 * cannot be matched and is not kept. Read and written on its own: a send in another part of
 * the tick (or a Settings save) and this record race only as far as a lost entry, which the
 * thread is then looked up for in Orca (findSent).
 */
export async function recordSent(store: MailStore, repo: string, receipt: SentReceipt, sent: Omit<SentMail, 'id'>): Promise<void> {
  if (!receipt.id) return
  const state = loadMailState(await store.get(mailKey(repo)))
  const own = receipt.from && !state.own.includes(receipt.from) ? [...state.own, receipt.from] : state.own
  const next = pruneMail({ ...state, own, sent: [...state.sent.filter((s) => s.id !== receipt.id), { ...sent, id: receipt.id }] }, sent.at)
  await store.set(mailKey(repo), next as unknown as JsonValue)
}

/**
 * Sends from the project's mailbox and keeps the record: every message to an agent goes this way
 * (the executor's go through the engine, which records them from the outcome).
 */
export async function sendRecorded(
  cli: OrcaCli,
  mailbox: Mailbox | null,
  store: MailStore,
  repo: string,
  message: { to: string; subject: string; body: string },
  about: { kind: string; at: number; number?: number }
): Promise<SentReceipt> {
  const receipt = await sendFrom(cli, mailbox, message)
  await recordSent(store, repo, receipt, { ...about, to: message.to, subject: message.subject }).catch(() => {})
  return receipt
}

/** "Re: Re: x" → "x". */
export const stripReplies = (subject: string): string => subject.replace(/^(?:\s*(?:re|aw|fwd?)\s*:\s*)+/i, '').trim()

/** A question for the advisor: its subject starts "Advice:". A reply to an answer ("Re: Advice: …") is not one. */
export const ADVICE_SUBJECT = /^\s*advice\s*:\s*/i

/**
 * The PR a subject Matriarch wrote is about, by the patterns its messages use (messages.ts,
 * executor.ts); null for one that is about no PR (settings, limits, an issue). Orca prefixes a
 * message it turned down ("Rejected escalation: …"), so the patterns are not anchored.
 */
export function prOfSubject(subject: string): number | null {
  const s = stripReplies(subject)
  const patterns = [
    /rebase #(\d+) onto /,
    /needs a decision on \S+ #(\d+)\b/,
    /\S+ #(\d+) is still a draft/,
    /(?:^|\s)#(\d+) needs a follow-up/,
    /CI failed on #(\d+)\b/,
    /(?:^|\s)#(\d+) conflicts with /,
    /(?:^|\s)#(\d+) is behind /,
    /Review feedback on #(\d+)\b/
  ]
  for (const p of patterns) {
    const m = s.match(p)
    if (m) return Number(m[1])
  }
  return null
}

/** What a message Matriarch sent was, from its subject: for one found in Orca after the fact. */
function kindOfSubject(subject: string): string {
  const s = stripReplies(subject)
  if (/needs a decision on|^(?:rejected )?escalation:/i.test(s)) return 'escalate'
  if (/is still a draft/.test(s)) return 'draft'
  if (/^Advice:/i.test(s)) return 'advice'
  if (/^New objective:/i.test(s)) return 'issue'
  if (/^Worker (settings|limits) changed/i.test(s)) return 'settings'
  if (/started over a limit/i.test(s)) return 'stop'
  return prOfSubject(s) !== null ? 'message' : 'notice'
}

/** A message Matriarch sent before it kept a record, as Orca keeps it in the mailbox it went to. */
export function sentFromOriginal(original: MailMessage): SentMail {
  const number = prOfSubject(original.subject)
  return {
    id: original.id,
    at: original.at,
    to: original.to ?? '',
    subject: original.subject,
    kind: kindOfSubject(original.subject),
    ...(number !== null ? { number } : {}),
    text: original.body.slice(0, 1000)
  }
}

/** Mail not handled yet, inside the window, each once, oldest first. */
export function newMail(state: MailState, batches: readonly MailMessage[], now: number): MailMessage[] {
  const cutoff = now - MAIL_WINDOW_MS
  const seen = new Set<string>()
  const out: MailMessage[] = []
  for (const m of batches) {
    if (seen.has(m.id) || state.handled[m.id] !== undefined || (m.at > 0 && m.at < cutoff)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Who wrote a reply, as far as the address Orca stored tells (an address match, SECURITY.md). */
export type Replier = 'supervisor' | 'worker' | 'other'

/** A reply in a thread Matriarch started, with what it answers and who wrote it. */
export interface MailReply {
  message: MailMessage
  sent: SentMail
  /**
   * The supervisor only from an address known to be its (or the first chat of its Run to reply,
   * learnSender); a worker only from one of its Run's workers' addresses; anyone else is other.
   */
  who: Replier
}

/** Mail from Orca, sorted: questions for the advisor, replies in a known thread, threads to look up, and the rest. */
export interface RoutedMail {
  questions: MailMessage[]
  threaded: { message: MailMessage; sent: SentMail }[]
  /** Replies in a thread this record does not know: looked up in Orca (the supervisor Run's mailbox). */
  unknown: MailMessage[]
  /** Neither: logged and dropped, or (a reply naming a PR, from someone known) shown in its log. */
  other: MailMessage[]
}

/** Sorts new mail. `address` is the mailbox being read; mail from any of Matriarch's own mailboxes is not anyone's reply. */
export function routeMail(state: MailState, messages: readonly MailMessage[], address: string): RoutedMail {
  const routed: RoutedMail = { questions: [], threaded: [], unknown: [], other: [] }
  for (const m of messages) {
    if (m.from && (m.from === address || state.own.includes(m.from))) continue
    if (ADVICE_SUBJECT.test(m.subject)) {
      routed.questions.push(m)
      continue
    }
    const sent = m.threadId ? state.sent.find((s) => s.id === m.threadId) : undefined
    if (sent) routed.threaded.push({ message: m, sent })
    else if (m.threadId) routed.unknown.push(m)
    else routed.other.push(m)
  }
  return routed
}

/** The Run a message is filed under, as Orca names it: none for mail outside a Run. */
export const runOf = (m: MailMessage): string | null => (m.runId && m.runId !== 'run_unbound' ? `run:${m.runId}` : null)

const SESSION = 'orca_session_id:'

/**
 * Who the agents of a Run are, as addresses Orca stores for a sender. Orca does not authenticate
 * senders and lets any caller reply to any message (Orca 1.4.259: `orchestration reply --id`
 * works for any id, and the reply is filed under the original's Run), so a reply is the
 * supervisor's only by its address.
 */
export interface MailIdentities {
  /** The addresses known to be a Run's supervisor: its chat's launch session, its terminal, the handle the Run is bound to. */
  supervisorsOf(run: string): Promise<readonly string[]>
  /** The addresses of a Run's workers (their terminals, `dispatch:<id>`): never its supervisor. */
  workersOf(run: string): ReadonlySet<string>
}

/** The supervisor addresses known for a Run: given, and learned from its replies before. */
async function knownSupervisors(state: MailState, ids: MailIdentities, run: string): Promise<Set<string>> {
  return new Set([...(await ids.supervisorsOf(run).catch(() => [])), ...learnedSenders(state, run)])
}

/**
 * Who wrote a reply in a thread Matriarch started. To the supervisor's Run: the supervisor when
 * its address is one known to be the supervisor's; or, while none is known for that Run, a chat
 * session's address that is none of its workers', which is then learned (the first wins); a
 * worker when it is one of its workers' addresses; anyone else otherwise. To a worker's Dispatch:
 * the worker when it is one of that Run's workers' addresses. `stranger` marks a second chat
 * replying once the supervisor is known, for the board.
 */
export async function whoReplied(state: MailState, ids: MailIdentities, message: MailMessage, sent: SentMail): Promise<{ who: Replier; learn: boolean; stranger: boolean }> {
  const from = message.from
  const run = runOf(message)
  const none = { who: 'other' as const, learn: false, stranger: false }
  if (!from || !run) return none
  const workers = ids.workersOf(run)
  if (sent.to.startsWith('run:')) {
    // Filed under another Run than the one Matriarch wrote to: not an answer from this one's supervisor.
    if (run !== sent.to) return none
    const known = await knownSupervisors(state, ids, run)
    if (known.has(from)) return { who: 'supervisor', learn: false, stranger: false }
    if (workers.has(from)) return { who: 'worker', learn: false, stranger: false }
    if (from.startsWith(SESSION)) return known.size === 0 ? { who: 'supervisor', learn: true, stranger: false } : { who: 'other', learn: false, stranger: true }
    return none
  }
  return workers.has(from) ? { who: 'worker', learn: false, stranger: false } : none
}

/**
 * Remembers a chat session as the supervisor of a Run, once: only when whoReplied said so, and
 * only while no supervisor address is known for that Run (the first wins).
 */
export function learnSender(state: MailState, reply: MailReply): MailState {
  const { message, sent } = reply
  if (reply.who !== 'supervisor' || !message.from || !sent.to.startsWith('run:')) return state
  if (learnedSenders(state, sent.to).some((who) => who !== message.from)) return state
  const known = state.senders[message.from]
  if (known && known.run === sent.to) return state
  return { ...state, senders: { ...state.senders, [message.from]: { run: sent.to, at: message.at } } }
}

/** Who sends as the supervisor of a Run, as its replies showed. */
export function learnedSenders(state: MailState, run: string): string[] {
  return Object.entries(state.senders).filter(([, s]) => s.run === run).map(([who]) => who)
}

/** One line of a reply, for a log line or a card: its first lines, spaces folded. */
export const replyLine = (body: string, n: number): string => clip(body.replace(/\s+/g, ' ').trim() || '(no text)', n)

/** A draft nudge is a routine question, not an escalation: a reply to it answers nothing. */
const ROUTINE = (key: string): boolean => key.startsWith('draft:')

/**
 * The escalation a reply answers: the key Matriarch kept when it sent it, or, for mail found in
 * Orca after the fact, the supervisor escalation whose reason that mail carried, raised when it
 * went. Only the supervisor's reply answers one, and only a current one: not one already sent on
 * to the person, nor one newer than the reply. `shared` holds the project's repository-wide
 * escalations (ledger.ts repoWide), answered once for every PR.
 */
export function answeredEscalation(ledger: PrLedger, reply: MailReply, shared: Readonly<Record<string, Escalation>> = {}): string | null {
  if (reply.who !== 'supervisor' || reply.sent.kind === 'draft') return null
  const { sent, message } = reply
  const all = { ...ledger.escalations, ...shared }
  let key = sent.key ?? null
  if (!key && sent.text && sent.kind === 'escalate') {
    const text = sent.text
    key =
      Object.entries(all).find(
        ([k, e]) => k.endsWith(':supervisor') && e.to === 'supervisor' && text.includes(e.reason.slice(0, 120)) && Math.abs(e.at - sent.at) < 10 * 60_000
      )?.[0] ?? null
  }
  if (!key || !key.endsWith(':supervisor') || ROUTINE(key)) return null
  const esc = all[key]
  const human = all[key.replace(/:supervisor$/, ':human')]
  if (!esc || esc.to !== 'supervisor' || human) return null
  if (message.at > 0 && message.at < esc.at) return null
  return key
}

const MAX_NOTES = 5

/**
 * A reply's mark on its PR: its note (the card shows the latest the supervisor or its worker
 * wrote), and an escalation it answers marked answered, on the PR's ledger or, for one about the
 * whole repository, in `shared`. The first answer starts the one more window the supervisor gets
 * (plan.ts escalate); a later one brings its words up to date, unless it was written before the
 * words already kept (a catch-up read can bring an older reply late). Pure.
 */
export function applyReply(
  ledger: PrLedger,
  reply: MailReply,
  now: number,
  shared: Readonly<Record<string, Escalation>> = {}
): { ledger: PrLedger; shared: Record<string, Escalation>; entry: LogEntry; answered: string | null } {
  const { message, sent, who } = reply
  const at = message.at || now
  const text = clip(message.body.trim(), NOTE_MAX)
  const known = who === 'supervisor' || who === 'worker'
  const notes = known
    ? [...(ledger.notes ?? []).filter((n) => !(n.at === at && n.text === text)), { at, from: who, subject: sent.subject, text } satisfies SupervisorNote].sort((a, b) => a.at - b.at).slice(-MAX_NOTES)
    : ledger.notes
  const answered = answeredEscalation(ledger, reply, shared)
  const escalations = { ...ledger.escalations }
  const nextShared = { ...shared }
  if (answered) {
    const into = repoWide(answered) ? nextShared : escalations
    const esc = into[answered]
    const prior = esc.answered
    into[answered] = {
      ...esc,
      answered: !prior
        ? { at, text, textAt: at, count: 1 }
        : at >= (prior.textAt ?? prior.at)
          ? { ...prior, text, textAt: at, count: (prior.count ?? 1) + 1 }
          : { ...prior, at: Math.min(prior.at, at), count: (prior.count ?? 1) + 1 }
    }
  }
  const by = who === 'other' ? `A reply from ${message.from ?? 'an unknown sender'}` : `The ${who} replied`
  const entry: LogEntry = {
    at,
    kind: 'reply',
    text: `${answered ? `The ${who} answered the escalation` : by}: ${replyLine(message.body, 240)}`,
    subject: sent.subject,
    ...(known ? { from: who } : {}),
    ...(message.body.trim().length > 240 ? { detail: clip(message.body.trim(), DETAIL_MAX) } : {})
  }
  return { ledger: { ...ledger, ...(notes ? { notes } : {}), escalations }, shared: nextShared, entry, answered }
}

/** Reads a mailbox for the engine; each throws Orca's refusal (a mailbox that is gone, say). */
export interface MailReader {
  /** Its unread mail, without marking it read. */
  unread(address: string): Promise<MailMessage[]>
  /** Its newest RECENT_LIMIT messages, read or not. */
  recent(address: string): Promise<MailMessage[]>
  /** Marks its oldest unread batch read, answering it. */
  markRead(address: string): Promise<MailMessage[]>
  /** The mail in a Run's mailbox (`run:<id>`): what Matriarch sent its supervisor, among the rest. */
  runMail(run: string): Promise<MailMessage[]>
}

/**
 * Orca 1.4.257: `check --peek` answers every unread message of a terminal mailbox and marks none;
 * `check` marks the oldest unread batch; `inbox --terminal --limit n` answers the newest n, read
 * or not, and nothing for a handle that is gone (`check` refuses one). None pages or filters by
 * time: the catch-up read reaches back RECENT_LIMIT messages. A Run's mailbox is the party
 * `run:<id>` (Orca resolves it like a terminal's); only should Orca refuse that is the newest
 * mail across Orca read instead, and what went to that Run kept.
 */
export function createMailReader(cli: OrcaCli): MailReader {
  const inbox = async (party: string | null): Promise<MailMessage[]> =>
    parseMail(await cli.run(['orchestration', 'inbox', ...(party ? ['--terminal', party] : []), '--limit', String(RECENT_LIMIT), '--full']))
  return {
    unread: async (address) => parseMail(await cli.run(['orchestration', 'check', '--terminal', address, '--peek', '--full'])),
    recent: (address) => inbox(address),
    markRead: async (address) => parseMail(await cli.run(['orchestration', 'check', '--terminal', address, '--full'])),
    runMail: async (run) => {
      try {
        return await inbox(run)
      } catch {
        return (await inbox(null)).filter((m) => m.to === run)
      }
    }
  }
}

/** Orca says the mailbox is gone. */
export const mailboxGone = (error: unknown): boolean => error instanceof OrcaRefusal && GONE_TERMINAL.has(error.code)

export interface TakeMailInput {
  reader: MailReader
  /** The project's mailbox. */
  address: string
  state: MailState
  /** The supervisor's Run (`run:<id>`): the only Run whose mailbox is looked up for threads Matriarch started before it kept a record. */
  supervisor: string | null
  ids: MailIdentities
  now: number
  log(message: string): void
}

export interface TakenMail {
  /**
   * The state to save once what was taken is acted on: each message recorded as handled, and
   * each question kept as pending until the advisor has stored it (takenQuestions).
   */
  state: MailState
  replies: MailReply[]
  /** Replies about a PR whose thread is not known, from the supervisor or a worker: shown in its log, nothing more. */
  loose: { message: MailMessage; number: number; who: 'supervisor' | 'worker' }[]
  /** Chat sessions that replied as if the supervisor once another address was known to be it. */
  strangers: string[]
  /** Orca said the mailbox is gone: nothing was read. */
  gone: boolean
}

const MAX_PENDING = 50

/**
 * The advisor stored these questions: they are no longer pending. Until then a question stays in
 * the mail state, so a reload or a failure between reading it and the advisor's save loses nothing
 * (the advisor keeps the ids it took, so one handed over twice is not taken twice).
 */
export function takenQuestions(state: MailState, ids: readonly string[]): MailState {
  return ids.length ? { ...state, pending: state.pending.filter((q) => !ids.includes(q.id)) } : state
}

/**
 * One tick's mail: the unread, and every half hour the recent too; what is new sorted, threads
 * Matriarch started before it kept a record found in the supervisor Run's mailbox, who wrote
 * each reply told by its address (the supervisor learned from its first reply when none is
 * known), and then the unread marked read. Every message taken is recorded as handled, and every
 * question added to the pending ones, in the state answered; the caller saves it after acting on
 * what it was given.
 */
export async function takeMail(input: TakeMailInput): Promise<TakenMail> {
  const { reader, address, now, log, ids } = input
  let state = input.state
  const out: TakenMail = { state, replies: [], loose: [], strangers: [], gone: false }
  let unread: MailMessage[]
  try {
    unread = await reader.unread(address)
  } catch (error) {
    if (mailboxGone(error)) return { ...out, gone: true }
    log(`could not read Matriarch's mailbox: ${(error as Error).message}`)
    return out
  }
  let recent: MailMessage[] = []
  if (state.caughtUpAt === null || now - state.caughtUpAt >= CATCH_UP_MS) {
    try {
      recent = await reader.recent(address)
      state = { ...state, caughtUpAt: now }
    } catch (error) {
      log(`could not read the recent mail in Matriarch's mailbox: ${(error as Error).message}`)
    }
  }

  let runMail: MailMessage[] | null | undefined
  const lookUp = async (): Promise<MailMessage[] | null> => {
    if (runMail === undefined) runMail = input.supervisor ? await reader.runMail(input.supervisor).catch(() => null) : null
    return runMail
  }
  const take = async (batch: readonly MailMessage[]) => {
    const fresh = newMail(state, batch, now)
    if (fresh.length === 0) return
    const routed = routeMail(state, fresh, address)
    const threaded = [...routed.threaded]
    for (const m of routed.unknown) {
      // Sent before Matriarch kept a record: Orca still has it, in the supervisor Run's mailbox.
      // Only that Run is looked up, and only for a reply Orca filed under it.
      const found = input.supervisor && runOf(m) === input.supervisor
        ? (await lookUp())?.find((o) => o.id === m.threadId && o.from !== null && (o.from === address || state.own.includes(o.from)))
        : undefined
      if (!found) {
        routed.other.push(m)
        continue
      }
      const sent = state.sent.find((s) => s.id === found.id) ?? sentFromOriginal(found)
      if (!state.sent.some((s) => s.id === sent.id)) state = { ...state, sent: [...state.sent, sent] }
      threaded.push({ message: m, sent })
    }
    for (const t of threaded) {
      const told = await whoReplied(state, ids, t.message, t.sent)
      const reply: MailReply = { ...t, who: told.who }
      if (told.learn) state = learnSender(state, reply)
      if (told.stranger && t.message.from && !out.strangers.includes(t.message.from)) out.strangers.push(t.message.from)
      out.replies.push(reply)
    }
    for (const m of routed.other) {
      // A reply whose thread Orca no longer has, about a PR its subject names: shown in its log,
      // but only from the supervisor or a worker; anything else is dropped.
      const number = /^\s*re\s*:/i.test(m.subject) ? prOfSubject(m.subject) : null
      const run = input.supervisor
      const who =
        number === null || !m.from || !run ? null
        : (await knownSupervisors(state, ids, run)).has(m.from) ? 'supervisor'
        : ids.workersOf(run).has(m.from) ? 'worker'
        : null
      if (number !== null && who) out.loose.push({ message: m, number, who })
      else log(`a message in Matriarch's mailbox is no question and no reply to its mail from the supervisor or a worker, so it is dropped: "${clip(m.subject, 80)}" from ${m.from ?? 'an unknown sender'}`)
    }
    const pending = [...state.pending, ...routed.questions.filter((q) => !state.pending.some((p) => p.id === q.id))]
    const handled = { ...state.handled }
    for (const m of fresh) handled[m.id] = m.at || now
    state = { ...state, handled, pending }
  }

  await take([...unread, ...recent])
  // A courtesy: Orca's unread for this mailbox stays empty, so each tick's read stays small. What
  // arrived since the look is in the batch it marks, and is taken too.
  if (unread.length > 0) {
    try {
      await take(await reader.markRead(address))
    } catch (error) {
      if (!mailboxGone(error)) log(`could not mark Matriarch's mail read: ${(error as Error).message}`)
    }
  }
  return { ...out, state: pruneMail(state, now) }
}
