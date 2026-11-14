// The advisor: a role above the supervisor, on its own agent and model, that the supervisor asks
// for a second opinion. The supervisor mails Matriarch's mailbox (Matriarch's own terminal in the
// project) a message whose subject starts "Advice:". Each tick Matriarch reads the mailbox, queues
// the questions and answers them one at a time: a throwaway worktree at the default branch, the
// advisor started there read-only, locked down by its own agent exactly like a reviewer, and the
// answer it writes mailed back to the supervisor. The worktree goes once it answers or gives up.
// Like automatic reviews it starts only with autopilot on; in dry run questions wait, and so do
// answers. What only tells the supervisor how the advisor is set up (that there is one, where to
// ask, that it was turned off) goes whatever autopilot says, as the person's own Settings change
// does. Only a supervisor Matriarch can recognise as the sender is told about it or answered.
// Everything lives in plugin storage, so a restart picks a question up where it was.
import type { JsonValue } from 'orca/host'
import { advisorUsable, type AdvisorSpec, type MatriarchConfig } from './config.ts'
import {
  AGENT_QUIT, blockingReason, createdId, createdPath, hashText, launchLocked,
  REVIEW_BRANCH_PREFIX, REVIEWER_TIMEOUT_MS, unlockedResume, type CrewDeps
} from './crew.ts'
import { forgeTerms, type ForgeKind } from './forge.ts'
import type { Guard } from './guard.ts'
import { LOCK_LABEL, type LockMode } from './lockdown.ts'
import { OrcaRefusal, sendMessage } from './orca-cli.ts'
import type { AdvisorView } from './protocol.ts'
import { advisorMessage, advisorName } from './supervisor.ts'

/** The longest one question may take, waiting on a person or not: then its slot is freed. */
export const ADVICE_MAX_MS = 2 * 3600_000
/** Questions that may wait behind the one being answered; more are turned away. */
export const MAX_QUEUED = 10
const MAX_SEEN = 200
const MAX_OUTBOX = 20
/** The context sent with a question is cut to this, to keep the advisor's launch prompt in bounds. */
export const MAX_CONTEXT = 20_000
const MAX_ANSWER = 30_000

/** The answer goes in the verdict folder, the one place a locked-down reviewer may write. */
export const adviceDir = (id: string): string => `.matriarch/review/advice-${id}`
export const answerPath = (id: string): string => `${adviceDir(id)}/answer.json`
const stateKey = (repo: string): string => `advice:${repo}`
/** Projects with a question being answered, so the read-only guard comes back after a restart. */
const ACTIVE = 'advice:active'

/** Orca's answer for a terminal that is gone: a mailbox like that is made again. */
export const GONE_TERMINAL = new Set(['terminal_handle_stale', 'terminal_not_found'])

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One message in Matriarch's mailbox. */
export interface MailItem {
  id: string
  from: string | null
  subject: string
  body: string
  /** The record carried its subject or body: what it asks was read. */
  complete: boolean
}

/** The messages in `orca orchestration check --json`: the concise view, or the full record. */
export function parseMail(result: unknown): MailItem[] {
  const r = obj(result)
  const list = Array.isArray(r.messages) ? r.messages : Array.isArray(result) ? result : []
  const items: MailItem[] = []
  for (const m of list) {
    const o = obj(m)
    const id = str(o.id)
    if (!id) continue
    items.push({
      id,
      from: str(o.from) ?? str(o.from_handle),
      subject: typeof o.subject === 'string' ? o.subject : '',
      body: typeof o.body === 'string' ? o.body : '',
      complete: typeof o.subject === 'string' || typeof o.body === 'string'
    })
  }
  return items
}

export interface AdviceQuestion {
  /** The mailbox message it came in. */
  id: string
  question: string
  context: string
  from: string | null
  at: number
}

/** A question's subject: "Advice: …". A reply to an answer ("Re: Advice: …") is not a question. */
const ADVICE = /^\s*advice\s*:\s*/i
/** A reply to one of the advisor's answers: read, logged, and not answered again. */
export const ADVICE_REPLY = /^\s*(?:re|aw|fwd?)\s*:\s*(?:(?:re|aw|fwd?)\s*:\s*)*advice\s*:/i

/** The questions among a batch of mail: messages whose subject starts "Advice:". */
export function adviceQuestions(items: readonly MailItem[], at: number): AdviceQuestion[] {
  return items
    .filter((m) => ADVICE.test(m.subject))
    .map((m) => ({ id: m.id, question: m.subject.replace(ADVICE, '').trim() || 'a second opinion', context: m.body.trim().slice(0, MAX_CONTEXT), from: m.from, at }))
}

/** The answer an advisor wrote: `{"answer": "..."}`, also inside a fenced block. Null otherwise. */
export function parseAnswer(text: string): string | null {
  const tries = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? '', text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const t of tries) {
    if (!t.trim()) continue
    try {
      const answer = obj(JSON.parse(t)).answer
      if (typeof answer === 'string' && answer.trim()) return answer.trim().slice(0, MAX_ANSWER)
    } catch {
      // the next form
    }
  }
  return null
}

