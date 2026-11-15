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
import type { PrLedger, SupervisorNote } from './ledger.ts'
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
}

export const mailKey = (repo: string): string => `mail:${repo}`

export function emptyMailState(): MailState {
  return { v: 1, handled: {}, sent: [], own: [], senders: {}, caughtUpAt: null }
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
    caughtUpAt: typeof r.caughtUpAt === 'number' ? r.caughtUpAt : null
  }
}

/** Drops what is older than the window, and caps the rest. */
export function pruneMail(state: MailState, now: number): MailState {
  const cutoff = now - MAIL_WINDOW_MS
  const handled = Object.fromEntries(Object.entries(state.handled).filter(([, at]) => at >= cutoff))
  const sent = state.sent.filter((s) => s.at >= cutoff).slice(-MAX_SENT)
  const senders = Object.fromEntries(Object.entries(state.senders).sort(([, a], [, b]) => a.at - b.at).slice(-MAX_SENDERS))
  return { ...state, handled, sent, own: state.own.slice(-MAX_OWN), senders }
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

/** A reply in a thread Matriarch started, with what it answers. */
export interface MailReply {
  message: MailMessage
  sent: SentMail
  /** Who replied: the supervisor for mail to its Run, a worker for mail to its Dispatch. */
  who: 'supervisor' | 'worker'
}

/** Mail from Orca, sorted: questions for the advisor, replies, what is Matriarch's own, and the rest. */
export interface RoutedMail {
  questions: MailMessage[]
  replies: MailReply[]
  /** Replies in a thread this record does not know: looked up in Orca (findSent). */
  unknown: MailMessage[]
  /** Neither: logged and dropped. */
  other: MailMessage[]
}

const whoAnswers = (sent: SentMail): 'supervisor' | 'worker' => (sent.to.startsWith('dispatch:') ? 'worker' : 'supervisor')

/** Sorts new mail. `address` is the mailbox being read; mail from any of Matriarch's own mailboxes is not anyone's reply. */
export function routeMail(state: MailState, messages: readonly MailMessage[], address: string): RoutedMail {
  const routed: RoutedMail = { questions: [], replies: [], unknown: [], other: [] }
  for (const m of messages) {
    if (m.from && (m.from === address || state.own.includes(m.from))) continue
    if (ADVICE_SUBJECT.test(m.subject)) {
      routed.questions.push(m)
      continue
    }
    const sent = m.threadId ? state.sent.find((s) => s.id === m.threadId) : undefined
    if (sent) routed.replies.push({ message: m, sent, who: whoAnswers(sent) })
    else if (m.threadId) routed.unknown.push(m)
    else routed.other.push(m)
  }
  return routed
}

/**
 * A reply in a thread Matriarch started with a supervisor's Run tells who that supervisor is: the
 * address Orca stored as its sender (a chat's `orca_session_id:<id>`, a terminal's handle). Only
 * mail Matriarch sent to `run:<id>` and a reply Orca filed under that Run count. This is an
 * address match, as every sender check is (SECURITY.md).
 */
export function learnSender(state: MailState, reply: MailReply): MailState {
  const { message, sent } = reply
  if (!sent.to.startsWith('run:') || !message.from) return state
  if (message.runId && `run:${message.runId}` !== sent.to) return state
  const known = state.senders[message.from]
  if (known && known.run === sent.to && known.at >= message.at) return state
  return { ...state, senders: { ...state.senders, [message.from]: { run: sent.to, at: Math.max(message.at, known?.at ?? 0) } } }
}

/** Who sends as the supervisor of a Run, as its replies showed. */
export function learnedSenders(state: MailState, run: string): string[] {
  return Object.entries(state.senders).filter(([, s]) => s.run === run).map(([who]) => who)
}

/** One line of a reply, for a log line or a card: its first lines, spaces folded. */
export const replyLine = (body: string, n: number): string => clip(body.replace(/\s+/g, ' ').trim() || '(no text)', n)

/**
 * The escalation a reply answers: the key Matriarch kept when it sent it, or, for mail found in
 * Orca after the fact, the supervisor escalation whose reason that mail carried, raised when it
 * went. Null when none is current: one already sent on to the person, or newer than the reply.
 */
export function answeredEscalation(ledger: PrLedger, reply: MailReply): string | null {
  if (reply.who !== 'supervisor') return null
  const { sent, message } = reply
  let key = sent.key ?? null
  if (!key && sent.text && sent.kind === 'escalate') {
    const text = sent.text
    key =
      Object.entries(ledger.escalations).find(
        ([k, e]) => k.endsWith(':supervisor') && e.to === 'supervisor' && text.includes(e.reason.slice(0, 120)) && Math.abs(e.at - sent.at) < 10 * 60_000
      )?.[0] ?? null
  }
  if (!key || !key.endsWith(':supervisor')) return null
  const esc = ledger.escalations[key]
  const human = ledger.escalations[key.replace(/:supervisor$/, ':human')]
  if (!esc || esc.to !== 'supervisor' || human) return null
  if (message.at > 0 && message.at < esc.at) return null
  return key
}

const MAX_NOTES = 5

/**
 * A reply's mark on its PR: its note (the card shows the latest the supervisor wrote), and an
 * escalation it answers marked answered. The first answer starts the one more window the
 * supervisor gets (plan.ts escalate); later ones only bring its words up to date. Pure.
 */
export function applyReply(ledger: PrLedger, reply: MailReply, now: number): { ledger: PrLedger; entry: LogEntry; answered: string | null } {
  const { message, sent, who } = reply
  const at = message.at || now
  const note: SupervisorNote = { at, from: who, subject: sent.subject, text: clip(message.body.trim(), NOTE_MAX) }
  const notes = [...(ledger.notes ?? []).filter((n) => !(n.at === note.at && n.text === note.text)), note].sort((a, b) => a.at - b.at).slice(-MAX_NOTES)
  const answered = answeredEscalation(ledger, reply)
  const escalations = { ...ledger.escalations }
  if (answered) {
    const esc = escalations[answered]
    escalations[answered] = { ...esc, answered: esc.answered ? { ...esc.answered, text: note.text, count: (esc.answered.count ?? 1) + 1 } : { at, text: note.text, count: 1 } }
  }
  const entry: LogEntry = {
    at,
    kind: 'reply',
    text: `${answered ? `The ${who} answered the escalation` : `The ${who} replied`}: ${replyLine(message.body, 240)}`,
    subject: sent.subject,
    from: who,
    ...(message.body.trim().length > 240 ? { detail: clip(message.body.trim(), DETAIL_MAX) } : {})
  }
  return { ledger: { ...ledger, notes, escalations }, entry, answered }
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
 * `run:<id>` (Orca resolves it like a terminal's); should that come back empty or be refused,
 * the newest mail across Orca is read instead, and what went to that Run kept.
 */
export function createMailReader(cli: OrcaCli): MailReader {
  const inbox = async (party: string | null): Promise<MailMessage[]> =>
    parseMail(await cli.run(['orchestration', 'inbox', ...(party ? ['--terminal', party] : []), '--limit', String(RECENT_LIMIT), '--full']))
  return {
    unread: async (address) => parseMail(await cli.run(['orchestration', 'check', '--terminal', address, '--peek', '--full'])),
    recent: (address) => inbox(address),
    markRead: async (address) => parseMail(await cli.run(['orchestration', 'check', '--terminal', address, '--full'])),
    runMail: async (run) => {
      const own = await inbox(run).catch(() => [])
      return own.length > 0 ? own : (await inbox(null)).filter((m) => m.to === run)
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
  /** The supervisor's Run (`run:<id>`), to look up threads Matriarch started there before it kept a record. */
  supervisor: string | null
  now: number
  log(message: string): void
}

export interface TakenMail {
  state: MailState
  questions: MailMessage[]
  replies: MailReply[]
  /** Replies about a PR whose thread is not known: shown in its log, nothing more. */
  loose: { message: MailMessage; number: number }[]
  /** Orca said the mailbox is gone: nothing was read. */
  gone: boolean
}

/**
 * One tick's mail: the unread, and every half hour the recent too; what is new sorted, threads
 * Matriarch started before it kept a record found in the Run's mailbox, the supervisor's address
 * learned from its replies, and then the unread marked read. Every message taken is recorded as
 * handled in the state answered; the caller saves it after acting on what it was given.
 */
export async function takeMail(input: TakeMailInput): Promise<TakenMail> {
  const { reader, address, now, log } = input
  let state = input.state
  const out: TakenMail = { state, questions: [], replies: [], loose: [], gone: false }
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

  const runMail = new Map<string, MailMessage[] | null>()
  const lookUp = async (run: string): Promise<MailMessage[] | null> => {
    if (!runMail.has(run)) runMail.set(run, await reader.runMail(run).catch(() => null))
    return runMail.get(run) ?? null
  }
  const take = async (batch: readonly MailMessage[]) => {
    const fresh = newMail(state, batch, now)
    if (fresh.length === 0) return
    const routed = routeMail(state, fresh, address)
    const replies = [...routed.replies]
    for (const m of routed.unknown) {
      // Sent before Matriarch kept a record: Orca still has it, in the mailbox it went to.
      const run = m.runId ? `run:${m.runId}` : input.supervisor
      const found = run ? (await lookUp(run))?.find((o) => o.id === m.threadId && o.from !== null && (o.from === address || state.own.includes(o.from))) : undefined
      if (found) {
        const sent = sentFromOriginal(found)
        state = { ...state, sent: [...state.sent, sent] }
        replies.push({ message: m, sent, who: sent.to.startsWith('dispatch:') ? 'worker' : 'supervisor' })
      } else routed.other.push(m)
    }
    for (const r of replies) state = learnSender(state, r)
    for (const m of routed.other) {
      // A reply whose thread is gone from Orca, about a PR its subject names: its log shows it.
      const number = /^\s*re\s*:/i.test(m.subject) ? prOfSubject(m.subject) : null
      if (number !== null) out.loose.push({ message: m, number })
      else log(`a message in Matriarch's mailbox is no question and no reply to its mail, so it is dropped: "${clip(m.subject, 80)}" from ${m.from ?? 'an unknown sender'}`)
    }
    out.questions.push(...routed.questions)
    out.replies.push(...replies)
    const handled = { ...state.handled }
    for (const m of fresh) handled[m.id] = m.at || now
    state = { ...state, handled }
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
