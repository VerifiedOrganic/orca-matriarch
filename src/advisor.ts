// The advisor: a role above the supervisor, on its own agent and model, that the supervisor asks
// for a second opinion. The supervisor mails Matriarch's mailbox (Matriarch's own terminal in the
// project) a message whose subject starts "Advice:". Each tick Matriarch reads the mailbox, queues
// the questions and answers them one at a time: a throwaway worktree at the default branch, the
// advisor started there read-only, locked down by its own agent exactly like a reviewer, and the
// answer it writes mailed back to the supervisor. The worktree goes once it answers or gives up.
// Like automatic reviews it starts only with autopilot on; in dry run questions wait. Everything
// lives in plugin storage, so a restart picks a question up where it was.
import type { JsonValue } from 'orca/host'
import { advisorUsable, type AdvisorSpec, type MatriarchConfig } from './config.ts'
import {
  AGENT_QUIT, BLOCKED_MAX_MS, blockingReason, createdId, createdPath, hashText, launchLocked,
  REVIEW_BRANCH_PREFIX, REVIEWER_TIMEOUT_MS, unlockedResume, type CrewDeps
} from './crew.ts'
import { forgeTerms, type ForgeKind } from './forge.ts'
import type { Guard } from './guard.ts'
import { LOCK_LABEL, type LockMode } from './lockdown.ts'
import { OrcaRefusal, sendMessage } from './orca-cli.ts'
import type { AdvisorView } from './protocol.ts'
import { advisorMessage, advisorName } from './supervisor.ts'

/** The longest one question may take while the advisor is not waiting on a person. */
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
    items.push({ id, from: str(o.from) ?? str(o.from_handle), subject: typeof o.subject === 'string' ? o.subject : '', body: typeof o.body === 'string' ? o.body : '' })
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

const ADVICE = /^\s*advice\s*:\s*/i

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

export interface AdviceRun extends AdviceQuestion {
  /** Names the worktree and the answer file. */
  runId: string
  startedAt: number
  agent: string
  model: string | null
  effort: string | null
  base: string
  worktree: { path: string; workspaceId: string | null } | null
  terminal: string | null
  lock: LockMode | null
  /** When its terminal last changed, to tell a thinking advisor from a stalled one. */
  lastOutputAt: number
  signature: string | null
  cursor: number | null
  /** Why it waits on a person (a prompt in its terminal), and since when. */
  blocked: string | null
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
}

export function emptyAdviceState(): AdviceState {
  return { v: 1, queue: [], running: null, seen: [], outbox: [], told: null, leftovers: [], last: null }
}

