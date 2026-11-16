// One engine tick: find the opted-in repositories behind Orca's workspaces, read their PRs from
// each one's forge (GitHub or GitLab), plan each one, act when autopilot is on, record history,
// and answer the board. Every dependency is injected, so a tick runs in tests without Orca, git,
// GitHub or GitLab.
import { gb, obj, shortSha } from './values.ts'
import type { JsonValue } from 'orca/host'
import { logEntry, markEntry } from './activity.ts'
import type { Advisor } from './advisor.ts'
import type { Alert } from './alerts.ts'
import { defaultConfig, type ConfigResult, type MatriarchConfig } from './config.ts'
import { REVIEW_BRANCH_PREFIX, type Crew } from './crew.ts'
import { collectGarbage, type GcStore } from './gc.ts'
import type { Executor } from './executor.ts'
import { flakyReason } from './flaky.ts'
import { forgeKind, forgeTerms, type FailureDetails, type FileMoves, type ForgeKind, type ForgeReader, type Outcome } from './forge.ts'
import { actionableThreads, type GitHub, type PrSnapshot, type PrSummary, type RepoRef } from './github.ts'
import { followIssues } from './issues.ts'
import { addLog, addMark, historyKey, insertLog, loadHistory, noteLane, prune, windowed, type TrackHistory } from './history.ts'
import { checkKey, keepChecks, ledgerKey, loadLedger, loadRepoEscalations, pruneRepoEscalations, record, recordRefusedRerun, recordRefusedRetarget, repoEscalationsKey, repoWide, roundsUsed, withRepoEscalations, type Escalation, type PrLedger, type StackParent, type SupervisorNote } from './ledger.ts'
import { countStarts, dayOf, isWorking, loadPendingStops, loadStarts, overLimitStarts, STOP_RETRY_MS, stoppedMessage, type LimitState, type PendingStop } from './limits.ts'
import { LOCK_LABEL } from './lockdown.ts'
import type { SentReceipt, WorkerRow } from './orca-cli.ts'
import { applyReply, loadMailState, mailKey, recordSent, replyLine, takeMail, takenQuestions, type MailIdentities, type MailMessage, type MailReader } from './mailbox.ts'
import { lightPaths, MERGE_TIMEOUT_MS, plan, type Action, type Activity, type Lane, type Owner, type Plan } from './plan.ts'
import { supervisorTagPrefix } from './supervisor.ts'
import type { AdvisorView, Attention, Board, LogEntry, Mark, RepoView, TrackView } from './protocol.ts'

