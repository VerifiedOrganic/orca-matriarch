// One engine tick: find the opted-in repositories behind Orca's workspaces, read their PRs from
// each one's forge (GitHub or GitLab), plan each one, act when autopilot is on, record history,
// and answer the board. Every dependency is injected, so a tick runs in tests without Orca, git,
// GitHub or GitLab.
import type { JsonValue } from 'orca/host'
import { defaultConfig, type ConfigResult } from './config.ts'
import { REVIEW_BRANCH_PREFIX, type Crew } from './crew.ts'
import { collectGarbage, type GcStore } from './gc.ts'
import type { Executor } from './executor.ts'
import { forgeKind, forgeTerms, type ForgeKind, type ForgeReader } from './forge.ts'
import { actionableThreads, type GitHub, type PrSnapshot, type PrSummary, type RepoRef } from './github.ts'
import { addMark, historyKey, loadHistory, noteLane, prune, windowed, type TrackHistory } from './history.ts'
import { ledgerKey, loadLedger, record, roundsUsed, type PrLedger } from './ledger.ts'
import { LOCK_LABEL } from './lockdown.ts'
import type { WorkerRow } from './orca-cli.ts'
import { MERGE_TIMEOUT_MS, plan, type Action, type Activity, type Lane, type Owner } from './plan.ts'
import { supervisorTagPrefix } from './supervisor.ts'
import type { Board, Mark, RepoView, TrackView } from './protocol.ts'

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
  /** What agents in a workspace are doing; `path` also matches Orca's `<repoId>::<path>` ids. */
  activity(workspaceId: string, path?: string): ActivityInfo | null
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
  /**
   * Removes a merged PR's worktree when it is safe: answers why not (uncommitted changes, Orca
   * refused) otherwise. Absent where nothing is removed (tests of other parts).
   */
  removeWorktree?: (path: string, options?: { keepBranch?: boolean }) => Promise<{ removed: boolean; reason?: string }>
  /** Bytes free on the disk holding a path; null when it cannot tell. */
  freeSpace?: (path: string) => Promise<number | null>
}

/** Below this, the board says the disk is nearly full: a full disk stalls every agent's build. */
export const LOW_DISK_BYTES = 10 * 1024 ** 3
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

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

const short = (sha: string): string => sha.slice(0, 7)

/** The forge that reads a project, or null when this host has none for it. */
function readerFor(deps: EngineDeps, ref: RepoRef): ForgeReader | null {
  return forgeKind(ref) === 'gitlab' ? (deps.gitlab ?? null) : deps.github
}

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
      return `merge ${short(action.sha)} (${action.method})`
    case 'escalate':
      return `escalate to ${action.to === 'human' ? 'you' : 'the supervisor'}: ${action.reason}`
    case 'notify':
      return `notify: ${action.title}`
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
      return { at, kind: 'merge', label: `merge requested at ${short(action.sha)}` }
    case 'escalate':
      return { at, kind: action.to === 'human' ? 'escalate-human' : 'escalate-supervisor', label: action.reason }
    case 'notify':
      return { at, kind: 'notify', label: action.title }
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

function toNumbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : []
}