export interface AdvisorBriefInput {
  repo: string
  base: string
  question: AdviceQuestion
  /** The run's id: names its answer file. */
  id: string
  forge?: ForgeKind
}

export function advisorBrief({ repo, base, question, id, forge }: AdvisorBriefInput): string {
  const dir = adviceDir(id)
  return [
    `You are the advisor for ${repo}. Its supervisor, the agent that plans the work and runs a pod of coding agents on it, wants a second opinion.`,
    `This worktree is a throwaway checkout of ${base}${forge === 'gitlab' ? ` on ${forgeTerms(forge).name}` : ''}. You are read-only here: read the code, docs and git history`,
    'as much as you need (git log, git show, git diff, grep), but change nothing. You cannot commit, push or reach the network.',
    '',
    `The supervisor's question: ${question.question}`,
    '',
    question.context ? `What it told you:\n${question.context}` : 'It gave no more context than the question.',
    '',
    'Answer as a peer it trusts. Say what you would do and why, what it may be missing, the risks, and how sure you are.',
    'Be concrete (files, functions, commands) and keep it short: the supervisor reads it between other work, and the decision stays its own.',
    '',
    `When you are done, write your answer as JSON to ${answerPath(id)} (create the folder first: mkdir -p ${dir}):`,
    '{"answer": "<your answer, in Markdown>"}',
    'Write only that file. Then stop: Matriarch sends your answer to the supervisor and removes this worktree.'
  ].join('\n')
}

/** A terminal line as text to compare: frames, prompt marks and runs of spaces taken out. */
const plain = (s: string): string => s.replace(/[\s│┃║|╭╮╰╯─━>❯›»•·*]+/g, ' ').trim().toLowerCase()

/**
 * The terminal's lines that are the agent's own output, not its prompt echoed back. The brief
 * carries the supervisor's question and context, which may say anything ("codex resume", "Do you
 * want to proceed?"): a line found in it is dropped before the terminal is read for prompts, an
 * unlocked resume or a quit agent. Agents wrap long lines, so any piece of the brief counts.
 */
export function outputLines(tail: readonly string[], brief: string): string[] {
  const text = plain(brief)
  return tail.filter((line) => {
    const p = plain(line)
    return p.length < 3 || !text.includes(p)
  })
}

export interface AdviceRun extends AdviceQuestion {
  /** Names the worktree and the answer file. */
  runId: string
  /**
   * `starting` until its agent was launched: a restart that finds one starting cannot know
   * whether an agent runs, so it ends the question and removes the worktree.
   */
  phase: 'starting' | 'running'
  startedAt: number
  agent: string
  model: string | null
  effort: string | null
  base: string
  repo: string
  forge?: ForgeKind
  worktree: { path: string; workspaceId: string | null } | null
  terminal: string | null
  lock: LockMode | null
  /** When a terminal in its worktree last changed, to tell a thinking advisor from a stalled one. */
  lastOutputAt: number
  signatures: Record<string, string>
  cursors: Record<string, number>
  /** Why it waits on a person (a prompt in its terminal), where, and since when. */
  blocked: string | null
  blockedTerminal: string | null
  blockedSince: number | null
}

export interface AdviceState {
  v: 1
  queue: AdviceQuestion[]
  running: AdviceRun | null
  /** Mailbox message ids already read, newest last. */
  seen: string[]
  /** Mail for the supervisor that waits for autopilot (answers, refusals). */
  outbox: { subject: string; body: string }[]
  /** What the supervisor was last told: its Run, the mailbox address, and the advisor. */
  told: { run: string | null; address: string | null; advisor: string | null } | null
  /** Worktrees of finished questions that could not be removed yet. */
  leftovers: string[]
  last: { question: string; at: number; answered: boolean; note: string } | null
  /** The project's main checkout, so the poll can send from its mailbox when no tick sees it. */
  root: string | null
  /** Questions dropped because their sender was not the supervisor: how many, and the last one's time. */
  dropped: { count: number; at: number } | null
}

export function emptyAdviceState(): AdviceState {
  return { v: 1, queue: [], running: null, seen: [], outbox: [], told: null, leftovers: [], last: null, root: null, dropped: null }
}

/** Something to look after even when no tick sees the project: an advisor at work, mail, a worktree. */
const needsTending = (state: AdviceState): boolean => state.running !== null || state.leftovers.length > 0 || state.outbox.length > 0

