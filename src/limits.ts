// Worker limits: how many of the supervisor's workers may be running at once, how many it may
// start in a day, and the free disk below which it starts none. The supervisor starts workers
// itself, with `orca orchestration worker-start`, so Matriarch holds it to them two ways:
//
// - its brief says them, and a running supervisor is told when they change;
// - the agent.tool.before hook refuses a start over a limit, with what to do instead.
//
// The hook judges only the supervisor's own terminal and its Run's workers' terminals, never a
// session of the person's. Orca reports tool calls only for agents in a terminal (a chat-mode
// session has no hook stream in Orca 1.4.257) and waits for an answer only from Claude Code, so a
// supervisor in a chat, or on another agent, can still go over; Needs you then shows it.
//
// The hook gets 2 s and may not await, so it decides from what the last tick counted, plus the
// starts it let through since. Reading the command it fails closed: any `orchestration` followed
// by `worker-start` or `dispatch` (or by a word it cannot read), and any `agent launch`, counts
// as a start, wherever it appears. A wrong guess costs only a refusal when a limit is reached.
import type { MatriarchConfig } from './config.ts'
import type { WorkerRow } from './orca-cli.ts'

export type Limits = MatriarchConfig['limits']

/** Worker states that carry an outcome (Orca's SETTLED_WORKER_STATES, and spellings around it). */
const SETTLED = new Set(['succeeded', 'failed', 'stopped', 'abandoned', 'cancelled', 'canceled', 'done'])

/**
 * Still running, for the limits: anything but a settled worker or one Orca saw exit. A worker
 * Orca cannot vouch for (just started, restored after a restart, stale) counts as running.
 */
export const isWorking = (w: WorkerRow): boolean => !SETTLED.has((w.state ?? '').toLowerCase()) && w.liveness !== 'exited'

/** The local calendar day of a time, `YYYY-MM-DD`: the daily budget starts again at midnight. */
export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The workers of one supervisor Run counted against today's budget. */
export interface StartsRecord {
  /** The Run they belong to. */
  run: string
  day: string
  count: number
  /** The Run's dispatch ids in the last list: a new one is a start. */
  seen: string[]
}

/**
 * Counts the Run's workers that were not in its last list as started today. The first look at a
 * Run (a new link, or the Run found again after a restart) only takes note: its workers already
 * there started at a time Matriarch cannot tell, and Orca's list does not say when.
 */
export function countStarts(prev: StartsRecord | null, run: string, dispatchIds: readonly string[], now: number): StartsRecord {
  const day = dayOf(now)
  const ids = [...new Set(dispatchIds)]
  const today = prev && prev.day === day ? prev.count : 0
  if (!prev || prev.run !== run) return { run, day, count: today, seen: ids }
  const known = new Set(prev.seen)
  // The list is the Run's newest workers; one that dropped off the end never comes back.
  return { run, day, count: today + ids.filter((id) => !known.has(id)).length, seen: ids }
}

export function loadStarts(raw: unknown): StartsRecord | null {
  const r = typeof raw === 'object' && raw !== null ? (raw as Partial<StartsRecord>) : null
  if (!r || typeof r.run !== 'string' || typeof r.day !== 'string' || typeof r.count !== 'number' || !Array.isArray(r.seen)) return null
  return { run: r.run, day: r.day, count: r.count, seen: r.seen.filter((s): s is string => typeof s === 'string') }
}

/** What one tick knew about a project, for the hook to judge a worker start by. */
export interface LimitState {
  repo: string
  /** Terminal handles of the supervisor and its Run's workers: only their calls are judged. */
  terminals: string[]
  /** The supervisor's workers still running. */
  live: number
  /** Workers counted against `day`'s budget. */
  startsToday: number
  day: string
  /** Bytes free on the project's disk; null when it could not tell. */
  freeBytes: number | null
  /** When the worker list these counts come from was read. */
  listedAt: number
  limits: Limits
}

const GB = 1024 ** 3
const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`

/** Orca's orchestration subcommands (1.4.257): a known one that is not a start is not counted. */
const SUBCOMMANDS = new Set([
  'run-create', 'run-use', 'run-current', 'run-list', 'run-show', 'send', 'check', 'reply', 'inbox', 'task-create', 'task-list',
  'task-update', 'worker-start', 'worker-show', 'worker-read', 'worker-stop', 'deny', 'worker-abandon', 'worker-release',
  'worker-keep-open', 'worker-list', 'dispatch', 'request-show', 'dispatch-show', 'ask', 'coordinator-start', 'coordinator-stop',
  'gate-create', 'gate-resolve', 'gate-list', 'reset'
])
const STARTS = new Set(['worker-start', 'dispatch'])
/** A word the shell would expand or glob: what it runs cannot be read from the text. */
const UNREADABLE = /[$`{}*?[\]]/
/** Words that run a command more than once, or define one to call again. */
const REPEATS = new Set(['for', 'while', 'until', 'select', 'repeat', 'xargs', 'parallel', 'seq', 'watch', 'function', '-exec', '-execdir'])