export async function tick(deps: EngineDeps, opts: TickOptions): Promise<Board> {
  const now = deps.now()
  const since = now - (opts.windowMs ?? 24 * 3600_000)
  const maxAge = opts.detailMaxAgeMs ?? 10 * 60_000
  const board: Board = { ready: true, at: now, autopilot: opts.autopilot, since, repos: [], tracks: [], attention: [], errors: [], rate: null }

  // Review rounds that finished since the last tick update their PR's ledger first, so the
  // planner below sees the crew's outcome.
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

  let workspaces: Workspace[]
  try {
    // Plugins run git on this machine, so workspaces on SSH hosts or paired servers are skipped.
    // Orca labels this machine's workspaces `hostId: "local"`.
    workspaces = (await deps.workspaces()).filter(
      (w) => (!w.hostId || w.hostId === 'local') && !(branchName(w.branch) ?? '').startsWith(REVIEW_BRANCH_PREFIX)
    )
  } catch (error) {
    board.errors.push(`Could not list Orca workspaces: ${(error as Error).message}`)
    return board
  }

  const repos = new Map<string, { info: RepoInfo; workspaces: Workspace[] }>()
  for (const ws of workspaces) {
    const info = await deps.repoOf(ws.path).catch(() => null)
    if (!info) continue
    const entry = repos.get(info.key) ?? { info, workspaces: [] }
    entry.workspaces.push(ws)
    repos.set(info.key, entry)
  }

  let workers: WorkerRow[] = []
  // Without the worker list every owned PR would look orphaned: send nothing to workers then.
  let ownersKnown = true
  try {
    workers = await deps.workers()
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

  for (const [repoKey, { info, workspaces: repoWorkspaces }] of repos) {
    let cfg: ConfigResult | null
    try {
      cfg = await deps.readConfig(info.root)
    } catch (error) {
      cfg = { config: defaultConfig(), errors: [`Could not read config: ${(error as Error).message}`], warnings: [] }
    }
    if (!cfg) continue
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
        workers: supervisor ? workers.filter((w) => w.runId !== null && `run:${w.runId}` === supervisor).length : 0
      },
      errors: [...cfg.errors],
      warnings: [...cfg.warnings]
    }
    board.repos.push(view)
    // A nearly full disk stalls builds, Orca's saves and Matriarch's own, with nothing on screen:
    // say so once per board, before it fills.
    const free = deps.freeSpace ? await deps.freeSpace(info.root).catch(() => null) : null
    if (free !== null && free < LOW_DISK_BYTES && !board.attention.some((a) => a.key === 'disk')) {
      board.attention.push({
        key: 'disk',
        repo: repoKey,
        message: `Only ${gb(free)} free on the disk with ${repoKey}. Agents' builds, Orca and Matriarch stop saving once it is full: free some space to keep the pod moving.`
      })
    }
    // A config with errors may have lost a guard (a protected path, a reviewer): watch only.
    const acting = opts.autopilot && deps.executor !== null && cfg.errors.length === 0
    if (opts.autopilot && cfg.errors.length > 0) view.errors.push('The config has errors, so Matriarch only watches this repository until they are fixed.')

    const byBranch = new Map<string, Workspace>()
    for (const ws of repoWorkspaces) {
      const name = branchName(ws.branch)
      if (name && !byBranch.has(name)) byBranch.set(name, ws)
    }

    let summaries: PrSummary[] = []
    let viewer = ''
    let listed = false
    let base: { name: string; sha: string | null; rollup: string | null } | null = null
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

    const managed = summaries.filter((s) => follows(s, viewer)).sort((a, b) => a.number - b.number)

    const trackedKey = `tracked:${repoKey}`
    const tracked = toNumbers(await deps.store.get(trackedKey))
    const open = new Set(managed.map((s) => s.number))

    const items: { snap: PrSnapshot; ledger: PrLedger; ws: Workspace | undefined }[] = []
    const mergeBusy = new Set<string>()
    let runningReviews = 0
    for (const s of managed) {
      try {
        const snap = await snapshotFor(deps, info, s, now, detailAge, base && s.baseRef === base.name ? base.sha : null)
        if (!snap) continue
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
    // PRs Matriarch followed that left the open list: read their final state once.
    if (listed && forge) {
      for (const number of tracked.filter((n) => !open.has(n))) {
        try {
          const { pr } = await forge.detail(info.ref, number)
          if (!pr || pr.state === 'OPEN') continue
          // Its review rounds are moot now.
          if (deps.crew) await deps.crew.supersede(repoKey, number, null).catch(() => [])
          const ledger = loadLedger(await deps.store.get(ledgerKey(repoKey, number)))
          // Its records are pruned a week after this.
          if (!(await deps.store.get(`closed:${repoKey}#${number}`))) await deps.store.set(`closed:${repoKey}#${number}`, now)
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
        const act = deps.activity(ws.id, ws.path)
        if ((owner && owner.live !== false) || (act && ['working', 'waiting', 'blocked'].includes(act.activity))) {
          still.push({ ...c, kept: 'an agent is still running there' })
          continue
        }
        const res = await deps.removeWorktree(ws.path).catch((error: Error) => ({ removed: false, reason: error.message }))
        if (res.removed) {
          deps.log(`${repoKey}: removed the worktree of merged #${c.number} (${ws.path})`)
          continue
        }
        still.push({ ...c, kept: res.reason ?? 'not removed' })
        if (res.reason && res.reason !== c.kept) view.warnings.push(`Kept the worktree of merged #${c.number} (${ws.name}): ${res.reason}.`)
      }
      if (still.length !== pending.length || still.some((c, i) => c.kept !== pending[i]?.kept)) await deps.store.set(`cleanup:${repoKey}`, still as unknown as JsonValue)
    }

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
        if (ws.path === info.root || merging.has(ws.path) || prBranches.has(branchName(ws.branch) ?? '')) continue
        const row = byWorktree.get(ws)
        if (!row?.runId || `run:${row.runId}` !== supervisor || row.live !== false) continue
        const act = deps.activity(ws.id, ws.path)
        if (act && ['working', 'waiting', 'blocked'].includes(act.activity)) continue
        const since = seen[ws.path] ?? now
        if (now - since < FINISHED_GRACE_MS) {
          still[ws.path] = since
          continue
        }
        const res = await deps.removeWorktree(ws.path, { keepBranch: true }).catch((error: Error) => ({ removed: false, reason: error.message }))
        if (res.removed) deps.log(`${repoKey}: removed ${ws.name}, a finished worktree that never became a PR (${ws.path})`)
        else still[ws.path] = since
      }
      if (JSON.stringify(still) !== JSON.stringify(seen)) await deps.store.set(finishedKey, still as unknown as JsonValue)
    }

    const seenWorkspaces = new Set<string>()

    for (const item of items) {
      const { snap } = item
      const ws = item.ws
      const worker = ws ? byWorktree.get(ws) : undefined
      const owner = ws ? ownerFor(ws, worker, deps.activity(ws.id, ws.path)) : null
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
      const run = deps.crew ? await deps.crew.get(repoKey, snap.number, snap.headSha).catch(() => null) : null
      const p = plan({
        pr: snap,
        owner,
        ledger: item.ledger,
        config,
        supervisor,
        mergeSlotFree: !mergeBusy.has(snap.baseRef),
        reviewSlotFree: runningReviews < config.limits.maxConcurrentReviews,
        baseRed: base && base.name === snap.baseRef && (base.rollup === 'FAILURE' || base.rollup === 'ERROR') ? { sha: base.sha } : null,
        // Known only for the default branch: GitHub's rollup is null when its head has no checks at all.
        baseHasChecks: base && base.name === snap.baseRef ? base.rollup !== null : undefined,
        ownersKnown,
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

      let ledger = item.ledger
      const marks: Mark[] = []
      const ownerRow = item.ws ? byWorktree.get(item.ws) : undefined
      const ctx = { repo: info.ref, pr: snap, config, root: info.root, supervisor, worktree: item.ws?.path ?? null, ownerLive: ownerRow ? ownerRow.live !== false : null, owner: owner?.address ?? null }
      const run1 = async (a: Action) => {
        try {
          return await deps.executor!.execute(a, ctx)
        } catch (error) {
          return { ok: false, error: (error as Error).message }
        }
      }
      for (const action of p.actions) {
        if (action.kind === 'merge') mergeBusy.add(snap.baseRef)
        if (action.kind === 'start-review') runningReviews++
        if (!acting) continue
        // The pause switch is honoured between actions, not only between ticks.
        if (opts.stillOn && !(await opts.stillOn().catch(() => false))) break
        // A red base is one problem per repository: escalate it once, not once per ready PR.
        const escKey = action.kind === 'escalate' ? action.key : null
        const baseRedKey = escKey?.startsWith('base-red:') ? `base-red:${repoKey}` : null
        if (baseRedKey && (await deps.store.get(baseRedKey)) === escKey) {
          ledger = record(ledger, action, now)
          continue
        }
        const outcome = await run1(action)
        if (outcome.ok) {
          ledger = record(ledger, action, now)
          marks.push(markFor(action, now, kind))
          // Saved after each success, so a later failure in this tick cannot make it run twice.
          await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
          if (baseRedKey && escKey) await deps.store.set(baseRedKey, escKey)
          continue
        }
        if (outcome.skipped) continue
        view.errors.push(`#${snap.number} ${action.kind}: ${outcome.error ?? 'failed'}`)
        if (action.kind === 'merge') ledger = { ...ledger, merge: { sha: action.sha, at: now, status: 'failed', error: outcome.error } }
        // A supervisor that cannot be reached: tell the person now, and forget a Run Orca lost.
        if (action.kind === 'escalate' && action.to === 'supervisor') {
          if (/run_not_found|dispatch_not_found|not found/i.test(outcome.error ?? '')) await deps.store.set(`supervisor:${repoKey}`, '')
          const human: Action = { kind: 'escalate', to: 'human', key: action.key.replace(/:supervisor$/, ':human'), reason: `${action.reason} (the supervisor could not be reached)`, address: null }
          if ((await run1(human)).ok) {
            ledger = record(record(ledger, action, now), human, now)
            marks.push(markFor(human, now, kind))
            await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)
          }
        }
      }
      if (ledger !== item.ledger) await deps.store.set(ledgerKey(repoKey, snap.number), ledger as unknown as JsonValue)

      const trackKey = ws?.id ?? `pr:${repoKey}#${snap.number}`
      let history = loadHistory(await deps.store.get(historyKey(trackKey)))
      if (history.lastSha !== snap.headSha) {
        if (history.lastSha) history = addMark(history, { at: now, kind: 'push', label: `pushed ${short(snap.headSha)}` })
        history = { ...history, lastSha: snap.headSha }
      }
      for (const m of [...(crewMarks.get(`${repoKey}#${snap.number}`) ?? []), ...marks]) history = addMark(history, m)
      history = { ...prune(noteLane(history, p.lane, p.reason, now), now), seenAt: now }
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
        workspace: ws ? { id: ws.id, name: ws.name, branch: branchName(ws.branch) } : { id: trackKey, name: snap.headRef, branch: snap.headRef },
        pr: {
          number: snap.number,
          title: snap.title,
          url: snap.url,
          sha: snap.headSha,
          base: snap.baseRef,
          ci: snap.ci,
          failing: snap.checks.filter((c) => c.state === 'failure').map((c) => c.name),
          openThreads: actionableThreads(snap).length
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

    // Worktrees with no PR yet: building while their agent works, idle otherwise.
    for (const ws of repoWorkspaces) {
      if (seenWorkspaces.has(ws.id)) continue
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
      const act = deps.activity(ws.id, ws.path)
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

  board.tracks.sort(
    (a, b) =>
      LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane) ||
      a.repo.localeCompare(b.repo) ||
      (a.pr?.number ?? Infinity) - (b.pr?.number ?? Infinity) ||
      a.workspace.name.localeCompare(b.workspace.name)
  )
  return board
}

export type { TrackHistory, TrackView }