function loadState(raw: unknown): AdviceState {
  const r = obj(raw)
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    v: 1,
    queue: list<AdviceQuestion>(r.queue),
    running: r.running && typeof r.running === 'object' ? (r.running as AdviceRun) : null,
    seen: list<string>(r.seen).filter((s) => typeof s === 'string'),
    outbox: list<{ subject: string; body: string }>(r.outbox),
    told: r.told && typeof r.told === 'object' ? (r.told as AdviceState['told']) : null,
    leftovers: list<string>(r.leftovers).filter((s) => typeof s === 'string'),
    last: r.last && typeof r.last === 'object' ? (r.last as AdviceState['last']) : null
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

export interface AdviceStepInput {
  repo: string
  /** The project's main checkout. */
  root: string
  config: MatriarchConfig
  /** The supervisor's Run mailbox (`run:<id>`), when one is known. */
  supervisor: string | null
  /** Autopilot is on and the config has no errors: start the advisor and send mail. */
  acting: boolean
  /** The default branch the advisor reads; null when the forge could not be read this tick. */
  base: string | null
  forge?: ForgeKind
}

export interface AdvisorDeps extends Pick<CrewDeps, 'orca' | 'exec' | 'now' | 'log' | 'store' | 'readFile' | 'workspaceIdFor' | 'lockdown' | 'lockConfirmMs'> {
  /** Matriarch's mailbox in the project: where questions arrive, and the sender of its mail. */
  mailbox(repo: string, root: string): Promise<string | null>
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

  /** Reads the mailbox: new questions are saved before the batch is marked read. */
  async function intake(state: AdviceState, repo: string, address: string, save: () => Promise<void>): Promise<void> {
    const take = (items: MailItem[]) => {
      const fresh = items.filter((m) => !state.seen.includes(m.id))
      if (fresh.length === 0) return false
      state.seen = [...state.seen, ...fresh.map((m) => m.id)].slice(-MAX_SEEN)
      for (const q of adviceQuestions(fresh, deps.now())) {
        // The one about to start does not wait: it does not count against the queue.
        if (state.queue.length >= MAX_QUEUED + (state.running ? 0 : 1)) state.outbox.push(noAnswerMessage(q, `${MAX_QUEUED} questions already wait for it; ask again once some are answered`))
        else state.queue.push(q)
      }
      return true
    }
    let peeked: MailItem[]
    try {
      peeked = parseMail(await deps.orca.run(['orchestration', 'check', '--terminal', address, '--peek']))
    } catch (error) {
      deps.log(`${repo}: could not read Matriarch's mailbox: ${(error as Error).message}`)
      return
    }
    if (peeked.length === 0) return
    if (take(peeked)) await save()
    // Only Matriarch reads its own mailbox: marking the batch read keeps the next look short.
    const consumed = await deps.orca.run(['orchestration', 'check', '--terminal', address]).catch(() => null)
    if (consumed && take(parseMail(consumed))) await save()
  }

  /** Watches the question being answered: its answer file, its terminal, and its time. */
  async function advance(state: AdviceState, repo: string): Promise<void> {
    const run = state.running!
    const now = deps.now()
    const text = run.worktree ? await deps.readFile(`${run.worktree.path}/${answerPath(run.runId)}`).catch(() => null) : null
    const answer = text ? parseAnswer(text) : null
    if (answer) return finish(state, { answer })
    if (run.terminal) {
      let tail: string[]
      let cursor: number | null
      try {
        const t = obj(obj(await deps.orca.run(['terminal', 'read', '--terminal', run.terminal])).terminal)
        tail = Array.isArray(t.tail) ? t.tail.map(String) : []
        cursor = typeof t.latestCursor === 'number' ? t.latestCursor : null
      } catch (error) {
        if (error instanceof OrcaRefusal && ['terminal_handle_stale', 'terminal_not_found'].includes(error.code)) return finish(state, { failed: 'its terminal was closed before it answered' })
        tail = []
        cursor = run.cursor
      }
      // Orca restores sessions without the launch hook: an advisor resumed unlocked is closed.
      if (unlockedResume(tail.slice(-60))) return finish(state, { failed: "Orca resumed it without Matriarch's read-only lockdown, so Matriarch closed it" })
      if (AGENT_QUIT.test(tail.slice(-15).join('\n'))) return finish(state, { failed: 'its agent quit' })
      const signature = hashText(tail.slice(-12).join('\n'))
      if ((run.signature !== null && signature !== run.signature) || (cursor !== null && run.cursor !== null && cursor > run.cursor)) run.lastOutputAt = now
      run.signature = signature
      run.cursor = cursor
      const blocked = blockingReason(tail)
      if (blocked && !run.blocked) {
        run.blockedSince = now
        await deps.alert?.(repo, `The advisor (${run.agent}) needs you: ${blocked}`).catch((error: Error) => deps.log(`alert failed: ${error.message}`))
      }
      // Time spent waiting on a person does not count as quiet.
      if (!blocked && run.blocked) run.lastOutputAt = now
      run.blocked = blocked
      if (!blocked) run.blockedSince = null
    }
    if (run.blocked) {
      if (now - (run.blockedSince ?? now) > BLOCKED_MAX_MS) return finish(state, { failed: `it waited ${Math.round(BLOCKED_MAX_MS / 3600_000)} h for a person: ${run.blocked}` })
      return
    }
    if (now - Math.max(run.startedAt, run.lastOutputAt) > REVIEWER_TIMEOUT_MS) {
      return finish(state, { failed: text ? 'its answer file is not JSON in the asked shape' : `it was quiet for ${Math.round(REVIEWER_TIMEOUT_MS / 60_000)} min without answering` })
    }
    if (now - run.startedAt > ADVICE_MAX_MS) return finish(state, { failed: `it took over ${Math.round(ADVICE_MAX_MS / 3600_000)} hours` })
  }

  /** Starts the advisor on the next question: a worktree at the default branch, then the agent. */
  async function start(state: AdviceState, input: AdviceStepInput, role: AdvisorSpec, base: string): Promise<void> {
    const q = state.queue.shift()!
    const now = deps.now()
    const runId = `${hashText(q.id).slice(0, 6)}${now.toString(36).slice(-4)}`
    state.running = {
      ...q, runId, startedAt: now, agent: role.agent, model: role.model ?? null, effort: role.effort ?? null, base,
      worktree: null, terminal: null, lock: null, lastOutputAt: now, signature: null, cursor: null, blocked: null, blockedSince: null
    }
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
    // The read-only hooks know the worktree before the advisor starts in it.
    remember(worktree)
    await setActive(input.repo, true)
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
    deps.log(`${input.repo}: the advisor (${advisorName(role)}) is answering "${q.question}"`)
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

    async step(input) {
      const key = stateKey(input.repo)
      const state = loadState(await deps.store.get(key))
      const before = JSON.stringify(state)
      const save = async () => {
        await deps.store.set(key, state as unknown as JsonValue)
      }
      const advisor = input.config.advisor
      const role = advisorUsable(advisor) ? advisor : null
      const canSend = input.acting && input.supervisor !== null
      // No advisor, nothing in flight and nobody to tell: nothing to do.
      if (!role && !state.running && state.queue.length === 0 && state.outbox.length === 0 && state.leftovers.length === 0 && !state.told?.advisor) return null

      // Worktrees that could not be removed before are tried again.
      if (state.leftovers.length > 0) {
        const still: string[] = []
        for (const p of state.leftovers) if (!(await removeWorktree(p))) still.push(p)
        state.leftovers = still
      }

      if (!role) {
        // Turned off (or no longer one Matriarch can start): stop what is in flight, and tell a
        // supervisor that knew about it.
        if (state.running) await finish(state, { failed: 'the advisor was turned off' })
        state.queue = []
        if (state.told?.advisor && canSend) {
          const m = advisorMessage(null)
          try {
            await sendMessage(deps.orca, { to: input.supervisor!, subject: m.subject, body: m.body, from: await deps.mailbox(input.repo, input.root).catch(() => null) })
            state.told = { run: input.supervisor, address: state.told.address, advisor: null }
          } catch (error) {
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
            if (canSend) {
              const m = advisorMessage({ role, address })
              try {
                await sendMessage(deps.orca, { to: input.supervisor, subject: m.subject, body: m.body, from: address })
                state.told = { run: input.supervisor, ...want }
              } catch (error) {
                deps.log(`${input.repo}: could not tell the supervisor about the advisor: ${(error as Error).message}`)
              }
            }
          }
        }
        if (address) await intake(state, input.repo, address, save)
        if (state.running) await advance(state, input.repo)
        if (!state.running && state.queue.length > 0 && input.acting && input.supervisor && input.base) await start(state, input, role, input.base)
      }

      // Answers and refusals go out once Matriarch may send mail.
      if (canSend && state.outbox.length > 0) {
        const from = await deps.mailbox(input.repo, input.root).catch(() => null)
        while (state.outbox.length > 0) {
          const m = state.outbox[0]
          try {
            await sendMessage(deps.orca, { to: input.supervisor!, subject: m.subject, body: m.body, from })
            state.outbox.shift()
          } catch (error) {
            deps.log(`${input.repo}: could not send the advisor's answer to the supervisor: ${(error as Error).message}`)
            break
          }
        }
      }
      state.outbox = state.outbox.slice(-MAX_OUTBOX)
      if (!state.running) await setActive(input.repo, state.leftovers.length > 0)
      if (JSON.stringify(state) !== before) await save()

      if (!role && !state.running && state.outbox.length === 0) return null
      const shown = role ?? advisor
      const run = state.running
      return {
        agent: shown?.agent ?? run?.agent ?? '',
        model: shown?.model ?? run?.model ?? null,
        effort: shown?.effort ?? run?.effort ?? null,
        usable: role !== null,
        answering: run
          ? {
              question: run.question,
              since: run.startedAt,
              blocked: run.blocked,
              terminal: run.blocked ? run.terminal : null,
              workspaceId: run.worktree?.workspaceId ?? null,
              lock: run.lock ? LOCK_LABEL[run.lock] : null
            }
          : null,
        queued: state.queue.length,
        waiting:
          state.queue.length === 0 && state.outbox.length === 0 ? null
          : !input.acting ? 'autopilot is off'
          : !input.supervisor ? 'no supervisor is running to answer'
          : !input.base && !run ? 'waiting to read the default branch'
          : null,
        last: state.last
      }
    }
  }
}