/** The command as words, the way the shell would split it, loosely: quotes and escapes dropped. */
function words(command: string): string[] {
  return command
    .replace(/\\\r?\n/g, ' ') // line continuations
    .replace(/\\(.)/g, '$1') // escapes: wor\ker-start is worker-start
    .replace(/["']/g, '') // quotes: "orca" is orca, worker"-"start is worker-start
    .replace(/\$\(|[`()<>;&|\r\n]/g, ' ') // separators, substitutions, subshells, redirects, heredocs
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * The subcommand after `orchestration` (or `agent`), skipping flags and up to two flag values. A
 * start, or a word it cannot read, wins wherever it is in reach; a known word right after a flag
 * may be that flag's value, so the search goes on past it.
 */
function subcommand(ws: readonly string[], from: number, known: ReadonlySet<string>, starts: ReadonlySet<string>): string | null {
  let values = 0
  let afterFlag = false
  for (let i = from; i < ws.length && i < from + 10; i++) {
    const w = ws[i]
    if (w.startsWith('-')) {
      afterFlag = !w.includes('=')
      continue
    }
    if (starts.has(w) || UNREADABLE.test(w)) return w
    if (known.has(w) && !afterFlag) return w
    afterFlag = false
    if (++values > 2) return null
  }
  return null
}
const LAUNCH = new Set(['launch'])

/** How many workers this command starts, and whether it may start more than its text shows. */
export function startsIn(command: string): { count: number; repeats: boolean } {
  const ws = words(command)
  let count = 0
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === 'orchestration') {
      const sub = subcommand(ws, i + 1, SUBCOMMANDS, STARTS)
      if (sub && (STARTS.has(sub) || UNREADABLE.test(sub))) count++
    } else if (ws[i] === 'agent' && subcommand(ws, i + 1, LAUNCH, LAUNCH) === 'launch') count++
  }
  const repeats = count > 0 && (ws.some((w) => REPEATS.has(w)) || /\b[\w-]+\s*\(\s*\)\s*\{/.test(command))
  return { count, repeats }
}

/** Kept for callers that only ask yes or no. */
export const isWorkerStart = (command: string): boolean => startsIn(command).count > 0

/**
 * Why these starts may not happen now, in words the supervisor can act on, or null when they may.
 * `passed` counts the starts let through since the tick that made `state` (today's, for the day).
 * A command that starts workers in a loop is refused whenever a count limit is set: how many it
 * starts cannot be known, and one call per worker costs the supervisor nothing.
 */
export function startRefusal(state: LimitState, passed: { running: number; today: number }, request: { count: number; repeats: boolean }, today: string): string | null {
  const { limits, repo } = state
  const loop = `This command starts workers in a loop, so Matriarch cannot count them against ${repo}'s limit. Start each worker with its own worker-start call.`
  const live = state.live + passed.running
  if (limits.maxWorkers > 0) {
    if (request.repeats) return loop
    if (live + request.count > limits.maxWorkers) {
      const more = request.count > 1 ? `, and this would start ${request.count} more` : ''
      return `${live} of ${limits.maxWorkers} workers are running in ${repo}${more}, over the most this project runs at once. Wait for one to finish (Orca wakes you with its report), then start the next. Do not retry before then.`
    }
  }
  const starts = (state.day === today ? state.startsToday : 0) + passed.today
  if (limits.maxWorkerStartsPerDay > 0) {
    if (request.repeats) return loop
    if (starts + request.count > limits.maxWorkerStartsPerDay) {
      return `${repo} has started ${starts} workers today${request.count > 1 ? ` and this would start ${request.count} more` : ''}, over its limit of ${limits.maxWorkerStartsPerDay} a day. Do not start more today: note in your chat what is left, and start it after midnight.`
    }
  }
  if (limits.minFreeDiskGB > 0 && state.freeBytes !== null && state.freeBytes < limits.minFreeDiskGB * GB) {
    return `Only ${gb(state.freeBytes)} is free on the disk with ${repo}, under this project's ${limits.minFreeDiskGB} GB floor, and a full disk stalls every build. Start no worker until space is freed (worktrees go as their PRs merge); tell the user in your chat.`
  }
  return null
}

/** The limits as lines for the supervisor's brief and messages; empty when none is set. */
export function limitLines(limits: Limits): string[] {
  const parts = [
    limits.maxWorkers > 0 ? `at most ${limits.maxWorkers} worker${limits.maxWorkers === 1 ? '' : 's'} running at once` : null,
    limits.maxWorkerStartsPerDay > 0 ? `at most ${limits.maxWorkerStartsPerDay} worker start${limits.maxWorkerStartsPerDay === 1 ? '' : 's'} a day` : null,
    limits.minFreeDiskGB > 0 ? `no new worker while the disk has under ${limits.minFreeDiskGB} GB free` : null
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return []
  return [
    `Limits in this project: ${parts.join('; ')}.`,
    'Start each worker with its own worker-start call, not in a loop, so Matriarch can count it. Matriarch refuses',
    'a start over a limit and says why. Then wait (for a worker to finish, for tomorrow, or for space) and start it',
    'later; do not retry at once, and keep the other tasks moving.'
  ]
}

/** Whether the limits the supervisor is told about changed. */
export const limitsChanged = (a: Limits | undefined, b: Limits): boolean =>
  !a || a.maxWorkers !== b.maxWorkers || a.maxWorkerStartsPerDay !== b.maxWorkerStartsPerDay || a.minFreeDiskGB !== b.minFreeDiskGB

/** What a running supervisor is told when the limits change in Settings. */
export function limitsMessage(limits: Limits): { subject: string; body: string } {
  const lines = limitLines(limits)
  return {
    subject: 'Worker limits changed',
    body: lines.length
      ? ['The user changed the worker limits. From now on:', ...lines].join('\n')
      : 'The user turned the worker limits off: Matriarch no longer refuses a worker start in this project.'
  }
}

export interface ToolCall {
  agent?: string
  tool: string
  workspaceId: string | null
  terminalId?: string
  input: unknown
}

/** What the hook keeps, and what a restart starts from. */
export interface LimitsSnapshot {
  states: Record<string, LimitState>
  /** Per project: when each start the hook let through was let through. */
  passed: Record<string, number[]>
}

/**
 * A start let through is counted until a worker list read this long after it: by then the worker
 * it started is in the list, so the tick counts it instead.
 */
export const PASSED_GRACE_MS = 30_000

/** The hook's side: the last tick's counts per project, and the starts it let through since. */
export interface LimitsGuard {
  /** A tick's counts. Starts let through well before its worker list was read are in them now. */
  update(state: LimitState): void
  /** Forgets the projects a tick that read Orca's workspaces did not see (turned off, or gone). */
  keep(repos: ReadonlySet<string>): void
  /** What a restart starts from; a project a tick already reported keeps its newer counts. */
  restore(snapshot: unknown): void
  /** A reason to refuse this call, or null. Synchronous. */
  decide(call: ToolCall): { deny: string; repo: string } | null
}

export function createLimitsGuard(options: { now?: () => number; save?: (snapshot: LimitsSnapshot) => void } = {}): LimitsGuard {
  const now = options.now ?? Date.now
  const states = new Map<string, LimitState>()
  const passed = new Map<string, number[]>()
  const save = () => options.save?.({ states: Object.fromEntries(states), passed: Object.fromEntries(passed) })
  return {
    update(state) {
      states.set(state.repo, state)
      const kept = (passed.get(state.repo) ?? []).filter((at) => at >= state.listedAt - PASSED_GRACE_MS)
      if (kept.length) passed.set(state.repo, kept)
      else passed.delete(state.repo)
      save()
    },
    keep(repos) {
      let changed = false
      for (const repo of [...states.keys()]) {
        if (repos.has(repo)) continue
        states.delete(repo)
        passed.delete(repo)
        changed = true
      }
      if (changed) save()
    },
    restore(snapshot) {
      const s = typeof snapshot === 'object' && snapshot !== null ? (snapshot as Partial<LimitsSnapshot>) : {}
      for (const [repo, state] of Object.entries(s.states ?? {})) {
        if (states.has(repo) || !Array.isArray(state?.terminals) || typeof state.live !== 'number' || typeof state.limits !== 'object') continue
        states.set(repo, state)
        const times = (s.passed ?? {})[repo]
        if (Array.isArray(times)) passed.set(repo, times.filter((t): t is number => typeof t === 'number'))
      }
    },
    decide(call) {
      if (call.tool !== 'Bash' || !call.terminalId) return null
      const state = [...states.values()].find((s) => s.terminals.includes(call.terminalId!))
      if (!state) return null
      const input = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {}
      const request = startsIn(typeof input.command === 'string' ? input.command : '')
      if (request.count === 0) return null
      const at = now()
      const today = dayOf(at)
      const times = passed.get(state.repo) ?? []
      const reason = startRefusal(state, { running: times.length, today: times.filter((t) => dayOf(t) === today).length }, request, today)
      if (reason) return { deny: reason, repo: state.repo }
      // Let through: each start counts until a worker list read after it sees the worker.
      passed.set(state.repo, [...times, ...Array.from({ length: request.count }, () => at)])
      save()
      return null
    }
  }
}