function loadState(raw: unknown): AdviceState {
  const r = obj(raw)
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  const running = r.running && typeof r.running === 'object' ? (r.running as AdviceRun) : null
  return {
    v: 1,
    queue: list<AdviceQuestion>(r.queue),
    running: running ? { ...running, signatures: running.signatures ?? {}, cursors: running.cursors ?? {}, phase: running.phase ?? 'running' } : null,
    seen: list<string>(r.seen).filter((s) => typeof s === 'string'),
    outbox: list<{ subject: string; body: string }>(r.outbox),
    told: r.told && typeof r.told === 'object' ? (r.told as AdviceState['told']) : null,
    leftovers: list<string>(r.leftovers).filter((s) => typeof s === 'string'),
    last: r.last && typeof r.last === 'object' ? (r.last as AdviceState['last']) : null,
    root: typeof r.root === 'string' ? r.root : null,
    dropped: typeof obj(r.dropped).count === 'number' && typeof obj(r.dropped).at === 'number' ? (r.dropped as AdviceState['dropped']) : null
  }
}

/** The advisor as the supervisor knows it; a change means the supervisor is told again. */
export const advisorKey = (role: AdvisorSpec | null): string | null =>
  advisorUsable(role) ? JSON.stringify([role.agent, role.model ?? null, role.effort ?? null, role.readOnly === false]) : null

export function answerMessage(run: AdviceRun, answer: string): { subject: string; body: string } {
  return {
    subject: `Advice: ${clip(run.question, 120)}`,
    body: [
      `The advisor (${advisorName({ agent: run.agent, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) })}) answers your question "${run.question}". It read ${run.base} read-only.`,
      '',
      answer,
      '',
      'It is a second opinion: the decision stays yours.'
    ].join('\n')
  }
}

export function noAnswerMessage(q: AdviceQuestion, why: string): { subject: string; body: string } {
  return {
    subject: `Advice: ${clip(q.question, 100)} (no answer)`,
    body: `The advisor could not answer "${q.question}": ${why}. Go on with your own judgment, or ask again later.`
  }
}

/** Questions that waited their turn when the advisor stopped, in one message. */
export function droppedMessage(questions: readonly AdviceQuestion[], why: string): { subject: string; body: string } {
  return {
    subject: `Advice: ${questions.length} waiting question${questions.length === 1 ? '' : 's'} dropped`,
    body: [`${why}, so the advisor will not answer these questions you asked. Go on with your own judgment:`, ...questions.map((q) => `- ${q.question}`)].join('\n')
  }
}

export interface AdviceStepInput {
  repo: string
  /** The project's main checkout. */
  root: string
  config: MatriarchConfig
  /** The supervisor's Run mailbox (`run:<id>`), when one is known. */
  supervisor: string | null
  /** Autopilot is on, Matriarch can act and the config has no errors: start the advisor and send answers. */
  acting: boolean
  /** Why it is not acting, in words for the board; null when it is. */
  notActing?: string | null
  /** The default branch the advisor reads; null when the forge could not be read this tick. */
  base: string | null
  forge?: ForgeKind
  /**
   * Who the supervisor sends mail as: its chat's `orca_session_id:<id>`, its terminal's handle,
   * the handle its Run is bound to. Only questions from one of these are answered; asked only
   * when a question came.
   */
  supervisorSenders: () => Promise<readonly string[]>
}

export interface AdvicePollInput {
  /** Projects this tick already stepped (or stopped): left alone here. */
  skip: ReadonlySet<string>
  /** Autopilot is on and Matriarch can act: answers may be sent. */
  acting: boolean
  /** Why it is not acting, in words for the board; null when it is. */
  notActing?: string | null
  /** The supervisor's Run mailbox for a project, when one is known. */
  supervisor(repo: string): Promise<string | null>
}

export interface AdvisorDeps extends Pick<CrewDeps, 'orca' | 'exec' | 'now' | 'log' | 'store' | 'readFile' | 'workspaceIdFor' | 'lockdown' | 'lockConfirmMs'> {
  /** Matriarch's mailbox in the project: where questions arrive, and the sender of its mail. */
  mailbox(repo: string, root: string): Promise<string | null>
  /** Orca says this mailbox is gone: the next one asked for is made anew. */
  mailboxGone?: (repo: string, handle: string) => void
  /** Called once each time the advisor starts waiting on a person. */
  alert?: (repo: string, message: string) => Promise<void>
}

export interface Advisor {
  /**
   * One tick for a project: tell the supervisor about the advisor when it does not know, read new
   * questions, advance the one being answered, start the next, and send what is ready. Answers
   * what the board shows, or null when there is no advisor and nothing in flight.
   */
  step(input: AdviceStepInput): Promise<AdvisorView | null>
  /**
   * Matriarch no longer follows the project (its settings are gone): the question being answered
   * is stopped and its worktree removed, the waiting ones dropped, the supervisor told, and the
   * project's advisor state cleared. Nothing to do costs one storage read.
   */
  stop(input: { repo: string; root: string; supervisor: () => Promise<string | null> }): Promise<void>
  /**
   * Looks after every project with an advisor at work, mail waiting or a worktree left, that this
   * tick did not step (its workspaces closed, say): timeouts, terminal checks, removals and mail
   * go on, as review rounds are polled. New questions start only in a step. Answers each one's view.
   */
  poll(input: AdvicePollInput): Promise<{ repo: string; view: AdvisorView }[]>
  /** Records what a supervisor's brief said about the advisor, when its chat starts. */
  briefed(repo: string, advisor: { role: AdvisorSpec; address: string } | null): Promise<void>
  /** Workspaces and paths of advisors at work, for the read-only hooks (no await there). */
  guard(): Guard
  /** Loads the guard from storage after a restart. */
  load(): Promise<void>
}

