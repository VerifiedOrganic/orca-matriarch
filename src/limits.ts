// Worker limits: how many of the supervisor's workers may be live at once, how many it may start
// in a day, and the free disk below which it starts none. The supervisor starts workers itself,
// with `orca orchestration worker-start`, so Matriarch holds it to them two ways:
//
// - its brief says them, and a running supervisor is told when they change;
// - the agent.tool.before hook refuses its worker-start call over a limit, with what to do instead.
//
// Orca waits on that hook only for Claude Code (other agents just report their calls), so a
// supervisor on another agent can still start a worker over a limit; Needs you then shows it.
// The hook gets 2 s and may not await, so it decides from what the last tick counted, plus the
// starts it let through since.
import type { MatriarchConfig } from './config.ts'
import { shellSegments } from './guard.ts'
import type { WorkerRow } from './orca-cli.ts'

export type Limits = MatriarchConfig['limits']

/** Worker states that mean it finished: it no longer counts against the cap. */
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'canceled', 'abandoned', 'stopped', 'done'])

/** A worker still running its task: its agent is live and it has not settled. */
export const isWorking = (w: WorkerRow): boolean => w.live !== false && !SETTLED.has((w.state ?? '').toLowerCase())

/** The local calendar day of a time, `YYYY-MM-DD`: the daily budget starts again at midnight. */
export function dayOf(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The workers counted against today's budget, by their dispatch ids. */
export interface StartsRecord {
  day: string
  count: number
  /** Dispatch ids already counted (the newest few hundred), so none counts twice. */
  seen: string[]
}

const MAX_SEEN = 500

/**
 * Counts the workers Matriarch has not seen before as started today. The first time it looks it
 * only takes note: workers already there started at a time it cannot tell.
 */
export function countStarts(prev: StartsRecord | null, dispatchIds: readonly string[], now: number): StartsRecord {
  const day = dayOf(now)
  if (!prev) return { day, count: 0, seen: [...new Set(dispatchIds)].slice(-MAX_SEEN) }
  const known = new Set(prev.seen)
  const fresh = [...new Set(dispatchIds)].filter((id) => !known.has(id))
  const count = (prev.day === day ? prev.count : 0) + fresh.length
  return { day, count, seen: [...prev.seen, ...fresh].slice(-MAX_SEEN) }
}

export function loadStarts(raw: unknown): StartsRecord | null {
  const r = typeof raw === 'object' && raw !== null ? (raw as Partial<StartsRecord>) : null
  if (!r || typeof r.day !== 'string' || typeof r.count !== 'number' || !Array.isArray(r.seen)) return null
  return { day: r.day, count: r.count, seen: r.seen.filter((s): s is string => typeof s === 'string') }
}

/** What one tick knew about a project, for the hook to judge a worker start by. */
export interface LimitState {
  repo: string
  /** The project's main checkout, where its supervisor works. */
  root: string
  /** The project's worktrees as Orca lists them, to tell its agents' calls from others'. */
  workspaces: readonly { id: string; path: string }[]
  /** The supervisor's workers still running. */
  live: number
  /** Workers counted against `day`'s budget. */
  startsToday: number
  day: string
  /** Bytes free on the project's disk; null when it could not tell. */
  freeBytes: number | null
  limits: Limits
}

const GB = 1024 ** 3
const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`

/** Is this shell command (or one of its parts) an `orca orchestration worker-start`? */
export function isWorkerStart(command: string): boolean {
  const parts = shellSegments(command)?.segments ?? [command]
  return parts.some((part) => {
    // Leading `VAR=value` assignments and `command`/`exec` do not change what runs.
    const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'command' && w !== 'exec')
    return /(^|\/)orca$/.test(words[0] ?? '') && words[1] === 'orchestration' && words[2] === 'worker-start'
  })
}

/**
 * Why a worker may not start now, in words the supervisor can act on, or null when it may.
 * `since` is what the hook let through after the tick that made `state`.
 */
export function startRefusal(state: LimitState, since: { starts: number }, today: string): string | null {
  const { limits, repo } = state
  const live = state.live + since.starts
  if (limits.maxWorkers > 0 && live >= limits.maxWorkers) {
    return `${live} of ${limits.maxWorkers} workers are live in ${repo}, the most this project runs at once. Wait for one to finish (Orca wakes you with its report), then start the next. Do not retry before then.`
  }
  const starts = (state.day === today ? state.startsToday : 0) + since.starts
  if (limits.maxWorkerStartsPerDay > 0 && starts >= limits.maxWorkerStartsPerDay) {
    return `${repo} has started ${starts} workers today, its limit of ${limits.maxWorkerStartsPerDay} a day. Do not start more today: note in your chat what is left, and start it after midnight.`
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
    'Matriarch refuses a worker-start over a limit and says why. Then wait (for a worker to finish, for tomorrow,',
    'or for space) and start it later; do not retry at once, and keep the other tasks moving.'
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
  input: unknown
}

/** The hook's side: the last tick's counts per project, and the starts it let through since. */
export interface LimitsGuard {
  /** A tick's counts; what was let through before it is in them now. */
  update(state: LimitState): void
  /** Forgets projects the last tick did not see (turned off, or gone). */
  keep(repos: ReadonlySet<string>): void
  /** A reason to refuse this call, or null. Synchronous. */
  decide(call: ToolCall): { deny: string; repo: string } | null
}

export function createLimitsGuard(now: () => number = Date.now): LimitsGuard {
  const states = new Map<string, LimitState>()
  const since = new Map<string, { starts: number }>()
  /** The project whose checkout made the call: Orca names a worktree by its id or `<repo>::<path>`. */
  const projectOf = (workspaceId: string | null): LimitState | null => {
    if (!workspaceId) return null
    for (const s of states.values()) {
      const paths = [s.root, ...s.workspaces.map((w) => w.path)]
      if (s.workspaces.some((w) => w.id === workspaceId) || paths.some((p) => workspaceId === p || workspaceId.endsWith(`::${p}`))) return s
    }
    return null
  }
  return {
    update(state) {
      states.set(state.repo, state)
      since.delete(state.repo)
    },
    keep(repos) {
      for (const repo of [...states.keys()]) if (!repos.has(repo)) {
        states.delete(repo)
        since.delete(repo)
      }
    },
    decide(call) {
      if (call.tool !== 'Bash') return null
      const input = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {}
      const command = typeof input.command === 'string' ? input.command : ''
      if (!isWorkerStart(command)) return null
      const state = projectOf(call.workspaceId)
      if (!state) return null
      const extra = since.get(state.repo) ?? { starts: 0 }
      const reason = startRefusal(state, extra, dayOf(now()))
      if (reason) return { deny: reason, repo: state.repo }
      // Let through: it counts until the next tick sees the worker it started.
      since.set(state.repo, { starts: extra.starts + 1 })
      return null
    }
  }
}