export interface Workspace {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

export interface RepoInfo {
  /** The project on its forge: GitHub's `owner/name`, or a GitLab host and path. */
  ref: RepoRef
  /** `owner/name` on GitHub, `<host>/<path>` on GitLab (repoKey) */
  key: string
  /** The main checkout, where `.orca/matriarch.json` is read. */
  root: string
}

export interface ActivityInfo {
  activity: Activity
  since: number
  agent: string | null
}

export interface Store {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
  /** For pruning; a store without them is never pruned (tests). */
  keys?(): Promise<string[]>
  delete?(key: string): Promise<void>
}

export interface EngineDeps {
  now(): number
  log(message: string): void
  workspaces(): Promise<Workspace[]>
  repoOf(path: string): Promise<RepoInfo | null>
  /** Null when the repository has no config, so it has not opted in. */
  readConfig(root: string): Promise<ConfigResult | null>
  /** Reads projects on GitHub. */
  github: GitHub
  /** Reads projects on GitLab; absent where there are none (tests of GitHub). */
  gitlab?: ForgeReader | null
  workers(): Promise<WorkerRow[]>
  /**
   * What agents in a workspace are doing; `path` also matches Orca's `<repoId>::<path>` ids. An
   * agent in one of the `exited` terminals (exitedTerminals) is done, whatever it last said.
   */
  activity(workspaceId: string, path?: string, exited?: ReadonlySet<string>): ActivityInfo | null
  /** The supervisor's Run mailbox for a repository (`run:<id>`), if one is known. */
  supervisor(repo: string): Promise<string | null>
  /** The id of the orchestration Run whose objective carries this tag. */
  findRun?: (tag: string) => Promise<string | null>
  /** Whether an orchestration Run still exists (Orca forgets Runs on restart). */
  runExists?: (id: string) => Promise<boolean>
  /** True only when Orca says this terminal or chat is gone (a stale handle). */
  terminalGone?: (handle: string) => Promise<boolean>
  store: Store
  executor: Executor | null
  /** Runs AI review rounds; null where there is no crew (tests of other parts). */
  crew?: Crew | null
  /** Answers the supervisor's questions for a second opinion; absent where there is none. */
  advisor?: (Pick<Advisor, 'step'> & Partial<Pick<Advisor, 'stop' | 'poll'>>) | null
  /**
   * The addresses a project's supervisor sends mail as (its chat's Orca session, its terminal, the
   * handle its Run is bound to): only questions from these reach the advisor. None when absent.
   */
  supervisorSenders?: (repo: string, run: string | null) => Promise<string[]>
  /**
   * Removes a merged PR's worktree when it is safe: answers why not (uncommitted changes, Orca
   * refused) otherwise. Absent where nothing is removed (tests of other parts).
   */
  removeWorktree?: (path: string, options?: { keepBranch?: boolean }) => Promise<{ removed: boolean; reason?: string }>
  /** The disk holding a path: the same id for every path on it, and the bytes free there; null when it cannot tell. */
  disk?: (path: string) => Promise<{ id: string; free: number } | null>
  /** Each project's workers and disk against its limits, for the hook that refuses a worker start. */
  onLimits?: (state: LimitState) => void
  /** The opted-in projects a tick saw, once it could read Orca's workspaces (not called otherwise). */
  onProjects?: (repos: string[]) => void
  /** Sends the supervisor's Run a message from Matriarch's mailbox: a labeled issue, workers stopped over a limit. */
  tellSupervisor?: (repo: string, root: string, to: string, message: { subject: string; body: string }) => Promise<SentReceipt | void>
  /**
   * Matriarch's mailbox in a project, when one exists: where replies to its mail come back. It is
   * never made here, so a project nothing was sent from gets no mailbox tab.
   */
  mailbox?: (repo: string) => Promise<string | null>
  /** Orca says this mailbox is gone: the next one asked for is made anew. */
  mailboxGone?: (repo: string, handle: string) => void
  /** Reads mailboxes (mailbox.ts); absent where nothing is read (tests of other parts). */
  mail?: MailReader | null
  /** Stops a worker that started over a limit (`orchestration worker-stop`); its worktree is kept. */
  stopWorker?: (dispatchId: string) => Promise<Outcome>
  /** Posts a comment on an issue on the project's forge. */
  commentIssue?: (ref: RepoRef, number: number, body: string) => Promise<Outcome>
  /** Posts an away alert when the person set a webhook; returns at once and never throws. */
  alert?: (alert: Alert) => void
  /** Tells the person about something that needs them, in Orca's notifications and by webhook. */
  notifyPerson?: (alert: Alert) => Promise<void>
}


interface PendingCleanup {
  path: string
  number: number
  at: number
  /** Why it was kept on the last try. */
  kept?: string
}
const CLEANUP_GIVE_UP_MS = 7 * 24 * 3600_000
/** How long a merged or closed PR stays on the board and timeline, in Merged / closed. */
export const SHOW_CLOSED_MS = 6 * 3600_000
/** How long a worktree that never became a PR stays after its last worker finished. */
export const FINISHED_GRACE_MS = 60 * 60_000
/** How long the worktree of a worker stopped over a limit is kept for its task, when no worker returns to it. */
export const STOPPED_KEEP_MS = 7 * 24 * 3600_000

/** A worktree whose worker Matriarch stopped over a limit: kept for that task until a newer worker runs there. */
interface StoppedWorktree {
  dispatchId: string
  at: number
}

/**
 * The workspace a worker row runs in. Orca names one worktree two ways: `<repoId>::<path>` in
 * orchestration and an identity (`identity:wt2:…`) in its workspace list, so a row is matched by
 * either, through its path.
 */
function workspaceOf(row: WorkerRow, workspaces: readonly Workspace[]): Workspace | undefined {
  if (!row.worktreeId) return undefined
  const sep = row.worktreeId.indexOf('::')
  const path = sep >= 0 ? row.worktreeId.slice(sep + 2) : null
  return workspaces.find((ws) => ws.id === row.worktreeId || (path !== null && ws.path === path))
}

export interface TickOptions {
  autopilot: boolean
  /** Asked before each action: false stops acting at once (the pause switch). */
  stillOn?: () => Promise<boolean>
  /** History window the board carries; default 24 hours. */
  windowMs?: number
  /** Re-read a PR's detail at least this often even when nothing changed; default 10 minutes. */
  detailMaxAgeMs?: number
}

const LANE_ORDER: Lane[] = [
  'needs-you',
  'fixing-ci',
  'fixing-conflict',
  'fixing-review',
  'fixing',
  'ai-review',
  'merging',
  'ready',
  'awaiting-ci',
  'working',
  'building',
  'draft',
  'idle',
  'merged',
  'closed'
]


/**
 * Why Matriarch does not act for a project this tick, in words for the board, or null when it
 * does: autopilot is on, there is something to act with, and the settings have no errors (a
 * config with errors may have lost a guard, such as a protected path or a reviewer).
 */
export function notActing(autopilot: boolean, deps: Pick<EngineDeps, 'executor'>, errors: readonly string[] = []): string | null {
  if (!autopilot) return 'autopilot is off'
  if (deps.executor === null) return 'Matriarch cannot act in this host'
  if (errors.length > 0) return 'the settings have errors'
  return null
}

/** The forge that reads a project, or null when this host has none for it. */
function readerFor(deps: EngineDeps, ref: RepoRef): ForgeReader | null {
  return forgeKind(ref) === 'gitlab' ? (deps.gitlab ?? null) : deps.github
}

/** An agent is busy in a workspace: working, or waiting on input or a prompt. Its worktree is not removed then. */
const agentBusy = (act: ActivityInfo | null): boolean => act !== null && ['working', 'waiting', 'blocked'].includes(act.activity)

/** A prompt in an agent's tab counts as needing you only once nobody answered it this long. */
export const PROMPT_GRACE_MS = 3 * 60_000

/** Orca reports worktree branches as full refs (`refs/heads/x`); GitHub's headRefName is `x`. */
export const branchName = (b: string | null | undefined): string | null => (b ? b.replace(/^refs\/heads\//, '') : null)

export function describe(action: Action, forge: ForgeKind = 'github'): string {
  switch (action.kind) {
    case 'send-ci-failure':
      return `send ${action.checks.length} failing check(s) to the worker (round ${action.round})`
    case 'send-rebase':
      return `ask the worker to rebase onto ${action.base} (round ${action.round})`
    case 'send-comments':
      return `send ${action.threads.length} review comment(s) to the worker (round ${action.round})`
    case 'update-branch':
      // GitLab has no API to merge the base into a branch: its worker is asked to.
      return forge === 'gitlab' && action.method === 'merge' ? 'ask the worker to merge its base in (GitLab cannot)' : `update the branch from its base (${action.method})`
    case 'start-review':
      return `start AI review round ${action.round}: ${action.reviewers.map((r) => `${r.name} (${r.agent}${r.model ? ` ${r.model}` : ''})`).join(', ')}`
    case 'send-findings':
      return `send the AI review findings to the worker (round ${action.round})`
    case 'publish-review':
      return forge === 'gitlab' ? 'post the AI review on the merge request as a note' : 'post the AI review to GitHub as a comment review'
    case 'merge':
      return `merge ${shortSha(action.sha)} (${action.method})${action.keepBranch ? `, keeping its branch while ${action.keepBranch}` : ''}`
    case 'escalate':
      return `escalate to ${action.to === 'human' ? 'you' : 'the supervisor'}: ${action.reason}`
    case 'notify':
      return `notify: ${action.title}`
    case 'retarget':
      return `move the base from ${action.from} to ${action.base}: #${action.parent}, which it was stacked on, merged`
    case 'send-restack':
      return `ask the worker to rebase onto ${action.base}, off the commits of #${action.parent}, which merged`
    case 'rerun-check':
      return `re-run ${action.checks.map((c) => c.name).join(', ')} once: ${action.why}`
  }
}

function markFor(action: Action, at: number, forge: ForgeKind = 'github'): Mark {
  switch (action.kind) {
    case 'send-ci-failure':
      return { at, kind: 'ci-sent', label: `CI failure sent (round ${action.round})` }
    case 'send-rebase':
      return { at, kind: 'rebase-sent', label: `rebase requested (round ${action.round})` }
    case 'send-comments':
      return { at, kind: 'comments-sent', label: `${action.threads.length} comment(s) sent (round ${action.round})` }
    case 'update-branch':
      return { at, kind: 'update-branch', label: forge === 'gitlab' && action.method === 'merge' ? 'worker asked to merge its base in' : 'branch updated from base' }
    case 'start-review':
      return { at, kind: 'review-start', label: `review round ${action.round} started` }
    case 'send-findings':
      return { at, kind: 'comments-sent', label: `AI review findings sent (round ${action.round})` }
    case 'publish-review':
      return { at, kind: 'notify', label: `AI review posted to ${forgeTerms(forge).name}` }
    case 'merge':
      return { at, kind: 'merge', label: `merge requested at ${shortSha(action.sha)}` }
    case 'escalate':
      return { at, kind: action.to === 'human' ? 'escalate-human' : 'escalate-supervisor', label: action.reason }
    case 'notify':
      return { at, kind: 'notify', label: action.title }
    case 'retarget':
      return { at, kind: 'update-branch', label: `base moved to ${action.base} (#${action.parent} merged)` }
    case 'send-restack':
      return { at, kind: 'rebase-sent', label: `rebase off #${action.parent} requested` }
    case 'rerun-check':
      return { at, kind: 'ci-rerun', label: `${action.checks.map((c) => c.name).join(', ')} re-run: ${action.why}` }
  }
}

function ownerFor(ws: Workspace, worker: WorkerRow | undefined, act: ActivityInfo | null): Owner | null {
  if (!worker && !act) return null
  return {
    address: worker ? `dispatch:${worker.dispatchId}` : null,
    activity: act?.activity ?? 'unknown',
    since: act?.since ?? 0,
    agent: worker?.agent ?? act?.agent ?? null,
    model: worker?.model ?? null,
    workspaceId: ws.id
  }
}

interface CachedDetail {
  snap: PrSnapshot
  rollup: string | null
  checksTag?: string | null
  baseSha?: string | null
}

/**
 * A PR's detail: the stored one while nothing it depends on moved, else read again. It depends
 * on its head, update time and CI rollup; on its base branch's head (mergeability); and, while
 * CI is failing, on each check (the planner waits for the rest to finish before reporting).
 */
async function snapshotFor(
  deps: EngineDeps,
  repo: RepoInfo,
  summary: PrSummary,
  now: number,
  maxAge: number,
  baseSha: string | null
): Promise<PrSnapshot | null> {
  const key = `snap:${repo.key}#${summary.number}`
  const cached = (await deps.store.get(key)) as CachedDetail | null
  const checksMatter = summary.rollup === 'FAILURE' || summary.rollup === 'ERROR'
  const fresh =
    cached?.snap &&
    cached.snap.headSha === summary.headSha &&
    cached.snap.updatedAt === summary.updatedAt &&
    cached.rollup === summary.rollup &&
    (!checksMatter || (cached.checksTag ?? null) === (summary.checksTag ?? null)) &&
    (cached.baseSha ?? null) === baseSha &&
    cached.snap.mergeable !== 'UNKNOWN' &&
    now - cached.snap.fetchedAt < maxAge
  if (fresh) return cached.snap
  const reader = readerFor(deps, repo.ref)
  if (!reader) return null
  const { pr } = await reader.detail(repo.ref, summary.number)
  if (pr) await deps.store.set(key, { snap: pr, rollup: summary.rollup, checksTag: summary.checksTag ?? null, baseSha } as unknown as JsonValue)
  return pr
}

/** A PR as a possible parent of a stacked one: what the head-branch index keeps. */
interface StackCandidate {
  number: number
  headRef: string
  headSha: string
  baseRef: string
}

/**
 * Branches that live on after their PRs merge (a release or integration branch), by name. A PR
 * from one is a release or a back-merge, never a parent that PRs into that branch wait for.
 */
export const LONG_LIVED_BRANCH = /^(?:main|master|trunk|develop|development|dev|staging|stage|production|prod|stable|next|releases?(?:[/-].+)?|v?\d+(?:\.(?:\d+|x))*)$/i

/** A branch a PR can be stacked on: a short-lived one, not the default branch or a long-lived one. */
export function stackableBranch(branch: string, defaultBranch: string | null): boolean {
  return branch !== '' && branch !== defaultBranch && !LONG_LIVED_BRANCH.test(branch)
}

/**
 * Whether PRs into this PR's head branch are stacked on it: a PR Matriarch follows, from a
 * short-lived branch of this repository (not a fork's), into a branch other than its own head.
 */
export function canBeParent(p: { headRef: string; baseRef: string; crossRepo?: boolean }, defaultBranch: string | null): boolean {
  return !p.crossRepo && p.headRef !== p.baseRef && stackableBranch(p.headRef, defaultBranch)
}

/**
 * The PR a PR is stacked on, as its ledger should now remember it: one whose head branch is this
 * PR's base. A parent that left the open list is looked up once, from the state Matriarch read
 * when it closed, or from the forge; a PR moved off a parent that is still open is not stacked.
 */
async function followStack(
  deps: EngineDeps,
  repo: RepoInfo,
  snap: PrSnapshot,
  ledger: PrLedger,
  open: { parents: Map<string, StackCandidate>; all: Map<number, StackCandidate> },
  closed: Map<number, PrSnapshot>,
  defaultBase: string | null
): Promise<StackParent | undefined> {
  const st = ledger.stack
  const parent = open.parents.get(snap.baseRef)
  if (parent && parent.number !== snap.number) {
    // The parent's head when this PR was first seen on it stays its fork point, however the
    // parent moves on afterwards (rebased off its own parent, amended).
    const forkSha = st?.number === parent.number ? (st.forkSha ?? st.headSha) : parent.headSha
    return { number: parent.number, headRef: parent.headRef, headSha: parent.headSha, baseRef: parent.baseRef || st?.baseRef || defaultBase || '', state: 'OPEN', forkSha }
  }
  if (!st || !canBeParent(st, defaultBase)) return undefined
  // Still open: stacked while this PR points at its branch; moved off it, not stacked any more.
  const still = open.all.get(st.number)
  if (still) return still.headRef === snap.baseRef ? { ...st, headSha: still.headSha } : undefined
  if (st.state !== 'OPEN') return st
  const kept = closed.get(st.number) ?? ((await deps.store.get(`snap:${repo.key}#${st.number}`)) as { snap?: PrSnapshot } | null)?.snap
  const reader = readerFor(deps, repo.ref)
  const final = kept && kept.state !== 'OPEN' ? kept : reader ? (await reader.detail(repo.ref, st.number).catch(() => ({ pr: null }))).pr : null
  if (!final || final.state === 'OPEN') return st
  const next: StackParent = { ...st, headSha: final.headSha || st.headSha, baseRef: final.baseRef || st.baseRef, state: final.state }
  if (final.state !== 'MERGED') return next
  // A merge commit or a fast-forward keeps the commits this PR was built on: then it only needs
  // to catch up with the base, not to be rebased off them. Asked once, as the merge is first seen.
  const forkInBase = reader?.isAncestor ? await reader.isAncestor(repo.ref, st.forkSha ?? st.headSha, next.baseRef).catch(() => null) : null
  return { ...next, headAtMerge: snap.headSha, ...(forkInBase === true ? { forkInBase: true } : {}) }
}

/** Where a PR's failed-job log tails are kept, read when its failures were judged (one commit's). */
export const ciLogsKey = (repo: string, number: number): string => `ci-logs:${repo}#${number}`

/** The log tails kept for a PR: its head commit's, by check name, with the job each came from. */
interface CiLogs {
  sha: string
  logs: Record<string, { jobId: number | null; tail: string }>
}

/**
 * Failed checks on a PR's head, read once per commit and check to tell a flaky failure from a
 * real one (flaky.ts), so the planner can re-run a flaky one before a worker spends a round on it.
 * Only before the failure went to the worker, and once every check finished. The log tails read
 * for it are kept with the job they came from, so the worker's message reuses them.
 */
async function judgeFailures(deps: EngineDeps, repo: RepoInfo, snap: PrSnapshot, ledger: PrLedger, config: MatriarchConfig): Promise<PrLedger> {
  const sha = snap.headSha
  if (!config.fix.ci.rerunFlaky || snap.ci !== 'failing' || ledger.ci[sha] || snap.checks.some((c) => c.state === 'pending')) return ledger
  const todo = snap.checks.filter((c) => c.state === 'failure' && c.jobId !== null && ledger.flaky?.[checkKey(sha, c.name)] === undefined && !ledger.reruns?.[checkKey(sha, c.name)])
  const reader = readerFor(deps, repo.ref)
  if (todo.length === 0 || !reader?.failureDetails) return ledger
  // A check the forge said nothing about (past the first few, no log, or the read failed) counts
  // as a real failure: each gets a verdict, so none is read again on every tick.
  const read: FailureDetails = await reader.failureDetails(repo.ref, todo).catch(() => ({ details: {}, logs: {} }))
  const judged = todo.map((c): [string, string | null] => [checkKey(sha, c.name), flakyReason(read.details[c.name] ?? '')])
  const key = ciLogsKey(repo.key, snap.number)
  const kept = ((await deps.store.get(key)) as CiLogs | null) ?? null
  const logs: CiLogs = { sha, logs: kept?.sha === sha ? { ...kept.logs } : {} }
  for (const c of todo) if (read.logs[c.name] !== undefined) logs.logs[c.name] = { jobId: c.jobId, tail: read.logs[c.name] }
  await deps.store.set(key, logs as unknown as JsonValue)
  return { ...ledger, flaky: keepChecks(ledger.flaky ?? {}, sha, judged) }
}

/**
 * The kept log tails that still describe the PR's failed checks: of its head commit, and of the
 * same job (a check re-run after a flaky failure is another job, whose log was not read).
 */
async function keptLogs(deps: EngineDeps, repo: RepoInfo, snap: PrSnapshot): Promise<Record<string, string>> {
  const kept = (await deps.store.get(ciLogsKey(repo.key, snap.number))) as CiLogs | null
  if (!kept || kept.sha !== snap.headSha) return {}
  const out: Record<string, string> = {}
  for (const c of snap.checks) {
    const k = kept.logs[c.name]
    if (c.state === 'failure' && k && k.jobId === c.jobId) out[c.name] = k.tail
  }
  return out
}

/** An advisor waiting on a prompt, under Needs you with the terminal to open. */
function advisorAttention(repo: string, advisor: AdvisorView): Board['attention'][number] | null {
  if (!advisor.answering?.blocked) return null
  return {
    key: `${repo}:advisor`,
    repo,
    message: `${repo}: the advisor (${advisor.agent}) needs you. ${advisor.answering.blocked}.`,
    terminal: advisor.answering.terminal ?? undefined,
    workspaceId: advisor.answering.workspaceId ?? undefined
  }
}

/** How long an alerted Needs-you item must be gone from the board before it can alert again. */
export const ATTENTION_CLEAR_MS = 15 * 60_000

/**
 * Tells the person, in Orca and by webhook, about each board item marked `alert` (one that no
 * escalation or notice carries: a nearly full disk, workers over a limit, issues waiting for a
 * supervisor, a handoff that may not have arrived), once while it stands. Only while Matriarch
 * acts, like every alert; one first seen in dry run alerts once autopilot is on. It may alert
 * again once it has been gone for ATTENTION_CLEAR_MS, so a read that fails for a tick does not
 * ring twice. Storage is written only when an item comes or goes.
 */
async function alertAttention(deps: EngineDeps, board: Board, now: number, acting: boolean): Promise<void> {
  if (!deps.notifyPerson) return
  const key = 'attention:alerted'
  const before = ((await deps.store.get(key)) as Record<string, { at: number; gone?: number }> | null) ?? {}
  const after: Record<string, { at: number; gone?: number }> = {}
  const standing = new Map(board.attention.filter((a) => a.alert).map((a) => [a.key, a]))
  for (const [k, rec] of Object.entries(before)) {
    if (standing.has(k)) after[k] = { at: rec.at }
    else if (rec.gone === undefined) after[k] = { at: rec.at, gone: now }
    else if (now - rec.gone < ATTENTION_CLEAR_MS) after[k] = rec
  }
  for (const [k, a] of standing) {
    if (after[k] || !acting) continue
    try {
      await deps.notifyPerson({ kind: 'needs-you', title: a.repo ? `Matriarch: ${a.repo} needs you` : 'Matriarch needs you', body: a.message, ...(a.repo ? { repo: a.repo } : {}) })
      after[k] = { at: now }
    } catch (error) {
      deps.log(`could not tell you about ${k}: ${(error as Error).message}`)
    }
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) await deps.store.set(key, after as unknown as JsonValue)
}

/**
 * A nearly full disk on the board: one item for the disk, naming each project on it whose floor
 * it is under, so a project that shares the disk is not left out and a second disk is not hidden
 * behind the first. Keyed by the disk, so a changing free figure does not alert again.
 */
export function diskAttention(id: string, free: number, repos: readonly string[]): Attention {
  const names = [...repos].sort()
  const named = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return {
    key: `disk:${id}`,
    ...(names.length === 1 ? { repo: names[0] } : { repos: names }),
    alert: true,
    message: `Only ${gb(free)} free on the disk with ${named}. Agents' builds, Orca and Matriarch stop saving once it is full: free some space to keep the pod moving.`
  }
}

/** A failed read of a PR's file moves is tried again after this; an answer is kept for the commit. */
export const MOVES_RETRY_MS = 10 * 60_000

/**
 * A PR whose forge cannot say which files were renamed (GitLab), and that would otherwise be a
 * light change: its files read one by one, once per commit, so a renamed file and the path it
 * came from are judged as on GitHub. Without an answer it stays as it was, and gets the full crew.
 */
async function withFileMoves(deps: EngineDeps, repo: RepoInfo, config: ConfigResult['config'], snap: PrSnapshot, now: number, baseSha: string | null): Promise<PrSnapshot> {
  const reader = readerFor(deps, repo.ref)
  if (snap.renamed !== null && snap.renamed !== undefined) return snap
  if (!reader?.fileMoves || !config.review.enabled || snap.state !== 'OPEN' || !lightPaths(config, snap)) return snap
  const key = `moves:${repo.key}#${snap.number}`
  // A diff is between the head and the base: a stacked PR moved onto another base, or a base that
  // moved on, has other files moved even with the same head.
  const cached = (await deps.store.get(key)) as { sha?: string; base?: string; baseSha?: string | null; moves?: FileMoves | null; at?: number } | null
  const same = cached?.sha === snap.headSha && cached.base === snap.baseRef && (cached.baseSha ?? null) === baseSha
  let moves: FileMoves | null
  if (same && (cached!.moves || now - (cached!.at ?? 0) < MOVES_RETRY_MS)) moves = cached!.moves ?? null
  else {
    moves = await reader.fileMoves(repo.ref, snap.number).catch(() => null)
    await deps.store.set(key, { sha: snap.headSha, base: snap.baseRef, baseSha, moves, at: now } as unknown as JsonValue)
  }
  if (!moves) return snap
  return { ...snap, renamed: moves.renamed, files: [...new Set([...snap.files, ...moves.paths])] }
}

function toNumbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []
}

/** What one tick knows before it looks at each project: set once, read by every project's steps. */
interface TickContext {
  deps: EngineDeps
  opts: TickOptions
  board: Board
  now: number
  since: number
  maxAge: number
  /** Marks for each PR's timeline from review rounds that finished this tick, by `repo#n`. */
  crewMarks: Map<string, Mark[]>
  workers: WorkerRow[]
  /** Orca's worker list could be read: without it every owned PR would look orphaned. */
  ownersKnown: boolean
  /** When the worker list was asked for: a worker started after this may not be in it yet. */
  workersAt: number
  byWorktree: { get(ws: Workspace): WorkerRow | undefined }
  /** Projects whose advisor this tick stepped or stopped; the others are polled after the loop. */
  advised: Set<string>
  /** Each disk under some project's floor, by its id: the least seen free on it, and those projects. */
  lowDisks: Map<string, { free: number; repos: string[] }>
}

/** A PR this tick plans for: its snapshot, its ledger, and its worktree when it has one here. */
interface TickItem {
  snap: PrSnapshot
  ledger: PrLedger
  ws: Workspace | undefined
}

/** One project's part of a tick, filled in step by step (each step says what it adds). */
interface ProjectTick {
  t: TickContext
  info: RepoInfo
  repoKey: string
  repoWorkspaces: Workspace[]
  cfg: ConfigResult
  config: MatriarchConfig
  kind: ForgeKind
  terms: ReturnType<typeof forgeTerms>
  forge: ForgeReader | null
  supervisor: string | null
  pending: { tag?: string; at?: number } | null
  view: RepoView
  free: number | null
  limits: MatriarchConfig['limits']
  lowDisk: boolean
  whyNot: string | null
  acting: boolean
  byBranch: Map<string, Workspace>
  /** The project's repository-wide escalations (ledger.ts repoWide): one record every PR's plan reads. */
  repoEscalations: Record<string, Escalation>
  // readMail
  /** Questions for the advisor not stored by it yet: this tick's, and any a failure kept pending. */
  questions: MailMessage[]
  /** Replies to Matriarch's mail, by the PR they are about: for that PR's log this tick. */
  mailLog: Map<number, LogEntry[]>
  // holdLimits
  live: number
  startsToday: number
  stoppedWorktrees: Record<string, StoppedWorktree>
  // listPrs
  summaries: PrSummary[]
  viewer: string
  listed: boolean
  base: { name: string; sha: string | null; rollup: string | null } | null
  truncatedList: boolean
  detailAge: number
  follows: (s: PrSummary, who: string) => boolean
  unknownWs: Set<string>
  // readOpenPrs
  trackedKey: string
  tracked: number[]
  open: Set<number>
  items: TickItem[]
  mergeBusy: Set<string>
  runningReviews: number
  // the cleanups
  gone: Set<string>
  cleanedUp: Map<number, LogEntry>
  // prepareTracks
  seenWorkspaces: Set<string>
  firstOn: Map<string, number>
  openStack: { parents: Map<string, StackCandidate>; all: Map<number, StackCandidate> }
  closedSnaps: Map<number, PrSnapshot>
}

/** One engine tick: every opted-in project, step by step, then what is looked after across them. */
export async function tick(deps: EngineDeps, opts: TickOptions): Promise<Board> {
  const now = deps.now()
  const since = now - (opts.windowMs ?? 24 * 3600_000)
  const board: Board = { ready: true, at: now, autopilot: opts.autopilot, since, repos: [], tracks: [], attention: [], errors: [], rate: null }
  const crewMarks = await pollCrew(deps, board, now)
  const workspaces = await listWorkspaces(deps, board)
  if (!workspaces) return board
  const repos = await groupByProject(deps, workspaces)
  const t: TickContext = { deps, opts, board, now, since, maxAge: opts.detailMaxAgeMs ?? 10 * 60_000, crewMarks, ...(await indexWorkers(deps, board)), advised: new Set(), lowDisks: new Map() }
  for (const [repoKey, { info, workspaces: repoWorkspaces }] of repos) await tickProject(t, repoKey, info, repoWorkspaces)
  await afterProjects(t, workspaces)
  board.tracks.sort(
    (a, b) =>
      LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) ||
      a.repo.localeCompare(b.repo) ||
      (a.pr?.number ?? Infinity) - (b.pr?.number ?? Infinity) ||
      a.workspace.name.localeCompare(b.workspace.name)
  )
  return board
}

/** Review rounds that finished since the last tick update their PR's ledger first, so the planner sees the crew's outcome. */
async function pollCrew(deps: EngineDeps, board: Board, now: number): Promise<Map<string, Mark[]>> {
  const crewMarks = new Map<string, Mark[]>()
  const finished = deps.crew ? await deps.crew.poll().catch((error: Error) => (board.errors.push(`Review crew: ${error.message}`), [])) : []
  for (const run of finished) {
    const key = ledgerKey(run.repo, run.number)
    const l = loadLedger(await deps.store.get(key))
    const prior = l.reviews[run.sha] ?? { round: run.round, status: 'running' as const, startedAt: run.startedAt }
    l.reviews[run.sha] = {
      ...prior,
      round: run.round,
      status: run.status === 'done' ? 'done' : 'failed',
      endedAt: run.endedAt ?? now,
      ...(run.outcome ? { verdict: run.outcome.verdict, findings: run.outcome.blocking.length } : {})
    }
    await deps.store.set(key, l as unknown as JsonValue)
    const label = run.outcome ? run.outcome.summary : `review crew failed: ${run.error ?? 'unknown'}`
    crewMarks.set(`${run.repo}#${run.number}`, [...(crewMarks.get(`${run.repo}#${run.number}`) ?? []), { at: now, kind: 'review-done', label }])
  }
  return crewMarks
}

/** Orca's workspaces on this machine, without review worktrees; null when Orca could not say. */
async function listWorkspaces(deps: EngineDeps, board: Board): Promise<Workspace[] | null> {
  let workspaces: Workspace[]
  try {
    // Plugins run git on this machine, so workspaces on SSH hosts or paired servers are skipped.
    // Orca labels this machine's workspaces `hostId: "local"`.
    workspaces = (await deps.workspaces()).filter(
      (w) => (!w.hostId || w.hostId === 'local') && !(branchName(w.branch) ?? '').startsWith(REVIEW_BRANCH_PREFIX)
    )
  } catch (error) {
    board.errors.push(`Could not list Orca workspaces: ${(error as Error).message}`)
    return null
  }
  return workspaces
}

/** The workspaces by the project they belong to. */
async function groupByProject(deps: EngineDeps, workspaces: readonly Workspace[]): Promise<Map<string, { info: RepoInfo; workspaces: Workspace[] }>> {
  const repos = new Map<string, { info: RepoInfo; workspaces: Workspace[] }>()
  for (const ws of workspaces) {
    const info = await deps.repoOf(ws.path).catch(() => null)
    if (!info) continue
    const entry = repos.get(info.key) ?? { info, workspaces: [] }
    entry.workspaces.push(ws)
    repos.set(info.key, entry)
  }
  return repos
}

/** Orca's supervised workers, and each worktree's current one. */
async function indexWorkers(deps: EngineDeps, board: Board): Promise<Pick<TickContext, 'workers' | 'ownersKnown' | 'workersAt' | 'byWorktree'>> {
  let workers: WorkerRow[] = []
  // Without the worker list every owned PR would look orphaned: send nothing to workers then.
  let ownersKnown = true
  // When the list was asked for: a worker started after this may not be in it yet.
  const workersAt = deps.now()
  try {
    // Copies: a worker stopped this tick is marked so for the rest of it.
    workers = (await deps.workers()).map((w) => ({ ...w }))
  } catch (error) {
    ownersKnown = false
    board.errors.push(`Can't see Orca's workers (${(error as Error).message}); nothing goes to workers until it is back.`)
  }
  // worker-list is newest first: a worktree's current worker is its newest live one, else its
  // newest row (a failed attempt says what happened when nothing replaced it).
  // Orca names one worktree two ways: `<repoId>::<path>` in orchestration and an identity
  // (`identity:wt2:…`) in its workspace list. A worker is found by either, through its path.
  const workerKeys = new Map<string, WorkerRow>()
  for (const w of workers) {
    if (!w.worktreeId) continue
    const sep = w.worktreeId.indexOf('::')
    for (const key of sep >= 0 ? [w.worktreeId, `path:${w.worktreeId.slice(sep + 2)}`] : [w.worktreeId]) {
      const had = workerKeys.get(key)
      if (!had || (had.live === false && w.live !== false)) workerKeys.set(key, w)
    }
  }
  const byWorktree = { get: (ws: Workspace): WorkerRow | undefined => workerKeys.get(ws.id) ?? workerKeys.get(`path:${ws.path}`) }
  return { workers, ownersKnown, workersAt, byWorktree }
}

/**
 * The terminals of workers Orca saw exit that no other worker it lists still runs in (a handle
 * may be handed on). An agent that was stopped or crashed never says it is done, so its pane's
 * last "working" would stand for a day, holding its worktree's PR in Working even after a later
 * worker there finished. Read from the rows as they stand: a worker stopped this tick is exited.
 */
function exitedTerminals(workers: readonly WorkerRow[]): Set<string> {
  const exited = new Set<string>()
  const running = new Set<string>()
  // Only Orca's word counts: a worker it cannot vouch for (`unverifiable`, or not said) may still run.
  for (const w of workers) if (w.terminal) (w.liveness === 'exited' ? exited : running).add(w.terminal)
  for (const t of running) exited.delete(t)
  return exited
}

/**
 * What the agents in a worktree are doing, an agent of a worker Orca saw exit being done. While the
 * worker list could not be read, each agent is taken at its word.
 */
function activityOf(t: TickContext, ws: Workspace): ActivityInfo | null {
  return t.deps.activity(ws.id, ws.path, t.ownersKnown ? exitedTerminals(t.workers) : undefined)
}

/** One project's whole part of the tick, in order. */
async function tickProject(t: TickContext, repoKey: string, info: RepoInfo, repoWorkspaces: Workspace[]): Promise<void> {
  const cfg = await readProjectConfig(t, repoKey, info)
  if (!cfg) return
  const proj = await openProject(t, repoKey, info, repoWorkspaces, cfg)
  await holdLimits(proj)
  await readMail(proj)
  await handIssues(proj)
  await listPrs(proj)
  await stepAdvisor(proj)
  await readOpenPrs(proj)
  await readClosedPrs(proj)
  await cleanupMergedWorktrees(proj)
  await cleanupFinishedWorktrees(proj)
  prepareTracks(proj)
  for (const item of proj.items) await planAndAct(proj, item)
  await deleteKeptBranches(proj)
  await logLeftoverCleanups(proj)
  await logLeftoverReplies(proj)
  await worktreeTracks(proj)
}

/** The project's settings; null when it has none (Matriarch is off there), after stopping its advisor. */
async function readProjectConfig(t: TickContext, repoKey: string, info: RepoInfo): Promise<ConfigResult | null> {
  const { deps, advised } = t
  let cfg: ConfigResult | null
  try {
    cfg = await deps.readConfig(info.root)
  } catch (error) {
    cfg = { config: defaultConfig(), errors: [`Could not read config: ${(error as Error).message}`], warnings: [] }
  }
  if (!cfg) {
    // Matriarch is off here: an advisor still answering for it stops, and its worktree goes.
    advised.add(repoKey)
    if (deps.advisor?.stop) {
      await deps.advisor
        .stop({ repo: repoKey, root: info.root, supervisor: () => deps.supervisor(repoKey) })
        .catch((error: Error) => deps.log(`${repoKey}: could not stop the advisor: ${error.message}`))
    }
    return null
  }
  return cfg
}

/** The project as the tick starts on it: its settings and forge, its supervisor, its board row, disk and whether Matriarch acts. */
async function openProject(t: TickContext, repoKey: string, info: RepoInfo, repoWorkspaces: Workspace[], cfg: ConfigResult): Promise<ProjectTick> {
  const { deps, opts, board, now, workers } = t
  const config = cfg.config
  const kind = forgeKind(info.ref)
  const terms = forgeTerms(kind)
  const forge = readerFor(deps, info.ref)
  // The supervisor's Run: known, or found by the tag the launcher put in its objective.
  let supervisor = await deps.supervisor(repoKey).catch(() => null)
  // A Run Orca no longer knows is no supervisor: forget the link.
  if (supervisor && deps.runExists && !(await deps.runExists(supervisor.replace(/^run:/, '')).catch(() => true))) {
    await deps.store.set(`supervisor:${repoKey}`, '')
    supervisor = null
  }
  let pending = (await deps.store.get(`supervisor:pending:${repoKey}`)) as { tag?: string; at?: number } | null
  // A chat that never created its Run (closed, abandoned) stops counting as "starting" after 6 h.
  if (pending?.tag && !supervisor && now - (pending.at ?? 0) > 6 * 3600_000) {
    await deps.store.set(`supervisor:pending:${repoKey}`, null)
    pending = null
  }
  if (!supervisor && deps.findRun) {
    // The Run of the chat that was started, by its tag; else any supervisor Run of this
    // project, so a tag that was lost (a restart, a cleared link) cannot orphan its Run.
    const run = await deps.findRun(pending?.tag ?? supervisorTagPrefix(repoKey)).catch(() => null)
    if (run) {
      supervisor = `run:${run}`
      await deps.store.set(`supervisor:${repoKey}`, supervisor)
    }
  }
  // A supervisor chat Orca says is gone cannot be opened; one that never created its Run is
  // not starting anything either. Forget it, so the board offers a new chat.
  const chat = (await deps.store.get(`supervisor:terminal:${repoKey}`)) as string | null
  if (chat && deps.terminalGone && (await deps.terminalGone(chat).catch(() => false))) {
    await deps.store.set(`supervisor:terminal:${repoKey}`, null)
    if (!supervisor && pending?.tag) {
      await deps.store.set(`supervisor:pending:${repoKey}`, null)
      pending = null
    }
  }
  const view: RepoView = {
    repo: repoKey,
    ...(kind === 'gitlab' ? { forge: kind } : {}),
    root: info.root,
    mergeMode: config.merge.mode,
    supervisor: {
      agent: config.supervisor.agent,
      model: config.supervisor.model ?? null,
      run: supervisor,
      pending: Boolean(pending?.tag && !supervisor),
      terminal: ((await deps.store.get(`supervisor:terminal:${repoKey}`)) as string | null) ?? null,
      workers: supervisor ? workers.filter((w) => w.runId !== null && `run:${w.runId}` === supervisor).length : 0,
      maxWorkers: config.limits.maxWorkers,
      maxStarts: config.limits.maxWorkerStartsPerDay
    },
    errors: [...cfg.errors],
    warnings: [...cfg.warnings]
  }
  board.repos.push(view)
  // A nearly full disk stalls builds, Orca's saves and Matriarch's own, with nothing on screen:
  // one notice per disk once every project had its turn (diskAttention). The same floor stops
  // the supervisor starting workers.
  const disk = deps.disk ? await deps.disk(info.root).catch(() => null) : null
  const free = disk?.free ?? null
  const limits = config.limits
  const lowDisk = disk !== null && limits.minFreeDiskGB > 0 && disk.free < limits.minFreeDiskGB * 1024 ** 3
  if (lowDisk) {
    const low = t.lowDisks.get(disk.id)
    t.lowDisks.set(disk.id, { free: Math.min(low?.free ?? disk.free, disk.free), repos: [...(low?.repos ?? []), repoKey] })
  }
  // A config with errors may have lost a guard (a protected path, a reviewer): watch only.
  const whyNot = notActing(opts.autopilot, deps, cfg.errors)
  const acting = whyNot === null
  if (opts.autopilot && cfg.errors.length > 0) view.errors.push('The config has errors, so Matriarch only watches this repository until they are fixed.')
  const byBranch = new Map<string, Workspace>()
  for (const ws of repoWorkspaces) {
    const name = branchName(ws.branch)
    if (name && !byBranch.has(name)) byBranch.set(name, ws)
  }
  return {
    t, info, repoKey, repoWorkspaces, cfg, config, kind, terms, forge, supervisor, pending, view, free, limits, lowDisk, whyNot, acting, byBranch,
    repoEscalations: pruneRepoEscalations(loadRepoEscalations(await deps.store.get(repoEscalationsKey(repoKey))), now),
    questions: [], mailLog: new Map(),
    live: 0, startsToday: 0, stoppedWorktrees: {},
    summaries: [], viewer: '', listed: false, base: null, truncatedList: false, detailAge: t.maxAge, follows: () => false, unknownWs: new Set(),
    trackedKey: `tracked:${repoKey}`, tracked: [], open: new Set(), items: [], mergeBusy: new Set(), runningReviews: 0,
    // Worktrees removed this tick: gone from here on, so no PR or row writes to their history again.
    gone: new Set(),
    // The log line for a merged PR's removed worktree, written after that PR's lane this tick.
    cleanedUp: new Map(),
    seenWorkspaces: new Set(), firstOn: new Map(), openStack: { parents: new Map(), all: new Map() }, closedSnaps: new Map()
  }
}

/**
 * The project's mail (mailbox.ts): questions for the advisor kept for its step, and each reply to
 * Matriarch's mail marked on its PR: a note, an escalation it answers, a line in its log. It only
 * reads, so it happens in dry run too. Adds questions, mailLog.
 */
async function readMail(proj: ProjectTick): Promise<void> {
  const { deps, now, workers } = proj.t
  const { repoKey, supervisor, view } = proj
  if (!deps.mail || !deps.mailbox) return
  const address = await deps.mailbox(repoKey).catch(() => null)
  if (!address) return
  const key = mailKey(repoKey)
  const before = loadMailState(await deps.store.get(key))
  // Who a Run's agents are, by the addresses Orca stores for a sender: its supervisor as Matriarch
  // knows it, and its workers from Orca's worker list.
  const ids: MailIdentities = {
    supervisorsOf: async (run) => (deps.supervisorSenders ? deps.supervisorSenders(repoKey, run) : []),
    workersOf: (run) =>
      new Set(workers.filter((w) => w.runId !== null && `run:${w.runId}` === run).flatMap((w) => [`dispatch:${w.dispatchId}`, ...(w.terminal ? [w.terminal] : [])]))
  }
  const taken = await takeMail({ reader: deps.mail, address, state: before, supervisor, ids, now, log: (m) => deps.log(`${repoKey}: ${m}`) })
  if (taken.gone) {
    // Closed, or lost in a restart: the next send makes a new one, and the supervisor is told.
    deps.mailboxGone?.(repoKey, address)
    return
  }
  // Every question not yet stored by the advisor: this tick's, and any a failure kept pending.
  proj.questions = [...taken.state.pending]
  for (const who of taken.strangers) {
    view.warnings.push(`Another chat (${who}) replied to Matriarch's mail to the supervisor's Run. It is not taken as the supervisor: its replies are logged, and answer no escalation.`)
  }
  const byPr = new Map<number, LogEntry[]>()
  const note = (number: number, entry: LogEntry) => byPr.set(number, [...(byPr.get(number) ?? []), entry])
  let shared = proj.repoEscalations
  for (const reply of taken.replies) {
    const { sent, message, who } = reply
    if (sent.number === undefined) {
      deps.log(`${repoKey}: ${who === 'other' ? `${message.from ?? 'someone'}` : `the ${who}`} replied to "${sent.subject}": ${replyLine(message.body, 200)}`)
      continue
    }
    const lk = ledgerKey(repoKey, sent.number)
    const ledger = loadLedger(await deps.store.get(lk))
    const out = applyReply(ledger, reply, now, shared)
    if (JSON.stringify(out.ledger) !== JSON.stringify(ledger)) await deps.store.set(lk, out.ledger as unknown as JsonValue)
    shared = out.shared
    if (out.answered) deps.log(`${repoKey} #${sent.number}: the supervisor answered the escalation ${out.answered}`)
    note(sent.number, out.entry)
  }
  for (const { message, number, who } of taken.loose) {
    // Its thread is gone from Orca: shown where it belongs, and nothing more is made of it.
    note(number, { at: message.at || now, kind: 'reply', from: who, text: `The ${who} wrote about this PR: ${replyLine(message.body, 240)}`, subject: message.subject })
  }
  if (JSON.stringify(shared) !== JSON.stringify(proj.repoEscalations)) await saveRepoEscalations(proj, shared)
  proj.mailLog = byPr
  if (JSON.stringify(taken.state) === JSON.stringify(before)) return
  try {
    await deps.store.set(key, taken.state as unknown as JsonValue)
  } catch (error) {
    view.errors.push(`Could not save what Matriarch read from its mailbox: ${(error as Error).message}`)
  }
}

/** The project's repository-wide escalations, kept and saved. */
async function saveRepoEscalations(proj: ProjectTick, next: Record<string, Escalation>): Promise<void> {
  proj.repoEscalations = next
  await proj.t.deps.store.set(repoEscalationsKey(proj.repoKey), next as unknown as JsonValue)
}

/**
 * Replies about a PR that is not on the board this tick (the forge's list failed, say): they go to
 * its log where its card reads it, the worktree's history when that is the PR's, else its own.
 */
async function logLeftoverReplies(proj: ProjectTick): Promise<void> {
  const { deps } = proj.t
  for (const [number, entries] of proj.mailLog) {
    let owner: string | null = null
    for (const ws of proj.repoWorkspaces) {
      if (loadHistory(await deps.store.get(historyKey(ws.id))).pr === number) {
        owner = ws.id
        break
      }
    }
    const key = historyKey(owner ?? `pr:${proj.repoKey}#${number}`)
    let history = loadHistory(await deps.store.get(key))
    for (const e of entries) history = insertLog(history, e)
    await deps.store.set(key, history as unknown as JsonValue)
  }
  proj.mailLog.clear()
}

/**
 * The reply the card shows: the latest one since the PR's head commit was first seen, so a week-old
 * answer about an earlier state of the PR does not sit on it; without that time, a day's worth.
 */
function currentNote(ledger: PrLedger, headSha: string, now: number): SupervisorNote | null {
  const since = ledger.heads[headSha] ?? now - 24 * 3600_000
  return ledger.notes?.filter((n) => n.at >= since).at(-1) ?? null
}

/** A reply as the card shows it: who, when, and its first lines. */
function noteView(n: SupervisorNote): { at: number; from: 'supervisor' | 'worker'; text: string } {
  return { at: n.at, from: n.from, text: replyLine(n.text, 300) }
}

/** The supervisor's workers against the limits: counted, over-limit starts stopped, the hook told. Adds live, startsToday, stoppedWorktrees. */
async function holdLimits(proj: ProjectTick): Promise<void> {
  const { deps, opts, board, now, workers, ownersKnown, workersAt, byWorktree } = proj.t
  const { repoKey, info, repoWorkspaces, supervisor, view, free, limits, acting } = proj
  // The supervisor's workers against the limits (limits.ts): on its row, and to the hook that
  // refuses a start over one. A start counts once Matriarch first sees its worker in the Run's
  // list; under autopilot, a worker whose start put the project over a limit is stopped.
  const mine = supervisor ? workers.filter((w) => w.runId !== null && `run:${w.runId}` === supervisor) : []
  const prevStarts = loadStarts(await deps.store.get(`starts:${repoKey}`))
  let starts = prevStarts
  let fresh: WorkerRow[] = []
  if (ownersKnown && supervisor) {
    // A Run seen for the first time has no fresh workers: when they started cannot be told.
    const known = prevStarts?.run === supervisor ? new Set(prevStarts.seen) : null
    fresh = known ? mine.filter((w) => !known.has(w.dispatchId)) : []
    starts = countStarts(prevStarts, supervisor, mine.map((w) => w.dispatchId), now)
  }
  let live = mine.filter(isWorking).length
  const counted = starts && starts.day === dayOf(now) ? starts.count : 0
  const over = overLimitStarts(fresh, { repo: repoKey, runningBefore: live - fresh.filter(isWorking).length, startsBefore: counted - fresh.length, freeBytes: free, limits })
  // A stop that did not go through is tried again while its worker still runs.
  const stopsKey = `overlimit:${repoKey}`
  const pendingRaw = await deps.store.get(stopsKey)
  const retrying = ownersKnown
    ? loadPendingStops(pendingRaw).filter((p) => now - p.at < STOP_RETRY_MS && mine.some((w) => w.dispatchId === p.dispatchId && isWorking(w)))
    : loadPendingStops(pendingRaw)
  const toStop: PendingStop[] = [...retrying, ...over.filter((o) => !retrying.some((p) => p.dispatchId === o.dispatchId)).map((o) => ({ ...o, at: now }))]
  const stopped: PendingStop[] = []
  const unstopped: PendingStop[] = []
  if (toStop.length > 0 && acting && deps.stopWorker) {
    for (const o of toStop) {
      if (opts.stillOn && !(await opts.stillOn().catch(() => false))) {
        unstopped.push(o)
        continue
      }
      const res = await deps.stopWorker(o.dispatchId).catch((error: Error) => ({ ok: false, error: error.message }))
      if (res.ok) stopped.push(o)
      else {
        unstopped.push(o)
        view.errors.push(`Could not stop worker dispatch:${o.dispatchId}, which started over a limit: ${res.error ?? 'failed'}`)
      }
    }
    if (stopped.length > 0) {
      deps.log(`${repoKey}: stopped ${stopped.map((o) => `dispatch:${o.dispatchId}`).join(', ')}, started over a limit`)
      const keptKey = `stopped:${repoKey}`
      const kept = ((await deps.store.get(keptKey)) as Record<string, StoppedWorktree> | null) ?? {}
      for (const o of stopped) {
        const row = mine.find((w) => w.dispatchId === o.dispatchId)
        // Stopped: for the rest of this tick nothing is sent to it, and its PR's worker counts as gone.
        if (row) Object.assign(row, { live: false, liveness: 'exited', state: 'stopped' })
        const ws = row ? workspaceOf(row, repoWorkspaces) : undefined
        if (!ws) continue
        // Its worktree's log says why its worker ended, and the worktree stays for its task.
        const key = historyKey(ws.id)
        const entry = { at: now, kind: 'stop-worker', text: `Stopped this worktree's worker, which started over a limit: ${o.reason}` }
        await deps.store.set(key, addLog(loadHistory(await deps.store.get(key)), entry) as unknown as JsonValue)
        kept[ws.path] = { dispatchId: o.dispatchId, at: now }
      }
      await deps.store.set(keptKey, kept as unknown as JsonValue)
      view.warnings.push(...stopped.map((o) => `Stopped worker dispatch:${o.dispatchId}${o.taskId ? ` (task ${o.taskId})` : ''}: ${o.reason}`))
      if (deps.tellSupervisor && supervisor) {
        const m = stoppedMessage(stopped)
        await deps.tellSupervisor(repoKey, info.root, supervisor, m)
          .then((receipt) => (receipt ? recordSent(deps.store, repoKey, receipt, { at: now, to: supervisor, subject: m.subject, kind: 'stop' }) : undefined))
          .catch((error: Error) => view.errors.push(`Stopped workers that started over a limit, but could not tell the supervisor: ${error.message}`))
      }
      // A stopped worker takes no room, and its start does not count against today.
      live -= stopped.length
      const today = stopped.filter((o) => dayOf(o.at) === dayOf(now)).length
      if (starts && today > 0) starts = { ...starts, count: Math.max(0, starts.count - today) }
    }
  } else if (toStop.length > 0) {
    view.warnings.push(
      ...toStop.map((o) =>
        acting
          ? `Worker dispatch:${o.dispatchId} started over a limit, and Matriarch cannot stop workers here: ${o.reason}`
          : `Dry run: with autopilot on, Matriarch would stop worker dispatch:${o.dispatchId}: ${o.reason}`
      )
    )
  }
  // A stopped worker's worktree is kept for its task, as the supervisor was told, until a newer
  // worker runs there, the worktree is gone, or a week passed.
  const keptKey = `stopped:${repoKey}`
  const keptBefore = ((await deps.store.get(keptKey)) as Record<string, StoppedWorktree> | null) ?? {}
  const stoppedWorktrees: Record<string, StoppedWorktree> = {}
  for (const [path, k] of Object.entries(keptBefore)) {
    const ws = repoWorkspaces.find((w) => w.path === path)
    const row = ws ? byWorktree.get(ws) : undefined
    if (ws && now - k.at < STOPPED_KEEP_MS && (!row || row.dispatchId === k.dispatchId)) stoppedWorktrees[path] = k
  }
  if (JSON.stringify(stoppedWorktrees) !== JSON.stringify(keptBefore)) await deps.store.set(keptKey, stoppedWorktrees as unknown as JsonValue)
  const stillPending = acting ? unstopped : []
  if (JSON.stringify(stillPending) !== JSON.stringify(loadPendingStops(pendingRaw))) await deps.store.set(stopsKey, stillPending as unknown as JsonValue)
  if (JSON.stringify(starts) !== JSON.stringify(prevStarts) && starts) await deps.store.set(`starts:${repoKey}`, starts as unknown as JsonValue)
  const startsToday = starts && starts.day === dayOf(now) ? starts.count : 0
  view.supervisor.live = live
  view.supervisor.startsToday = startsToday
  if (ownersKnown) {
    // Only the supervisor's own terminal and its workers' are judged by the hook.
    const terminals = [view.supervisor.terminal, ...mine.map((w) => w.terminal)].filter((t): t is string => typeof t === 'string' && t !== '')
    deps.onLimits?.({ repo: repoKey, terminals, live, startsToday, day: dayOf(now), freeBytes: free, listedAt: workersAt, limits })
  }
  // Over a limit without a start to stop: workers there when Matriarch first looked at the Run
  // or when a limit was lowered, or a dry run.
  const overNow =
    limits.maxWorkers > 0 && live > limits.maxWorkers
      ? `${live} workers are running, over its limit of ${limits.maxWorkers} at once`
      : limits.maxWorkerStartsPerDay > 0 && startsToday > limits.maxWorkerStartsPerDay
        ? `${startsToday} workers started today, over its limit of ${limits.maxWorkerStartsPerDay} a day`
        : null
  if (overNow) {
    board.attention.push({
      key: `limits:${repoKey}`,
      repo: repoKey,
      alert: true,
      message: acting
        ? unstopped.length > 0
          ? `${repoKey}: ${overNow}. Matriarch could not stop ${unstopped.length === 1 ? 'the worker that started' : `the ${unstopped.length} workers that started`} over it (the board says why), and tries again for a few minutes: stop ${unstopped.length === 1 ? 'it' : 'them'} yourself if that fails.`
          : `${repoKey}: ${overNow}. Matriarch stops a worker that starts over a limit, but these were running before it looked or before the limit was lowered: ask the supervisor to let some finish, or raise the limit in Settings.`
        : `${repoKey}: ${overNow}. In dry run Matriarch only tells you; with autopilot on it stops a worker that starts over a limit. Ask the supervisor to let some finish, or raise the limit in Settings.`,
      terminal: view.supervisor.terminal ?? undefined
    })
  }
  proj.live = live
  proj.startsToday = startsToday
  proj.stoppedWorktrees = stoppedWorktrees
}

/** Labeled issues handed to the supervisor as objectives (issues.ts). */
async function handIssues(proj: ProjectTick): Promise<void> {
  const { deps, opts, board, now } = proj.t
  const { repoKey, info, config, forge, supervisor, view, free, limits, lowDisk, acting, live, startsToday } = proj
  // Labeled issues: the supervisor's next objectives (issues.ts). None goes while the supervisor
  // could start no worker for it: it would only be refused or stopped.
  if (config.issues.enabled) {
    const held =
      lowDisk ? `only ${gb(free!)} is free on the disk, under the ${limits.minFreeDiskGB} GB floor`
      : limits.maxWorkers > 0 && live >= limits.maxWorkers ? `${live} of ${limits.maxWorkers} workers are running, the most at once`
      : limits.maxWorkerStartsPerDay > 0 && startsToday >= limits.maxWorkerStartsPerDay ? `${startsToday} workers started today, the most a day`
      : null
    const issues = await followIssues({
      repo: repoKey,
      ref: info.ref,
      root: info.root,
      forge,
      config,
      supervisor,
      pending: view.supervisor.pending,
      acting,
      held,
      now,
      store: deps.store,
      // Each handoff is kept with the mail Matriarch sent, so the supervisor's reply is known as its.
      tellSupervisor: deps.tellSupervisor
        ? async (repo, root, to, m) => {
            const receipt = await deps.tellSupervisor!(repo, root, to, m)
            if (receipt) await recordSent(deps.store, repo, receipt, { at: now, to, subject: m.subject, kind: 'issue' }).catch(() => {})
          }
        : undefined,
      commentIssue: deps.commentIssue,
      stillOn: opts.stillOn
    })
    view.issues = issues.view
    view.warnings.push(...issues.warnings)
    view.errors.push(...issues.errors)
    board.attention.push(...issues.attention)
  }
}

/** The forge's open PRs and default branch. Adds summaries, viewer, listed, base, truncatedList, detailAge, follows, unknownWs. */
async function listPrs(proj: ProjectTick): Promise<void> {
  const { board, maxAge } = proj.t
  const { info, kind, terms, forge, view, byBranch, repoWorkspaces } = proj
  let summaries: PrSummary[] = []
  let viewer = ''
  let listed = false
  let base: { name: string; sha: string | null; rollup: string | null } | null = null
  // The forge had more open PRs than it lists: a PR's parent may be among those left out.
  let truncatedList = false
  // How long a PR's detail may be reused: shorter where the forge's list cannot show every change.
  let detailAge = maxAge
  // Only PRs whose branch lives in an Orca workspace and that the signed-in user opened.
  const follows = (s: PrSummary, who: string) => byBranch.has(s.headRef) && (!who || !s.author || s.author === who)
  try {
    if (!forge) throw new Error(`Matriarch cannot read ${terms.name} here`)
    const list = await forge.listOpen(info.ref, { watch: follows })
    summaries = list.prs
    viewer = list.viewer
    base = list.base ?? null
    detailAge = Math.min(maxAge, list.detailMaxAgeMs ?? maxAge)
    truncatedList = list.truncated === true
    // GitHub's budget is the scarce one: GitLab's shows only when no GitHub project reports one.
    if (list.rate && (kind === 'github' || !board.rate)) board.rate = kind === 'github' ? list.rate : { ...list.rate, forge: terms.name }
    // The real client says null when the forge has no default branch; a reader that omits it says nothing.
    if (list.base === null) {
      view.empty = true
      view.errors.push(`${terms.name} has no commits for this project yet. Push a first commit to its main branch: workers branch from it and open their PRs against it.`)
    }
    // Conditional requests make an unchanged GitHub list free; GitLab has no such thing.
    if (kind === 'github') board.github = { unchanged: (board.github?.unchanged ?? 0) + (list.unchanged ? 1 : 0), read: (board.github?.read ?? 0) + (list.unchanged ? 0 : 1) }
    listed = true
  } catch (error) {
    view.errors.push(`${terms.name}: ${(error as Error).message}`)
  }
  // Workspaces whose PR state is unknown this tick keep their last known lane, unwritten.
  const unknownWs = new Set<string>(listed ? [] : repoWorkspaces.map((w) => w.id))
  Object.assign(proj, { summaries, viewer, listed, base, truncatedList, detailAge, follows, unknownWs })
}

/** The advisor: the supervisor's questions, answered read-only on the default branch. */
async function stepAdvisor(proj: ProjectTick): Promise<void> {
  const { deps, board, advised } = proj.t
  const { repoKey, info, config, supervisor, acting, whyNot, base, kind, view } = proj
  // The advisor: the supervisor's questions, answered read-only on the default branch.
  if (deps.advisor) {
    advised.add(repoKey)
    try {
      const advisor = await deps.advisor.step({
        repo: repoKey, root: info.root, config, supervisor, acting, notActing: whyNot, base: base?.name ?? null, forge: kind,
        questions: proj.questions,
        supervisorSenders: async () => (deps.supervisorSenders ? deps.supervisorSenders(repoKey, supervisor) : [])
      })
      if (advisor) {
        view.advisor = advisor
        const needs = advisorAttention(repoKey, advisor)
        if (needs) board.attention.push(needs)
      }
      // The advisor stored them (or answered that it cannot): no longer pending. A step that threw
      // leaves them pending for the next tick, and the advisor's own record keeps one taken twice
      // from running twice.
      if (proj.questions.length > 0) {
        const key = mailKey(repoKey)
        const state = loadMailState(await deps.store.get(key))
        const next = takenQuestions(state, proj.questions.map((q) => q.id))
        if (next.pending.length !== state.pending.length) await deps.store.set(key, next as unknown as JsonValue)
      }
    } catch (error) {
      view.errors.push(`Advisor: ${(error as Error).message}`)
    }
  }
}

/** Each followed open PR's detail and ledger, brought up to date. Adds items, mergeBusy, runningReviews, and what was tracked. */
async function readOpenPrs(proj: ProjectTick): Promise<void> {
  const { deps, now, crewMarks } = proj.t
  const { repoKey, info, config, summaries, follows, viewer, detailAge, base, byBranch, view, unknownWs } = proj
  const managed = summaries.filter((s) => follows(s, viewer)).sort((a, b) => a.number - b.number)

  const trackedKey = `tracked:${repoKey}`
  const tracked = toNumbers(await deps.store.get(trackedKey))
  const open = new Set(managed.map((s) => s.number))

  const items: { snap: PrSnapshot; ledger: PrLedger; ws: Workspace | undefined }[] = []
  const mergeBusy = new Set<string>()
  let runningReviews = 0
  for (const s of managed) {
    try {
      const baseSha = base && s.baseRef === base.name ? base.sha : null
      const read = await snapshotFor(deps, info, s, now, detailAge, baseSha)
      if (!read) continue
      const snap = await withFileMoves(deps, info, config, read, now, baseSha)
      let ledger = loadLedger(await deps.store.get(ledgerKey(repoKey, s.number)))
      // When each head was first seen: a new commit's checks get a grace period to register.
      if (!ledger.heads[snap.headSha]) {
        ledger = { ...ledger, heads: Object.fromEntries([...Object.entries(ledger.heads), [snap.headSha, now]].slice(-20)) }
        await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
      }
      if (snap.ci !== 'none' && !ledger.ciSeen) {
        ledger = { ...ledger, ciSeen: true }
        await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
      }
      // A round that asked for changes on an older commit, whose findings nobody received before
      // the PR moved on, is moot: it does not use up one of the PR's rounds. (The next round still
      // checks its findings.)
      const moot = Object.entries(ledger.reviews).filter(([sha, r]) => sha !== snap.headSha && r.status === 'done' && r.verdict === 'changes' && !r.delivered && !r.published && !r.superseded)
      if (moot.length > 0) {
        ledger = { ...ledger, reviews: { ...ledger.reviews, ...Object.fromEntries(moot.map(([sha, r]) => [sha, { ...r, superseded: true }])) } }
        await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
      }
      // A round still reviewing an older commit is moot: stop it, and it uses up no round.
      for (const old of deps.crew ? await deps.crew.supersede(repoKey, s.number, snap.headSha).catch(() => []) : []) {
        const prior = ledger.reviews[old.sha]
        if (prior) ledger = { ...ledger, reviews: { ...ledger.reviews, [old.sha]: { ...prior, status: 'failed', superseded: true, endedAt: now } } }
        await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
        crewMarks.set(`${repoKey}#${s.number}`, [
          ...(crewMarks.get(`${repoKey}#${s.number}`) ?? []),
          { at: now, kind: 'review-done', label: `review of ${old.sha.slice(0, 7)} stopped: the PR moved to ${snap.headSha.slice(0, 7)}` }
        ])
      }
      // A round that timed out may still get its verdicts: adopt them.
      if (deps.crew && ledger.reviews[snap.headSha]?.status === 'failed') {
        const revived = await deps.crew.revive(repoKey, s.number, snap.headSha).catch(() => null)
        if (revived?.status === 'running') {
          // It was only slow: a reviewer is still producing output. Back to running.
          const prior = ledger.reviews[snap.headSha]
          ledger = { ...ledger, reviews: { ...ledger.reviews, [snap.headSha]: { round: prior.round, status: 'running', startedAt: prior.startedAt } } }
          await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
          crewMarks.set(`${repoKey}#${s.number}`, [...(crewMarks.get(`${repoKey}#${s.number}`) ?? []), { at: now, kind: 'review-start', label: 'review round resumed: a reviewer is still working' }])
        } else if (revived?.outcome) {
          ledger = {
            ...ledger,
            reviews: {
              ...ledger.reviews,
              [snap.headSha]: { ...ledger.reviews[snap.headSha], status: 'done', endedAt: revived.endedAt ?? now, verdict: revived.outcome.verdict, findings: revived.outcome.blocking.length }
            }
          }
          await deps.store.set(ledgerKey(repoKey, s.number), ledger as unknown as JsonValue)
          crewMarks.set(`${repoKey}#${s.number}`, [...(crewMarks.get(`${repoKey}#${s.number}`) ?? []), { at: now, kind: 'review-done', label: revived.outcome.summary }])
        }
      }
      // Only a fresh request for this exact commit holds the base: a stale one must not block merges.
      if (ledger.merge?.status === 'requested' && ledger.merge.sha === snap.headSha && now - ledger.merge.at < MERGE_TIMEOUT_MS) mergeBusy.add(snap.baseRef)
      runningReviews += Object.values(ledger.reviews).filter((r) => r.status === 'running').length
      items.push({ snap, ledger, ws: byBranch.get(s.headRef) })
    } catch (error) {
      view.errors.push(`#${s.number}: ${(error as Error).message}`)
      const ws = byBranch.get(s.headRef)
      if (ws) unknownWs.add(ws.id)
    }
  }
  Object.assign(proj, { trackedKey, tracked, open, items, mergeBusy, runningReviews })
}

/** PRs Matriarch followed that left the open list: their final state, read once, and the closed ones still on the board. */
async function readClosedPrs(proj: ProjectTick): Promise<void> {
  const { deps, now } = proj.t
  const { repoKey, info, config, forge, listed, acting, byBranch, view, tracked, open, items, trackedKey } = proj
  // PRs Matriarch followed that left the open list: read their final state once.
  if (listed && forge) {
    for (const number of tracked.filter((n) => !open.has(n))) {
      try {
        const { pr } = await forge.detail(info.ref, number)
        if (!pr) continue
        if (pr.state === 'OPEN') {
          // Still open, but no longer followed (its worktree gone, another author): its records
          // are pruned a week after this unless it is followed again.
          if (!(await deps.store.get(`dropped:${repoKey}#${number}`))) await deps.store.set(`dropped:${repoKey}#${number}`, now)
          continue
        }
        // Its review rounds are moot now.
        if (deps.crew) await deps.crew.supersede(repoKey, number, null).catch(() => [])
        const ledger = loadLedger(await deps.store.get(ledgerKey(repoKey, number)))
        // Its records are pruned a week after this.
        if (!(await deps.store.get(`closed:${repoKey}#${number}`))) {
          await deps.store.set(`closed:${repoKey}#${number}`, now)
          // Once, when Matriarch first sees it merged, whoever merged it; like every alert, only
          // while it acts (Orca has no notification for this one: it goes to the webhook only).
          if (pr.state === 'MERGED' && acting) deps.alert?.({ kind: 'merged', title: `${repoKey} #${number} merged`, body: pr.title, repo: repoKey, number, url: pr.url })
        }
        if (pr.state === 'MERGED' && ledger.merge && ledger.merge.status !== 'merged') {
          await deps.store.set(ledgerKey(repoKey, number), { ...ledger, merge: { ...ledger.merge, status: 'merged' } } as unknown as JsonValue)
        }
        // A merged PR's worktree has done its job: it goes once nothing runs there.
        const done = byBranch.get(pr.headRef)
        if (pr.state === 'MERGED' && done && done.path !== info.root && config.merge.removeWorktree) {
          const list = ((await deps.store.get(`cleanup:${repoKey}`)) as PendingCleanup[] | null) ?? []
          if (!list.some((c) => c.path === done.path)) await deps.store.set(`cleanup:${repoKey}`, [...list, { path: done.path, number, at: now }] as unknown as JsonValue)
        }
        // Kept as it closed, so it can stay on the board without asking the forge again.
        await deps.store.set(`snap:${repoKey}#${number}`, { snap: pr } as unknown as JsonValue)
        items.push({ snap: pr, ledger, ws: byBranch.get(pr.headRef) })
      } catch (error) {
        view.errors.push(`#${number}: ${(error as Error).message}`)
      }
    }
    await deps.store.set(trackedKey, [...open])
    // Merged and closed PRs stay on the board and timeline for a while, from the state read when
    // they closed: nothing is asked of the forge for them again.
    if (deps.store.keys) {
      const shown = new Set(items.map((i) => i.snap.number))
      for (const key of (await deps.store.keys()).filter((k) => k.startsWith(`closed:${repoKey}#`))) {
        const number = Number(key.slice(key.lastIndexOf('#') + 1))
        const at = await deps.store.get(key)
        if (shown.has(number) || typeof at !== 'number' || now - at > SHOW_CLOSED_MS) continue
        const snap = ((await deps.store.get(`snap:${repoKey}#${number}`)) as { snap?: PrSnapshot } | null)?.snap
        if (!snap || snap.state === 'OPEN') continue
        items.push({ snap, ledger: loadLedger(await deps.store.get(ledgerKey(repoKey, number))), ws: byBranch.get(snap.headRef) })
      }
    }
  }
}

/** Worktrees of merged PRs, removed once no worker is live there and nothing is uncommitted. */
async function cleanupMergedWorktrees(proj: ProjectTick): Promise<void> {
  const { deps, now, byWorktree } = proj.t
  const { repoKey, info, config, acting, repoWorkspaces, byBranch, view, gone, cleanedUp } = proj
  // Worktrees of merged PRs: removed once no worker is live there and nothing is uncommitted.
  if (acting && deps.removeWorktree && config.merge.removeWorktree) {
    // Once per project: PRs merged before this cleanup existed are found by their ledgers.
    if (!(await deps.store.get(`cleanup:scanned:${repoKey}`)) && deps.store.keys) {
      const found: PendingCleanup[] = []
      for (const key of (await deps.store.keys()).filter((k) => k.startsWith(`pr:${repoKey}#`))) {
        const number = Number(key.slice(key.indexOf('#') + 1))
        if (loadLedger(await deps.store.get(key)).merge?.status !== 'merged') continue
        const head = ((await deps.store.get(`snap:${repoKey}#${number}`)) as { snap?: { headRef?: string } } | null)?.snap?.headRef
        const ws = head ? byBranch.get(head) : undefined
        if (ws && ws.path !== info.root) found.push({ path: ws.path, number, at: now })
      }
      const list = ((await deps.store.get(`cleanup:${repoKey}`)) as PendingCleanup[] | null) ?? []
      await deps.store.set(`cleanup:${repoKey}`, [...list, ...found.filter((f) => !list.some((c) => c.path === f.path))] as unknown as JsonValue)
      await deps.store.set(`cleanup:scanned:${repoKey}`, now)
    }
    const pending = ((await deps.store.get(`cleanup:${repoKey}`)) as PendingCleanup[] | null) ?? []
    const still: PendingCleanup[] = []
    for (const c of pending) {
      const ws = repoWorkspaces.find((w) => w.path === c.path)
      if (!ws || ws.path === info.root || now - c.at > CLEANUP_GIVE_UP_MS) continue
      const owner = byWorktree.get(ws)
      const act = activityOf(proj.t, ws)
      if ((owner && owner.live !== false) || agentBusy(act)) {
        still.push({ ...c, kept: 'an agent is still running there' })
        continue
      }
      const res = await deps.removeWorktree(ws.path).catch((error: Error) => ({ removed: false, reason: error.message }))
      if (res.removed) {
        deps.log(`${repoKey}: removed the worktree of merged #${c.number} (${ws.path})`)
        gone.add(ws.path)
        // The merged PR stays on the board for a while under its own key once its worktree is
        // gone. When the worktree's history was this PR's, it goes with it; this tick's lane and
        // marks are written there below.
        const own = loadHistory(await deps.store.get(historyKey(ws.id)))
        if (own.pr === undefined || own.pr === c.number) await deps.store.set(historyKey(`pr:${repoKey}#${c.number}`), { ...own, pr: c.number } as unknown as JsonValue)
        cleanedUp.set(c.number, { at: now, kind: 'cleanup', text: `Removed the worktree ${ws.name}: no agent ran there and nothing in it was uncommitted` })
        continue
      }
      still.push({ ...c, kept: res.reason ?? 'not removed' })
      if (res.reason && res.reason !== c.kept) view.warnings.push(`Kept the worktree of merged #${c.number} (${ws.name}): ${res.reason}.`)
    }
    if (still.length !== pending.length || still.some((c, i) => c.kept !== pending[i]?.kept)) await deps.store.set(`cleanup:${repoKey}`, still as unknown as JsonValue)
  }
}

/** Worktrees the supervisor's workers finished in that never became a PR, removed an hour after. */
async function cleanupFinishedWorktrees(proj: ProjectTick): Promise<void> {
  const { deps, now, byWorktree } = proj.t
  const { repoKey, info, config, acting, listed, supervisor, summaries, repoWorkspaces, stoppedWorktrees, gone } = proj
  // Worktrees the supervisor's workers used that never became a PR (a gate, an audit, a spike):
  // removed an hour after Matriarch first sees no worker live there, when nothing in them is
  // uncommitted or unpushed. Only worktrees of the supervisor's own Run, never one a person made.
  if (acting && listed && deps.removeWorktree && config.merge.removeFinishedWorktrees && supervisor) {
    const prBranches = new Set(summaries.map((s) => s.headRef))
    const merging = new Set((((await deps.store.get(`cleanup:${repoKey}`)) as PendingCleanup[] | null) ?? []).map((c) => c.path))
    const finishedKey = `finished:${repoKey}`
    const seen = ((await deps.store.get(finishedKey)) as Record<string, number> | null) ?? {}
    const still: Record<string, number> = {}
    for (const ws of repoWorkspaces) {
      if (ws.path === info.root || merging.has(ws.path) || prBranches.has(branchName(ws.branch) ?? '') || stoppedWorktrees[ws.path]) continue
      const row = byWorktree.get(ws)
      if (!row?.runId || `run:${row.runId}` !== supervisor || row.live !== false) continue
      const act = activityOf(proj.t, ws)
      if (agentBusy(act)) continue
      const since = seen[ws.path] ?? now
      if (now - since < FINISHED_GRACE_MS) {
        still[ws.path] = since
        continue
      }
      const res = await deps.removeWorktree(ws.path, { keepBranch: true }).catch((error: Error) => ({ removed: false, reason: error.message }))
      if (res.removed) {
        deps.log(`${repoKey}: removed ${ws.name}, a finished worktree that never became a PR (${ws.path})`)
        // Not in the worktree's activity log: its row leaves the board with the worktree, so
        // nothing would show it. A merged PR's card stays, and carries its cleanup line.
        gone.add(ws.path)
      } else still[ws.path] = since
    }
    if (JSON.stringify(still) !== JSON.stringify(seen)) await deps.store.set(finishedKey, still as unknown as JsonValue)
  }
}

/** What the tracks need across PRs: worktrees gone this tick, whose history each worktree's is, and stacked PRs' parents. */
function prepareTracks(proj: ProjectTick): void {
  const { items, gone, summaries, base } = proj
  const seenWorkspaces = new Set<string>()
  for (const item of items) if (item.ws && gone.has(item.ws.path)) item.ws = undefined
  // A worktree's history belongs to the first PR on it (the lowest number, when two are first
  // seen together); any other PR on that worktree keeps its own, by number.
  const firstOn = new Map<string, number>()
  for (const { ws, snap } of items) if (ws) firstOn.set(ws.id, Math.min(firstOn.get(ws.id) ?? Infinity, snap.number))
  // Stacked PRs: one whose base is the head branch of another PR Matriarch follows merges only
  // after it, and is moved and rebased once that one merged. Only a PR from a short-lived branch
  // of this repository can be a parent (canBeParent): a release PR from a long-lived branch, or
  // a fork's PR from its own main, never holds the PRs into that branch.
  const parents = new Map<string, StackCandidate>()
  for (const { snap: s } of items) {
    if (s.state === 'OPEN' && canBeParent(s, base?.name ?? null)) parents.set(s.headRef, { number: s.number, headRef: s.headRef, headSha: s.headSha, baseRef: s.baseRef })
  }
  const all = new Map(summaries.map((s) => [s.number, { number: s.number, headRef: s.headRef, headSha: s.headSha, baseRef: s.baseRef ?? '' }]))
  const openStack = { parents, all }
  const closedSnaps = new Map(items.filter((i) => i.snap.state !== 'OPEN').map((i) => [i.snap.number, i.snap]))
  Object.assign(proj, { seenWorkspaces, firstOn, openStack, closedSnaps })
}

/** The crew's run for a PR on its head commit, as the crew reports it. */
type CrewRun = Awaited<ReturnType<Crew['get']>>

/** One PR's turn: its ledger brought up to date, planned, acted on under autopilot, and its track written. */
async function planAndAct(proj: ProjectTick, item: TickItem): Promise<void> {
  const { byWorktree } = proj.t
  const ws = item.ws
  const owner = ws ? ownerFor(ws, byWorktree.get(ws), activityOf(proj.t, ws)) : null
  await refreshLedger(proj, item, owner)
  const { p, run } = await planFor(proj, item, owner)
  const done = await act(proj, item, owner, p)
  await writeTrack(proj, item, owner, p, run, done)
}

/** What the ledger learns before planning: a flaky failure judged, the PR it is stacked on, who built it. */
async function refreshLedger(proj: ProjectTick, item: TickItem, owner: Owner | null): Promise<void> {
  const { deps } = proj.t
  const { repoKey, info, config, base, listed, openStack, closedSnaps } = proj
  const { snap } = item
  if (snap.state === 'OPEN') {
    const judged = await judgeFailures(deps, info, snap, item.ledger, config)
    if (judged !== item.ledger) {
      item.ledger = judged
      await deps.store.set(ledgerKey(repoKey, snap.number), judged as unknown as JsonValue)
    }
  }
  if (snap.state === 'OPEN' && listed) {
    const st = await followStack(deps, info, snap, item.ledger, openStack, closedSnaps, base?.name ?? null)
    if (JSON.stringify(st ?? null) !== JSON.stringify(item.ledger.stack ?? null)) {
      const next: PrLedger = { ...item.ledger }
      if (st) next.stack = st
      else delete next.stack
      item.ledger = next
      await deps.store.set(ledgerKey(repoKey, snap.number), next as unknown as JsonValue)
    }
  }
  // Who built the PR: the first worker seen on it, and whether it finished a turn since.
  if (owner?.address) {
    const b = item.ledger.builder
    const next = !b
      ? { address: owner.address, done: owner.activity === 'done' }
      : b.address === owner.address && owner.activity === 'done' && !b.done ? { ...b, done: true } : null
    if (next) {
      item.ledger = { ...item.ledger, builder: next }
      await deps.store.set(ledgerKey(repoKey, snap.number), item.ledger as unknown as JsonValue)
    }
  }
}

/** The plan for a PR, with what its review round says (a failed round, a reviewer stuck on a prompt). */
async function planFor(proj: ProjectTick, item: TickItem, owner: Owner | null): Promise<{ p: Plan; run: CrewRun | null }> {
  const { deps, now, ownersKnown } = proj.t
  const { repoKey, config, supervisor, base, truncatedList, byBranch, mergeBusy } = proj
  const { snap } = item
  const run = deps.crew ? await deps.crew.get(repoKey, snap.number, snap.headSha).catch(() => null) : null
  const p = plan({
    pr: snap,
    owner,
    // A red base is one problem for the whole repository: every PR reads its one escalation.
    ledger: withRepoEscalations(item.ledger, proj.repoEscalations),
    config,
    supervisor,
    mergeSlotFree: !mergeBusy.has(snap.baseRef),
    reviewSlotFree: proj.runningReviews < config.limits.maxConcurrentReviews,
    baseRed: base && base.name === snap.baseRef && (base.rollup === 'FAILURE' || base.rollup === 'ERROR') ? { sha: base.sha } : null,
    // Known only for the default branch: GitHub's rollup is null when its head has no checks at all.
    baseHasChecks: base && base.name === snap.baseRef ? base.rollup !== null : undefined,
    ownersKnown,
    stack: item.ledger.stack ?? null,
    // A cut-short list may leave out the PR whose branch this one merges into.
    unlistedBase:
      truncatedList && snap.state === 'OPEN' && !item.ledger.stack && byBranch.has(snap.baseRef) && stackableBranch(snap.baseRef, base?.name ?? null),
    // Deleting its branch as it merges would close these (plan.ts keptBranchReason); a list cut
    // short, or one without every PR's base, may leave one out.
    basedOnIt:
      truncatedList || proj.summaries.some((o) => !o.baseRef)
        ? null
        : proj.summaries.filter((o) => o.baseRef === snap.headRef && o.number !== snap.number).map((o) => o.number).sort((a, b) => a - b),
    now
  })

  // A failed round says why, not just that it failed.
  if (run?.status === 'failed' && item.ledger.reviews[snap.headSha]?.status === 'failed') {
    p.reason = `review round ${run.round} failed: ${run.error ?? 'unknown'}${run.reviewers.some((r) => r.status === 'failed') ? ` (${run.reviewers.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.error ?? 'failed'}`).join('; ')})` : ''}`
  }
  // A reviewer stuck on an agent prompt needs a person before anything else can happen.
  const stuck = run?.status === 'running' ? run.reviewers.find((r) => r.status === 'running' && r.blocked) : undefined
  if (stuck) {
    p.lane = 'needs-you'
    p.reason = `reviewer ${stuck.name} (${stuck.agent}) needs you: ${stuck.blocked}`
  }

  return { p, run }
}

/** A merged PR's branch kept for the PRs based on it (plan.ts keptBranchReason), until it can go. */
export interface KeptBranch {
  /** The merged head: the branch is deleted only while it still points here. */
  sha: string
  /** The PR that merged from it. */
  number: number
  at: number
  /** When deleting it last failed: it is tried again after KEPT_RETRY_MS. */
  failedAt?: number
}

/** Where a project's kept branches are recorded, by branch name. */
export const keptBranchesKey = (repo: string): string => `kept-branches:${repo}`
/** How long a kept branch waits for the PRs based on it to move off it; then it is left as it is. */
export const KEPT_BRANCH_MS = 30 * 24 * 3600_000
/** A deletion that failed is tried again after this. */
export const KEPT_RETRY_MS = 10 * 60_000

function loadKeptBranches(raw: unknown): Record<string, KeptBranch> {
  const out: Record<string, KeptBranch> = {}
  for (const [branch, v] of Object.entries(obj(raw))) {
    const k = obj(v)
    if (typeof k.sha !== 'string' || typeof k.number !== 'number' || typeof k.at !== 'number') continue
    out[branch] = { sha: k.sha, number: k.number, at: k.at, ...(typeof k.failedAt === 'number' ? { failedAt: k.failedAt } : {}) }
  }
  return out
}

async function keepBranch(deps: EngineDeps, repo: string, branch: string, kept: KeptBranch): Promise<void> {
  const all = loadKeptBranches(await deps.store.get(keptBranchesKey(repo)))
  await deps.store.set(keptBranchesKey(repo), { ...all, [branch]: kept } as unknown as JsonValue)
}

/**
 * Deletes the branches kept when their PRs merged, each once no open PR is based on it or comes
 * from it, if it still points at the merged commit (one with commits since is left). Only with
 * autopilot on, the project still deleting merged branches, and a full list of open PRs: a list
 * cut short may leave out a PR the deletion would close.
 */
async function deleteKeptBranches(proj: ProjectTick): Promise<void> {
  const { deps, now } = proj.t
  const { repoKey, info, config, acting, listed, truncatedList, summaries } = proj
  const kept = loadKeptBranches(await deps.store.get(keptBranchesKey(repoKey)))
  if (Object.keys(kept).length === 0) return
  const next = { ...kept }
  const drop = (branch: string, why: string | null) => {
    delete next[branch]
    if (why) deps.log(`${repoKey}: ${why}`)
  }
  for (const [branch, k] of Object.entries(kept)) {
    if (!config.merge.deleteBranch) drop(branch, null)
    else if (now - k.at > KEPT_BRANCH_MS) drop(branch, `left ${branch}, kept when #${k.number} merged: PRs were still based on it ${Math.round(KEPT_BRANCH_MS / 86_400_000)} days later`)
    else if (!acting || !listed || truncatedList || summaries.some((s) => !s.baseRef) || !deps.executor?.deleteBranch) continue
    else if (k.failedAt !== undefined && now - k.failedAt < KEPT_RETRY_MS) continue
    else if (summaries.some((s) => s.baseRef === branch || (s.headRef === branch && !s.crossRepo))) continue
    else {
      const r = await deps.executor.deleteBranch(info.ref, branch, k.sha).catch((error: Error) => ({ error: error.message }))
      if ('error' in r) {
        next[branch] = { ...k, failedAt: now }
        deps.log(`${repoKey}: could not delete ${branch}, kept when #${k.number} merged: ${r.error}`)
      } else {
        drop(
          branch,
          r.result === 'deleted' ? `deleted ${branch}, kept when #${k.number} merged until the PRs based on it had moved off it`
          : r.result === 'moved' ? `left ${branch}, kept when #${k.number} merged: it has commits made since`
          : null
        )
      }
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(kept)) await deps.store.set(keptBranchesKey(repoKey), next as unknown as JsonValue)
}

/** Carries out a plan's actions under autopilot, recording each in the ledger as it succeeds. Answers the ledger, and the marks and log lines for the track. */
async function act(proj: ProjectTick, item: TickItem, owner: Owner | null, p: Plan): Promise<{ ledger: PrLedger; marks: Mark[]; logged: LogEntry[] }> {
  const { deps, opts, now, byWorktree } = proj.t
  const { repoKey, info, config, kind, supervisor, acting, mergeBusy, view } = proj
  const { snap } = item
  let ledger = item.ledger
  const marks: Mark[] = []
  // What was carried out (or tried) this tick, for the track's activity log.
  const logged: LogEntry[] = []
  const ownerRow = item.ws ? byWorktree.get(item.ws) : undefined
  const failedLogs = p.actions.some((a) => a.kind === 'send-ci-failure') ? await keptLogs(deps, info, snap) : {}
  const ctx = { repo: info.ref, pr: snap, config, root: info.root, supervisor, worktree: item.ws?.path ?? null, ownerLive: ownerRow ? ownerRow.live !== false : null, owner: owner?.address ?? null, failedLogs }
  const run1 = async (a: Action) => {
    try {
      return await deps.executor!.execute(a, ctx)
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }
  /** Records a step done: on the PR's ledger, or, for a repository-wide escalation, once for the project. */
  const remember = async (a: Action, l: PrLedger): Promise<PrLedger> => {
    if (a.kind !== 'escalate' || !repoWide(a.key)) return record(l, a, now)
    await saveRepoEscalations(proj, { ...proj.repoEscalations, [a.key]: { to: a.to, at: now, reason: a.reason } })
    return l
  }
  for (const action of p.actions) {
    if (action.kind === 'merge') mergeBusy.add(snap.baseRef)
    if (action.kind === 'start-review') proj.runningReviews++
    if (!acting) continue
    // The pause switch is honoured between actions, not only between ticks.
    if (opts.stillOn && !(await opts.stillOn().catch(() => false))) break
    // A red base is one problem for the whole repository: escalated once, by the first PR that
    // meets it, and kept once for all of them (ledger.ts repoWide).
    const shared = action.kind === 'escalate' && repoWide(action.key)
    if (shared && proj.repoEscalations[action.key]) continue
    const outcome = await run1(action)
    if (outcome.ok) {
      // What went to an agent is kept with its id, so a reply in its thread finds this PR (mailbox.ts).
      if (outcome.sent?.messageId && outcome.sent.address) {
        await recordSent(deps.store, repoKey, { id: outcome.sent.messageId, from: outcome.sent.from ?? null }, {
          at: now, to: outcome.sent.address, subject: outcome.sent.subject, kind: action.kind === 'escalate' && action.key.startsWith('draft:') ? 'draft' : action.kind,
          number: snap.number, ...(action.kind === 'escalate' ? { key: action.key } : {})
        }).catch(() => {})
      }
      ledger = await remember(action, ledger)
      if (action.kind === 'merge' && action.keepBranch && config.merge.deleteBranch) await keepBranch(deps, repoKey, snap.headRef, { sha: action.sha, number: snap.number, at: now })
      marks.push(markFor(action, now, kind))
      logged.push(logEntry(action, outcome, now, kind, describe(action, kind)))
      // Saved after each success, so a later failure in this tick cannot make it run twice.
      await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
      continue
    }
    if (outcome.skipped) continue
    logged.push(logEntry(action, outcome, now, kind, describe(action, kind)))
    view.errors.push(`#${snap.number} ${action.kind}: ${outcome.error ?? 'failed'}`)
    // A re-run the forge refused is not asked for again: the failure goes to the worker next.
    if (action.kind === 'rerun-check') {
      ledger = recordRefusedRerun(ledger, action, now, outcome.error ?? 'refused')
      await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
    }
    // A move of the base the forge refused is tried again later, and escalated after a few tries.
    if (action.kind === 'retarget') {
      ledger = recordRefusedRetarget(ledger, action, now, outcome.error ?? 'refused')
      await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
    }
    if (action.kind === 'merge') ledger = { ...ledger, merge: { sha: action.sha, at: now, status: 'failed', error: outcome.error } }
    // A supervisor that cannot be reached: tell the person now, and forget a Run Orca lost.
    if (action.kind === 'escalate' && action.to === 'supervisor') {
      if (/run_not_found|dispatch_not_found|not found/i.test(outcome.error ?? '')) await deps.store.set(`supervisor:${repoKey}`, '')
      const human: Action = { kind: 'escalate', to: 'human', key: action.key.replace(/:supervisor$/, ':human'), reason: `${action.reason} (the supervisor could not be reached)`, address: null }
      const told = await run1(human)
      if (told.ok) {
        ledger = await remember(human, await remember(action, ledger))
        marks.push(markFor(human, now, kind))
        logged.push(logEntry(human, told, now, kind, describe(human, kind)))
        await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
      }
    }
  }
  if (ledger !== item.ledger) await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)

  return { ledger, marks, logged }
}

/** A PR's history (its commits, lane, marks and log) written, and its card put on the board. */
async function writeTrack(proj: ProjectTick, item: TickItem, owner: Owner | null, p: Plan, run: CrewRun | null, done: { ledger: PrLedger; marks: Mark[]; logged: LogEntry[] }): Promise<void> {
  const { deps, opts, board, now, since, crewMarks } = proj.t
  const { repoKey, kind, firstOn, cleanedUp, seenWorkspaces } = proj
  const { snap, ws } = item
  const { ledger, marks, logged } = done
  const prKey = `pr:${repoKey}#${snap.number}`
  const trackKey = ws && ((loadHistory(await deps.store.get(historyKey(ws.id))).pr ?? firstOn.get(ws.id)) === snap.number) ? ws.id : prKey
  let history = loadHistory(await deps.store.get(historyKey(trackKey)))
  if (history.lastSha !== snap.headSha) {
    if (history.lastSha) {
      const push: Mark = { at: now, kind: 'push', label: `pushed ${shortSha(snap.headSha)}` }
      history = addLog(addMark(history, push), markEntry(push))
    }
    history = { ...history, lastSha: snap.headSha }
  }
  // In the log, in the order they lead to each other: what came in (a commit, a finished
  // review), the lane that put the PR in, then what Matriarch did about it.
  for (const m of crewMarks.get(`${repoKey}#${snap.number}`) ?? []) history = addLog(addMark(history, m), markEntry(m))
  history = noteLane(history, p.lane, p.reason, now)
  for (const m of marks) history = addMark(history, m)
  for (const e of logged) history = addLog(history, e)
  // Replies to Matriarch's mail about this PR, at the times they came.
  for (const e of proj.mailLog.get(snap.number) ?? []) history = insertLog(history, e)
  proj.mailLog.delete(snap.number)
  const cleaned = cleanedUp.get(snap.number)
  if (cleaned) {
    history = addLog(history, cleaned)
    cleanedUp.delete(snap.number)
  }
  history = { ...prune(history, now), seenAt: now, pr: snap.number }
  await deps.store.set(historyKey(trackKey), history as unknown as JsonValue)
  if (ws) seenWorkspaces.add(ws.id)

  const review = ledger.reviews[snap.headSha]
  for (const r of run?.status === 'running' ? run.reviewers : []) {
    if (r.status !== 'running' || !r.blocked) continue
    board.attention.push({
      key: `${repoKey}#${snap.number}:${r.name}`,
      repo: repoKey,
      message: `${repoKey} #${snap.number}: the ${r.name} reviewer (${r.agent}) needs you. ${r.blocked}.`,
      terminal: r.blockedTerminal ?? undefined,
      workspaceId: run?.worktree?.workspaceId ?? undefined
    })
  }
  const win = windowed(history, since)
  board.tracks.push({
    key: trackKey,
    repo: repoKey,
    workspace: ws ? { id: ws.id, name: ws.name, branch: branchName(ws.branch) } : { id: prKey, name: snap.headRef, branch: snap.headRef },
    pr: {
      number: snap.number,
      title: snap.title,
      url: snap.url,
      sha: snap.headSha,
      base: snap.baseRef,
      ci: snap.ci,
      failing: snap.checks.filter((c) => c.state === 'failure').map((c) => c.name),
      openThreads: actionableThreads(snap).length,
      ...(ledger.stack && snap.state === 'OPEN' && snap.baseRef === ledger.stack.headRef ? { stackedOn: ledger.stack.number } : {}),
      ...(currentNote(ledger, snap.headSha, now) ? { note: noteView(currentNote(ledger, snap.headSha, now)!) } : {})
    },
    owner: owner ? { agent: owner.agent, model: owner.model, activity: owner.activity, supervised: owner.address !== null } : null,
    lane: p.lane,
    reason: p.reason,
    next: opts.autopilot ? [] : p.actions.map((a) => describe(a, kind)),
    review:
      review || run
        ? {
            round: review?.round ?? run!.round,
            status: review?.status ?? run!.status,
            verdict: review?.verdict,
            summary: run?.outcome?.summary ?? run?.error ?? undefined,
            // Capped and trimmed: the board is posted to the panel on every tick.
            findings: (run?.outcome?.findings ?? []).slice(0, 40).map((f) => ({
              severity: f.severity,
              file: f.file,
              line: f.line,
              title: f.title,
              detail: f.detail.slice(0, 800),
              suggestion: f.suggestion.slice(0, 400),
              reviewers: f.reviewers
            })),
            reviewers: (run?.reviewers ?? []).map((r) => ({
              name: r.name,
              agent: r.agent,
              model: r.model,
              status: r.status,
              verdict: r.verdict?.verdict,
              findings: r.verdict?.findings.length,
              error: r.error ?? undefined,
              blocked: r.status === 'running' ? (r.blocked ?? undefined) : undefined,
              terminal: r.status === 'running' && r.blocked ? (r.blockedTerminal ?? undefined) : undefined,
              lock: r.lock ? LOCK_LABEL[r.lock] : undefined
            }))
          }
        : null,
    rounds: {
      ci: roundsUsed(ledger, 'ci'),
      conflicts: roundsUsed(ledger, 'conflicts'),
      comments: roundsUsed(ledger, 'comments'),
      reviews: roundsUsed(ledger, 'reviews')
    },
    segments: win.segments,
    marks: win.marks
  })
}

/** A merged PR no longer on the board whose worktree went this tick: its line goes to its log. */
async function logLeftoverCleanups(proj: ProjectTick): Promise<void> {
  const { deps } = proj.t
  const { repoKey, cleanedUp } = proj
  // A merged PR no longer on the board whose worktree went this tick: its line goes to its log.
  for (const [number, entry] of cleanedUp) {
    const key = historyKey(`pr:${repoKey}#${number}`)
    await deps.store.set(key, addLog(loadHistory(await deps.store.get(key)), entry) as unknown as JsonValue)
  }
}

/** Worktrees with no PR yet: building while their agent works, idle otherwise. */
async function worktreeTracks(proj: ProjectTick): Promise<void> {
  const { deps, board, now, since, byWorktree } = proj.t
  const { repoKey, info, terms, repoWorkspaces, seenWorkspaces, gone, unknownWs } = proj
  // Worktrees with no PR yet: building while their agent works, idle otherwise.
  for (const ws of repoWorkspaces) {
    if (seenWorkspaces.has(ws.id) || gone.has(ws.path)) continue
    if (unknownWs.has(ws.id)) {
      // The forge could not say what this worktree's PR is doing: show the last known lane, and
      // leave its history alone rather than rewrite it as idle.
      const known = loadHistory(await deps.store.get(historyKey(ws.id)))
      const last = known.segments[known.segments.length - 1]
      const win = windowed(known, since)
      board.tracks.push({
        key: ws.id,
        repo: repoKey,
        workspace: { id: ws.id, name: ws.name, branch: branchName(ws.branch) },
        pr: null,
        owner: null,
        lane: last?.lane ?? 'idle',
        reason: `${terms.name} is unavailable; this is the last known state${last ? `: ${last.reason}` : ''}`,
        next: [],
        review: null,
        rounds: { ci: 0, conflicts: 0, comments: 0, reviews: 0 },
        segments: win.segments,
        marks: win.marks
      })
      continue
    }
    const act = activityOf(proj.t, ws)
    const worker = byWorktree.get(ws)
    // Who answers this agent: the supervisor answers its workers, and the supervisor itself (in
    // the project's own checkout) waits between turns by design. So waiting there is not
    // "needs you", and a prompt is only once nobody has answered it for a while.
    const isMain = ws.path === info.root
    const answeredByMatriarch = worker !== undefined || isMain
    const promptAge = act?.activity === 'blocked' ? now - act.since : 0
    const lane: Lane =
      act?.activity === 'working' ? 'building'
      : act?.activity === 'blocked' ? (promptAge >= PROMPT_GRACE_MS ? 'needs-you' : 'building')
      : act?.activity === 'waiting' && !answeredByMatriarch ? 'needs-you'
      : 'idle'
    // The project's own checkout is not a piece of work: shown only while an agent is busy there.
    if (isMain && lane === 'idle') continue
    const who = isMain ? 'the supervisor' : 'the agent'
    const reason =
      act?.activity === 'working' ? `${who} is working${isMain ? '' : '; no PR yet'}`
      : act?.activity === 'blocked' ? (lane === 'needs-you' ? `${who} has waited ${Math.round(promptAge / 60_000)} min on a prompt in its tab` : `${who} paused on a prompt`)
      : lane === 'needs-you' ? `${who} is waiting on input` : 'no PR and no agent working'
    let history = loadHistory(await deps.store.get(historyKey(ws.id)))
    history = { ...prune(noteLane(history, lane, reason, now), now), seenAt: now }
    await deps.store.set(historyKey(ws.id), history as unknown as JsonValue)
    const owner = ownerFor(ws, worker, act)
    const win = windowed(history, since)
    board.tracks.push({
      key: ws.id,
      repo: repoKey,
      ...(isMain ? { role: 'supervisor' as const } : {}),
      workspace: { id: ws.id, name: ws.name, branch: branchName(ws.branch) },
      pr: null,
      owner: owner ? { agent: owner.agent, model: owner.model, activity: owner.activity, supervised: owner.address !== null } : null,
      lane,
      reason,
      next: [],
      review: null,
      rounds: { ci: 0, conflicts: 0, comments: 0, reviews: 0 },
      segments: win.segments,
      marks: win.marks
    })
  }
}

/** What is looked after across projects once each had its turn: advisors elsewhere, Needs-you alerts, review worktrees, pruning. */
async function afterProjects(t: TickContext, workspaces: readonly Workspace[]): Promise<void> {
  const { deps, opts, board, now, advised } = t
  deps.onProjects?.(board.repos.map((r) => r.repo))
  // First on the board: a full disk stalls everything else on it (and the status bar shows the first).
  board.attention.unshift(...[...t.lowDisks].map(([id, low]) => diskAttention(id, low.free, low.repos)))
  // An advisor at work for a project no tick sees now (its workspaces closed) still times out,
  // is checked for prompts and unlocked resumes, and has its worktree removed and its mail sent.
  if (deps.advisor?.poll) {
    const pollWhy = notActing(opts.autopilot, deps)
    const elsewhere = await deps.advisor
      .poll({ skip: advised, acting: pollWhy === null, notActing: pollWhy, supervisor: (repo) => deps.supervisor(repo) })
      .catch((error: Error) => (board.errors.push(`Advisor: ${error.message}`), []))
    for (const { repo, view } of elsewhere) {
      const needs = advisorAttention(repo, view)
      if (needs) board.attention.push(needs)
    }
  }
  // Needs-you items nothing else tells the person about: once while each stands.
  await alertAttention(deps, board, now, notActing(opts.autopilot, deps) === null).catch((error: Error) => deps.log(`needs-you alerts: ${error.message}`))
  if (deps.crew) await deps.crew.sweep().catch((error: Error) => deps.log(`review sweep: ${error.message}`))
  // Hourly at most: drop records of PRs closed a week ago and worktrees gone a week.
  if (deps.store.keys && deps.store.delete) {
    const openPrs = new Set(board.tracks.filter((t) => t.pr && t.lane !== 'merged' && t.lane !== 'closed').map((t) => `${t.repo}#${t.pr!.number}`))
    const liveWorkspaces = new Set(workspaces.map((w) => w.id))
    const removed = await collectGarbage(deps.store as unknown as GcStore, { now, openPrs, liveWorkspaces }).catch((error: Error) => {
      deps.log(`storage pruning: ${error.message}`)
      return 0
    })
    if (removed > 0) deps.log(`pruned ${removed} stale storage record(s)`)
  }
}

export type { TrackHistory, TrackView }