export function createAdvisor(deps: AdvisorDeps): Advisor {
  const ids = new Set<string>()
  const paths: string[] = []
  const pathOf = new Map<string, string>()

  const remember = (wt: { path: string; workspaceId: string | null }) => {
    if (wt.workspaceId) {
      ids.add(wt.workspaceId)
      pathOf.set(wt.workspaceId, wt.path)
    }
    if (!paths.includes(wt.path)) paths.push(wt.path)
  }
  const forget = (path: string) => {
    for (const [id, p] of [...pathOf]) {
      if (p !== path) continue
      ids.delete(id)
      pathOf.delete(id)
    }
    const i = paths.indexOf(path)
    if (i >= 0) paths.splice(i, 1)
  }

  async function setActive(repo: string, on: boolean): Promise<void> {
    const v = await deps.store.get(ACTIVE)
    const list = Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
    const next = on ? [...new Set([...list, repo])] : list.filter((k) => k !== repo)
    if (next.length !== list.length) await deps.store.set(ACTIVE, next)
  }

  /** A refusal that says Matriarch's mailbox is gone: the next tick makes a new one. */
  const noteGone = (repo: string, handle: string | null, error: unknown) => {
    if (handle && error instanceof OrcaRefusal && GONE_TERMINAL.has(error.code)) deps.mailboxGone?.(repo, handle)
  }

  /** Removes a finished question's worktree; only once it is gone does the read-only guard let go. */
  async function removeWorktree(path: string): Promise<boolean> {
    try {
      await deps.orca.run(['worktree', 'rm', '--worktree', `path:${path}`, '--force', '--delete-branch'])
      forget(path)
      deps.lockdown?.forget(path)
      return true
    } catch (error) {
      deps.log(`advisor worktree ${path} not removed: ${(error as Error).message}`)
      return false
    }
  }

  /** Ends the question being answered: its answer, or why there is none, waits in the outbox. */
  async function finish(state: AdviceState, outcome: { answer: string } | { failed: string }): Promise<void> {
    const run = state.running
    if (!run) return
    const now = deps.now()
    if ('answer' in outcome) {
      state.outbox.push(answerMessage(run, outcome.answer))
      state.last = { question: run.question, at: now, answered: true, note: 'answered' }
    } else {
      state.outbox.push(noAnswerMessage(run, outcome.failed))
      state.last = { question: run.question, at: now, answered: false, note: outcome.failed }
      deps.log(`advisor gave no answer to "${run.question}": ${outcome.failed}`)
    }
    if (run.terminal) await deps.orca.run(['terminal', 'close', '--terminal', run.terminal]).catch(() => {})
    if (run.worktree && !(await removeWorktree(run.worktree.path))) state.leftovers.push(run.worktree.path)
    state.running = null
  }

  /**
   * Reads the mailbox: new questions are saved before the batch is marked read. Each is the full
   * record (`--full`), so its sender is the address Orca stored, and only the supervisor's are
   * taken. Anything else is dropped and logged; nobody is told, so the mailbox is no way in.
   */
  async function intake(state: AdviceState, repo: string, address: string, senders: () => Promise<readonly string[]>, save: () => Promise<void>): Promise<void> {
    let known: ReadonlySet<string> | null = null
    const take = async (items: MailItem[]): Promise<boolean> => {
      // A message is read once: its subject and body taken as Orca gave them.
      const fresh = items.filter((m) => m.complete && !state.seen.includes(m.id))
      for (const m of items) if (!m.complete) deps.log(`${repo}: a message in Matriarch's mailbox came without its subject or body (${m.id})`)
      if (fresh.length === 0) return false
      state.seen = [...state.seen, ...fresh.map((m) => m.id)].slice(-MAX_SEEN)
      for (const m of fresh) if (ADVICE_REPLY.test(m.subject)) deps.log(`${repo}: a reply to an answer of the advisor is not a question, and is not answered: "${clip(m.subject, 80)}"`)
      for (const q of adviceQuestions(fresh, deps.now())) {
        known ??= new Set(await senders().catch(() => []))
        if (!q.from || !known.has(q.from)) {
          deps.log(`${repo}: dropped a question for the advisor from ${q.from ?? 'an unknown sender'}, which is not the supervisor: "${clip(q.question, 80)}"`)
          state.dropped = { count: (state.dropped?.count ?? 0) + 1, at: deps.now() }
          continue
        }
        // The one about to start does not wait: it does not count against the queue.
        if (state.queue.length >= MAX_QUEUED + (state.running ? 0 : 1)) state.outbox.push(noAnswerMessage(q, `${MAX_QUEUED} questions already wait for it; ask again once some are answered`))
        else state.queue.push(q)
      }
      return true
    }
    let peeked: MailItem[]
    try {
      peeked = parseMail(await deps.orca.run(['orchestration', 'check', '--terminal', address, '--peek', '--full']))
    } catch (error) {
      noteGone(repo, address, error)
      deps.log(`${repo}: could not read Matriarch's mailbox: ${(error as Error).message}`)
      return
    }
    if (peeked.length === 0) return
    if (await take(peeked)) await save()
    // Only Matriarch reads its own mailbox: marking the batch read keeps the next look short. Mail
    // that arrived since the peek comes in this batch, with its subject and body.
    const consumed = await deps.orca.run(['orchestration', 'check', '--terminal', address, '--full']).catch(() => null)
    if (consumed && (await take(parseMail(consumed)))) await save()
  }

  /**
   * Every terminal in the advisor's worktree: what each shows (without the brief echoed back), and
   * whether any changed since the last look. Answers null when its own terminal is gone.
   */
  async function observe(run: AdviceRun, now: number): Promise<Map<string, string[]> | null> {
    const path = run.worktree!.path
    const listed = obj(await deps.orca.run(['terminal', 'list', '--worktree', `path:${path}`]).catch(() => null))
    const handles = (Array.isArray(listed.terminals) ? listed.terminals : []).map((t) => str(obj(t).handle)).filter((h): h is string => h !== null)
    if (run.terminal && !handles.includes(run.terminal)) handles.push(run.terminal)
    const brief = advisorBrief({ repo: run.repo, base: run.base, question: run, id: run.runId, forge: run.forge })
    const tails = new Map<string, string[]>()
    const signatures: Record<string, string> = {}
    const cursors: Record<string, number> = {}
    let advanced = false
    for (const h of handles) {
      let t: Obj
      try {
        t = obj(obj(await deps.orca.run(['terminal', 'read', '--terminal', h])).terminal)
      } catch (error) {
        if (h === run.terminal && error instanceof OrcaRefusal && GONE_TERMINAL.has(error.code)) return null
        continue
      }
      const tail = outputLines(Array.isArray(t.tail) ? t.tail.map(String) : [], brief)
      tails.set(h, tail)
      signatures[h] = hashText(tail.slice(-12).join('\n'))
      if (run.signatures[h] !== undefined && run.signatures[h] !== signatures[h]) advanced = true
      if (typeof t.latestCursor === 'number') {
        cursors[h] = t.latestCursor
        if (run.cursors[h] !== undefined && t.latestCursor > run.cursors[h]) advanced = true
      }
    }
    run.signatures = signatures
    run.cursors = cursors
    if (advanced) run.lastOutputAt = now
    return tails
  }

  /** Watches the question being answered: its answer file, the terminals in its worktree, its time. */
  async function advance(state: AdviceState, repo: string): Promise<void> {
    const run = state.running!
    const now = deps.now()
    // Interrupted while starting (a reload, a failed save): whether an agent runs is not known.
    if (run.phase !== 'running' || !run.worktree) return finish(state, { failed: 'Matriarch was interrupted while starting it' })
    if (!run.worktree.workspaceId) {
      // Orca may list a new worktree a little later; the read-only guard takes its id too.
      run.worktree.workspaceId = await deps.workspaceIdFor(run.worktree.path).catch(() => null)
      remember(run.worktree)
    }
    const text = await deps.readFile(`${run.worktree.path}/${answerPath(run.runId)}`).catch(() => null)
    const answer = text ? parseAnswer(text) : null
    if (answer) return finish(state, { answer })
    const tails = await observe(run, now)
    if (!tails) return finish(state, { failed: 'its terminal was closed before it answered' })
    // Orca restores sessions without the launch hook: an agent resumed unlocked, in any terminal
    // of the worktree, is closed, and the question ends.
    for (const [handle, tail] of tails) {
      const agent = unlockedResume(tail.slice(-60))
      if (!agent) continue
      await deps.orca.run(['terminal', 'close', '--terminal', handle]).catch(() => {})
      deps.log(`${repo}: closed ${handle}, where ${agent} was resumed in the advisor's worktree without Matriarch's read-only lockdown`)
      return finish(state, { failed: `Orca resumed ${agent} there without Matriarch's read-only lockdown, so Matriarch closed it` })
    }
    const own = run.terminal ? (tails.get(run.terminal) ?? []) : []
    if (AGENT_QUIT.test(own.slice(-15).join('\n'))) return finish(state, { failed: 'its agent quit' })
    // A prompt that waits on a person: its own terminal first, then any other in the worktree.
    let blocked: string | null = null
    let where: string | null = null
    for (const h of [...(run.terminal ? [run.terminal] : []), ...tails.keys()]) {
      blocked = blockingReason(tails.get(h) ?? [])
      if (blocked) {
        where = h
        break
      }
    }
    if (blocked && !run.blocked) {
      run.blockedSince = now
      await deps.alert?.(repo, `The advisor (${run.agent}) needs you: ${blocked}`).catch((error: Error) => deps.log(`alert failed: ${error.message}`))
    }
    // Time spent waiting on a person does not count as quiet.
    if (!blocked && run.blocked) run.lastOutputAt = now
    run.blocked = blocked
    run.blockedTerminal = blocked ? where : null
    if (!blocked) run.blockedSince = null
    // The limit holds whatever it waits on, so a stuck advisor never keeps the slot for long.
    if (now - run.startedAt > ADVICE_MAX_MS) {
      return finish(state, { failed: run.blocked ? `it waited on a person past the ${Math.round(ADVICE_MAX_MS / 3600_000)}-hour limit: ${run.blocked}` : `it took over ${Math.round(ADVICE_MAX_MS / 3600_000)} hours` })
    }
    if (run.blocked) return
    if (now - Math.max(run.startedAt, run.lastOutputAt) > REVIEWER_TIMEOUT_MS) {
      return finish(state, { failed: text ? 'its answer file is not JSON in the asked shape' : `it was quiet for ${Math.round(REVIEWER_TIMEOUT_MS / 60_000)} min without answering` })
    }
  }

  /**
   * Starts the advisor on the next question: a worktree at the default branch, then the agent.
   * The question is saved as starting before anything is made, and again with its worktree before
   * the agent launches, so a reload in between never starts a second one or loses the worktree.
   */
  async function start(state: AdviceState, input: AdviceStepInput, role: AdvisorSpec, base: string, save: () => Promise<void>): Promise<void> {
    const q = state.queue.shift()!
    const now = deps.now()
    const runId = `${hashText(q.id).slice(0, 6)}${now.toString(36).slice(-4)}`
    state.running = {
      ...q, runId, phase: 'starting', startedAt: now, agent: role.agent, model: role.model ?? null, effort: role.effort ?? null, base,
      repo: input.repo, ...(input.forge ? { forge: input.forge } : {}),
      worktree: null, terminal: null, lock: null, lastOutputAt: now, signatures: {}, cursors: {}, blocked: null, blockedTerminal: null, blockedSince: null
    }
    await save()
    const fetched = await deps.exec('git', ['-C', input.root, 'fetch', '--quiet', 'origin', base], { timeoutMs: 120_000 })
    if (fetched.code !== 0) return finish(state, { failed: `git fetch failed: ${fetched.stderr.trim().slice(0, 200)}` })
    let path: string | null
    let workspaceId: string | null
    try {
      const receipt = await deps.orca.run([
        'worktree', 'create', '--repo', `path:${input.root}`, '--name', `advice-${runId}`,
        '--branch', `${REVIEW_BRANCH_PREFIX}advice-${runId}`, '--base-branch', `origin/${base}`,
        '--setup', 'skip', '--no-parent', '--comment', `Matriarch advisor: ${clip(q.question, 80)}`
      ])
      path = createdPath(receipt)
      workspaceId = createdId(receipt)
    } catch (error) {
      return finish(state, { failed: `worktree create failed: ${(error as Error).message}` })
    }
    if (!path) return finish(state, { failed: 'worktree create gave no path' })
    const worktree = { path, workspaceId: workspaceId ?? (await deps.workspaceIdFor(path).catch(() => null)) }
    state.running.worktree = worktree
    // The read-only hooks know the worktree before the advisor starts in it, and so does storage.
    remember(worktree)
    try {
      await setActive(input.repo, true)
      await save()
    } catch (error) {
      // Not saved: nothing may start in a worktree a reload would not know, so it goes now.
      await removeWorktree(path)
      throw error
    }
    await deps.orca
      .run(['worktree', 'set', '--worktree', `path:${path}`, '--display-name', `Matriarch advisor · ${clip(q.question, 40)}`, '--comment', `Matriarch's advisor, read-only, answering the supervisor: ${clip(q.question, 200)}. Removed when it answers.`])
      .catch((error: Error) => deps.log(`could not label ${path}: ${error.message}`))
    const started = await launchLocked(deps, {
      path,
      role,
      readOnly: role.readOnly,
      prompt: advisorBrief({ repo: input.repo, base, question: q, id: runId, forge: input.forge }),
      notLockable: `Matriarch can start only a claude or codex advisor read-only; set "readOnly": false on the ${role.agent} advisor to run it with your usual permissions`
    })
    state.running.terminal = started.terminal
    state.running.lock = started.lock ?? null
    if (started.error) return finish(state, { failed: started.error })
    state.running.phase = 'running'
    deps.log(`${input.repo}: the advisor (${advisorName(role)}) is answering "${q.question}"`)
  }

  /** What the board shows of a project's advisor. */
  function viewOf(
    state: AdviceState,
    shown: AdvisorSpec | null,
    usable: boolean,
    at: { acting: boolean; notActing?: string | null; supervisor: string | null; waitingForBase: boolean; unreachable?: boolean }
  ): AdvisorView {
    const run = state.running
    return {
      agent: shown?.agent ?? run?.agent ?? '',
      model: shown?.model ?? run?.model ?? null,
      effort: shown?.effort ?? run?.effort ?? null,
      usable,
      answering: run
        ? {
            question: run.question,
            since: run.startedAt,
            blocked: run.blocked,
            terminal: run.blocked ? run.blockedTerminal : null,
            workspaceId: run.worktree?.workspaceId ?? null,
            lock: run.lock ? LOCK_LABEL[run.lock] : null
          }
        : null,
      queued: state.queue.length,
      waiting:
        state.queue.length === 0 && state.outbox.length === 0 ? null
        : !at.acting ? (at.notActing ?? 'autopilot is off')
        : !at.supervisor ? 'no supervisor is running to answer'
        : at.waitingForBase ? 'waiting to read the default branch'
        : null,
      last: state.last,
      ...(at.unreachable ? { unreachable: 'the advisor answers only a supervisor opened from Matriarch' } : {}),
      ...(state.dropped ? { dropped: state.dropped } : {})
    }
  }

  /** Sends what waits in the outbox, in order; what fails stays for the next tick. */
  async function flush(state: AdviceState, repo: string, root: string, supervisor: string): Promise<void> {
    if (state.outbox.length === 0) return
    const from = await deps.mailbox(repo, root).catch(() => null)
    while (state.outbox.length > 0) {
      const m = state.outbox[0]
      try {
        await sendMessage(deps.orca, { to: supervisor, subject: m.subject, body: m.body, from })
        state.outbox.shift()
      } catch (error) {
        noteGone(repo, from, error)
        deps.log(`${repo}: could not send the advisor's mail to the supervisor: ${(error as Error).message}`)
        break
      }
    }
  }

  /** Stops what is in flight: the question being answered, and the ones waiting, told as dropped. */
  async function stopAll(state: AdviceState, why: string): Promise<void> {
    if (state.running) await finish(state, { failed: why })
    if (state.queue.length > 0) state.outbox.push(droppedMessage(state.queue, why))
    state.queue = []
  }

  return {
    guard: () => ({ ids, paths, pathOf }),

    async load() {
      const v = await deps.store.get(ACTIVE)
      for (const repo of Array.isArray(v) ? v : []) {
        if (typeof repo !== 'string') continue
        const state = loadState(await deps.store.get(stateKey(repo)))
        if (state.running?.worktree) remember(state.running.worktree)
        for (const p of state.leftovers) remember({ path: p, workspaceId: null })
      }
    },

    async briefed(repo, advisor) {
      const state = loadState(await deps.store.get(stateKey(repo)))
      state.told = { run: null, address: advisor?.address ?? null, advisor: advisorKey(advisor?.role ?? null) }
      await deps.store.set(stateKey(repo), state as unknown as JsonValue)
    },

    async stop({ repo, root, supervisor: supervisorOf }) {
      const key = stateKey(repo)
      const raw = await deps.store.get(key)
      if (raw === null || raw === undefined) return
      const state = loadState(raw)
      const supervisor = await supervisorOf().catch(() => null)
      await stopAll(state, 'Matriarch was turned off for this project')
      if (state.told?.advisor && supervisor) state.outbox.unshift(advisorMessage(null))
      // The person turned Matriarch off here: the supervisor hears what that ends, whatever
      // autopilot says, as it does of any change they make in Settings.
      if (supervisor) await flush(state, repo, root, supervisor)
      const still: string[] = []
      for (const p of state.leftovers) if (!(await removeWorktree(p))) still.push(p)
      if (still.length > 0) {
        // Kept only to finish removing its worktrees (the poll retries them); nothing more is sent.
        await deps.store.set(key, { ...emptyAdviceState(), leftovers: still } as unknown as JsonValue)
        await setActive(repo, true)
        return
      }
      await deps.store.set(key, null)
      await setActive(repo, false)
    },

    async step(input) {
      const key = stateKey(input.repo)
      const state = loadState(await deps.store.get(key))
      const before = JSON.stringify(state)
      state.root = input.root
      const save = async () => {
        await deps.store.set(key, state as unknown as JsonValue)
      }
      const advisor = input.config.advisor
      const role = advisorUsable(advisor) ? advisor : null
      // Answers wait for autopilot; notices of how the advisor is set up do not (see the top).
      const canSend = input.acting && input.supervisor !== null
      let unreachable = false
      // No advisor set, nothing in flight and nobody to tell: nothing to do.
      if (!advisor && !state.running && state.queue.length === 0 && state.outbox.length === 0 && state.leftovers.length === 0 && !state.told?.advisor) return null

      // Worktrees that could not be removed before are tried again.
      if (state.leftovers.length > 0) {
        const still: string[] = []
        for (const p of state.leftovers) if (!(await removeWorktree(p))) still.push(p)
        state.leftovers = still
      }

      if (!role) {
        // Turned off (or no longer one Matriarch can start): stop what is in flight, and tell a
        // supervisor that knew about it.
        await stopAll(state, 'the advisor was turned off')
        if (state.told?.advisor && input.supervisor) {
          const m = advisorMessage(null)
          const from = await deps.mailbox(input.repo, input.root).catch(() => null)
          try {
            await sendMessage(deps.orca, { to: input.supervisor!, subject: m.subject, body: m.body, from })
            state.told = { run: input.supervisor, address: state.told.address, advisor: null }
          } catch (error) {
            noteGone(input.repo, from, error)
            deps.log(`${input.repo}: could not tell the supervisor the advisor is off: ${(error as Error).message}`)
          }
        }
      } else {
        // The mailbox: where questions arrive, and the address the supervisor was given.
        const busy = input.supervisor !== null || state.running !== null || state.queue.length > 0
        const address = busy ? await deps.mailbox(input.repo, input.root).catch(() => null) : null
        if (input.supervisor && address) {
          const want = { address, advisor: advisorKey(role) }
          const t = state.told
          if (t && t.run === null && t.address === want.address && t.advisor === want.advisor) {
            // Its brief, when its chat started, said all of this.
            state.told = { ...t, run: input.supervisor }
          } else if (!t || t.run !== input.supervisor || t.address !== want.address || t.advisor !== want.advisor) {
            // It started before there was an advisor, the advisor changed, or the mailbox moved.
            // Only a supervisor Matriarch can recognise as a sender is told: one it cannot (a chat
            // someone opened by hand) would ask, and every question would be dropped.
            unreachable = (await input.supervisorSenders().catch(() => [])).length === 0
            if (!unreachable) {
              const m = advisorMessage({ role, address })
              try {
                await sendMessage(deps.orca, { to: input.supervisor, subject: m.subject, body: m.body, from: address })
                state.told = { run: input.supervisor, ...want }
              } catch (error) {
                noteGone(input.repo, address, error)
                deps.log(`${input.repo}: could not tell the supervisor about the advisor: ${(error as Error).message}`)
              }
            }
          }
        }
        if (address) await intake(state, input.repo, address, input.supervisorSenders, save)
        if (state.running) await advance(state, input.repo)
        if (!state.running && state.queue.length > 0 && input.acting && input.supervisor && input.base) await start(state, input, role, input.base, save)
      }

      // Answers and refusals go out once Matriarch may send mail.
      if (canSend) await flush(state, input.repo, input.root, input.supervisor!)
      state.outbox = state.outbox.slice(-MAX_OUTBOX)
      await setActive(input.repo, needsTending(state))
      if (JSON.stringify(state) !== before) await save()

      // An advisor that is set but cannot be started still shows, with why.
      if (!advisor && !state.running && state.outbox.length === 0) return null
      return viewOf(state, role ?? advisor, role !== null, {
        acting: input.acting,
        notActing: input.notActing ?? null,
        supervisor: input.supervisor,
        waitingForBase: !input.base && !state.running,
        unreachable
      })
    },

    async poll({ skip, acting, notActing, supervisor: supervisorOf }) {
      const v = await deps.store.get(ACTIVE)
      const repos = (Array.isArray(v) ? v : []).filter((r): r is string => typeof r === 'string' && !skip.has(r))
      const views: { repo: string; view: AdvisorView }[] = []
      for (const repo of repos) {
        const key = stateKey(repo)
        const state = loadState(await deps.store.get(key))
        const before = JSON.stringify(state)
        if (state.leftovers.length > 0) {
          const still: string[] = []
          for (const p of state.leftovers) if (!(await removeWorktree(p))) still.push(p)
          state.leftovers = still
        }
        if (state.running) await advance(state, repo)
        const supervisor = acting && state.outbox.length > 0 ? await supervisorOf(repo).catch(() => null) : null
        if (supervisor && state.root) await flush(state, repo, state.root, supervisor)
        state.outbox = state.outbox.slice(-MAX_OUTBOX)
        await setActive(repo, needsTending(state))
        if (JSON.stringify(state) !== before) await deps.store.set(key, state as unknown as JsonValue)
        if (state.running || state.outbox.length > 0) views.push({ repo, view: viewOf(state, null, true, { acting, notActing: notActing ?? null, supervisor, waitingForBase: false }) })
      }
      return views
    }
  }
}
