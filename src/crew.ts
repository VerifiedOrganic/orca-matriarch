// Runs review rounds. A round gets its own worktree, pinned to the PR head. Every reviewer
// starts there on its own agent, model and effort, and writes a JSON verdict. When all of them
// settle, the crew's outcome is stored and the worktree is removed. Runs live in plugin
// storage, so a worker restart picks them up where they were.
import type { JsonValue } from 'orca/host'
import { modelFlags, type MatriarchConfig, type ReviewerSpec, type RoleSpec, type Severity } from './config.ts'
import type { Exec } from './exec.ts'
import type { PrSnapshot } from './github.ts'
import { LOCKABLE_AGENTS, type Lockdown, type LockMode } from './lockdown.ts'
import type { OrcaCli } from './orca-cli.ts'
import { aggregate, parseVerdict, reviewerBrief, verdictPath, type CrewFinding, type CrewOutcome, type Verdict } from './review.ts'

export const REVIEWER_TIMEOUT_MS = 30 * 60_000
/** A reviewer waiting this long on a person gives up; the round fails and can be run again. */
export const BLOCKED_MAX_MS = 24 * 3600_000
/** A reviewer quiet this long gets its terminal checked for a prompt that waits on a person. */
export const PROBE_AFTER_MS = 45_000

/** Agent prompts that stop a reviewer until a person answers, and what to tell them. */
export const BLOCKING_PROMPTS: { pattern: RegExp; reason: string }[] = [
  { pattern: /Bypass Permissions mode/i, reason: "Claude Code is waiting at its one-time bypass-permissions warning; accept it once in that terminal (the account Orca launches Claude with)" },
  { pattern: /trust the files in this folder|Do you trust/i, reason: 'the agent asks whether to trust this folder; answer it in that terminal' },
  { pattern: /Do you want to proceed\?|Allow this|approve this/i, reason: 'the agent is waiting for a permission answer in its terminal' },
  { pattern: /Please log ?in|not logged in|authentication required/i, reason: 'the agent needs you to sign in' },
  // An account out of usage cannot go on; another account or credits, then a restart, can.
  { pattern: /hit your usage limit|usage limit reached|reached your usage limit|purchase more credits|out of credits|insufficient (credits|quota)/i, reason: "the agent hit its account's usage limit; switch its account or add credits, then restart it" },
  { pattern: /Approaching rate limits|for lower credit usage\?/i, reason: 'the agent asks whether to switch to a cheaper model as it nears its rate limit; answer it in its terminal, or restart it' }
]

/**
 * An agent Orca resumed in a terminal without Matriarch's lockdown: Orca restores sessions (after
 * an account switch, a restart) with `codex … resume <id>` or `claude --resume <id>`, and its
 * launch hook does not run for restores. Matriarch never resumes a reviewer, so a resume line
 * without the lockdown flags is one. Answers the agent, or null.
 */
export function unlockedResume(lines: readonly string[]): 'codex' | 'claude' | null {
  for (const line of lines) {
    const m = line.match(/(?:^|[\s➜$%❯#])(codex|claude)\s.*(?:\bresume\b|--resume\b|--continue\b)/)
    if (!m) continue
    const locked = m[1] === 'codex' ? /workspace-write/.test(line) : /dontAsk/.test(line)
    if (!locked) return m[1] as 'codex' | 'claude'
  }
  return null
}

/** The reviewer's agent quit by itself (an update that asks for a restart). */
export const AGENT_QUIT = /Please restart Codex|Update ran successfully|Please restart Claude/i

/** How often one reviewer is started again by Matriarch itself in a round. */
export const MAX_RESTARTS = 2

export function blockingReason(lines: readonly string[]): string | null {
  const text = lines.slice(-40).join('\n')
  return BLOCKING_PROMPTS.find((p) => p.pattern.test(text))?.reason ?? null
}
export const REVIEW_BRANCH_PREFIX = 'matriarch/review-'

export interface CrewReviewer {
  name: string
  agent: string
  model: string | null
  effort: string | null
  focus: string | null
  blocking: boolean
  status: 'running' | 'done' | 'failed'
  terminal: string | null
  startedAt: number
  endedAt: number | null
  error: string | null
  verdict: Verdict | null
  /** Why the reviewer is stuck waiting on a person, when its terminal shows a known prompt. */
  blocked?: string | null
  /** The terminal showing that prompt, so the board can open it. */
  blockedTerminal?: string | null
  /** When it started waiting on that prompt. */
  blockedSince?: number | null
  /** When it last started working (after launch, or after a person answered its prompt). */
  activeSince?: number
  /** How it was started: locked down by its agent, or not (`readOnly: false`). */
  lock?: LockMode | null
  /** Times Matriarch started it again in this round. */
  restarts?: number
  /** Moved to the fallback agent after its own account hit its usage limit. */
  fellBack?: boolean
}

export interface CrewRun {
  v: 1
  repo: string
  number: number
  sha: string
  round: number
  headRef: string
  baseRef: string
  pass: MatriarchConfig['review']['pass']
  blockAt: Severity
  startedAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  worktree: { path: string; workspaceId: string | null } | null
  reviewers: CrewReviewer[]
  outcome: CrewOutcome | null
  error: string | null
  cleaned: boolean
  /** Last seen output cursor per terminal in the worktree, to tell a working agent from a quiet one. */
  cursors?: Record<string, number>
  /**
   * A hash of each terminal's last lines. A TUI that redraws in place (a thinking agent's timer)
   * changes these without moving the cursor.
   */
  signatures?: Record<string, string>
  /** When any terminal in the worktree last produced output (ms). */
  lastOutputAt?: number | null
  /** The PR's title and the round limit, to brief a reviewer started again. */
  title?: string
  maxRounds?: number
  /** Later rounds look only at what changed (`review.followUp: focused`). */
  focused?: boolean
  /** Who takes over a reviewer whose account hits its usage limit (`review.fallback`). */
  fallback?: RoleSpec | null
}

export interface CrewStore {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
}

export interface CrewDeps {
  orca: OrcaCli
  exec: Exec
  /** File text, or null when it does not exist yet. */
  readFile(path: string): Promise<string | null>
  store: CrewStore
  now(): number
  log(message: string): void
  /** The Orca workspace id of a worktree path, once Orca lists it. */
  workspaceIdFor(path: string): Promise<string | null>
  /** Removes the worktree after a finished round; on by default, off to inspect a run. */
  cleanup?: boolean
  /** Called once each time a reviewer starts waiting on a person. */
  alert?: (run: CrewRun, reviewer: CrewReviewer) => Promise<void>
  /**
   * The launch hook's record. With it, every reviewer must be confirmed started read-only, and
   * one that was not is stopped at once. Without it (tests of other parts) launches are trusted.
   */
  lockdown?: Pick<Lockdown, 'exempt' | 'confirmed' | 'forget'> & Partial<Pick<Lockdown, 'recall'>>
  /** How long to wait for that confirmation; LOCK_CONFIRM_MS by default. */
  lockConfirmMs?: number
}

/** How long a launch may take to be confirmed by the hook after `orca agent launch` answers. */
export const LOCK_CONFIRM_MS = 3_000

export const runKey = (repo: string, number: number, sha: string): string => `crew:${repo}#${number}:${sha}`

/** A short, stable hash (djb2) for comparing terminal tails without storing them. */
export function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(16)
}
/** How long a failed round's worktree is watched for late verdicts. */
export const LATE_VERDICT_MS = 2 * 3600_000
const lastKey = (repo: string, number: number): string => `crew:last:${repo}#${number}`
const ACTIVE = 'crew:active'
/** Failed rounds whose worktree is kept a while, for late verdicts and to inspect. */
const KEPT = 'crew:kept'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The worktree path in an `orca worktree create` receipt. */
export function createdPath(result: unknown): string | null {
  const r = obj(result)
  return str(obj(r.worktree).path) ?? str(r.path) ?? str(obj(r.workspace).path)
}

/** The workspace id in an `orca worktree create` receipt, when it carries one. */
export function createdId(result: unknown): string | null {
  const r = obj(result)
  return str(obj(r.worktree).id) ?? str(r.id) ?? str(obj(r.workspace).id)
}

/** The terminal an `orca agent launch` receipt names. */
export function launchedTerminal(result: unknown): string | null {
  const r = obj(result)
  const outcome = obj(r.outcome)
  return str(outcome.handle) ?? str(outcome.terminalId) ?? str(r.terminal) ?? str(r.handle) ?? str(r.terminalId) ?? str(obj(r.launch).handle)
}

export interface StartInput {
  pr: PrSnapshot
  /** The repository's main checkout. */
  root: string
  config: MatriarchConfig
  round: number
  reviewers: readonly ReviewerSpec[]
}

export interface Crew {
  start(input: StartInput): Promise<CrewRun>
  /** Advances running rounds; answers those that finished in this call. */
  poll(): Promise<CrewRun[]>
  get(repo: string, number: number, sha: string): Promise<CrewRun | null>
  /**
   * A round that failed because reviewers ran out of time completes after all if their verdicts
   * arrive later, while its worktree still exists. Answers the round when it completed now.
   */
  revive(repo: string, number: number, sha: string): Promise<CrewRun | null>
  /**
   * Stops running rounds of this PR on any commit other than its head: their review is moot.
   * Answers the rounds it stopped.
   */
  supersede(repo: string, number: number, headSha: string | null): Promise<CrewRun[]>
  /** Removes worktrees kept for failed rounds once their late-verdict window has passed. */
  sweep(): Promise<void>
  /** Workspaces and paths of running rounds, for the read-only hook (no await there). */
  guard(): { ids: ReadonlySet<string>; paths: readonly string[]; pathOf: ReadonlyMap<string, string> }
  /** Loads the guard from storage after a restart. */
  load(): Promise<void>
  /**
   * Starts one reviewer of a running round again, in the same worktree and locked down the same
   * way, after whatever stopped it (a usage limit, a prompt) was dealt with. The others keep going.
   */
  restart(input: { pr: PrSnapshot; config: MatriarchConfig; name: string }): Promise<{ restarted: boolean; message: string }>
}

export function createCrew(deps: CrewDeps): Crew {
  const ids = new Set<string>()
  const paths: string[] = []
  const pathOf = new Map<string, string>()
  const cleanup = deps.cleanup !== false

  const remember = (run: CrewRun) => {
    if (!run.worktree) return
    if (run.worktree.workspaceId) {
      ids.add(run.worktree.workspaceId)
      pathOf.set(run.worktree.workspaceId, run.worktree.path)
    }
    if (!paths.includes(run.worktree.path)) paths.push(run.worktree.path)
  }
  const forget = (run: CrewRun) => {
    if (!run.worktree) return
    if (run.worktree.workspaceId) {
      ids.delete(run.worktree.workspaceId)
      pathOf.delete(run.worktree.workspaceId)
    }
    const i = paths.indexOf(run.worktree.path)
    if (i >= 0) paths.splice(i, 1)
  }

  async function listAt(key: string): Promise<string[]> {
    const v = await deps.store.get(key)
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  }
  const active = () => listAt(ACTIVE)
  async function keep(key: string, on: boolean): Promise<void> {
    const list = await listAt(KEPT)
    const next = on ? [...new Set([...list, key])] : list.filter((k) => k !== key)
    if (next.length !== list.length) await deps.store.set(KEPT, next)
  }
  async function removeWorktree(run: CrewRun): Promise<void> {
    if (!run.worktree || run.cleaned) return
    try {
      await deps.orca.run(['worktree', 'rm', '--worktree', `path:${run.worktree.path}`, '--force', '--delete-branch'])
      run.cleaned = true
      // Only now are its agents gone, so only now does the read-only guard let go.
      forget(run)
      deps.lockdown?.forget(run.worktree.path)
    } catch (error) {
      deps.log(`review worktree ${run.worktree.path} not removed: ${(error as Error).message}`)
    }
  }
  async function save(run: CrewRun): Promise<void> {
    await deps.store.set(runKey(run.repo, run.number, run.sha), run as unknown as JsonValue)
  }
  async function git(cwd: string, args: string[], timeoutMs = 120_000) {
    return deps.exec('git', ['-C', cwd, ...args], { timeoutMs })
  }

  async function get(repo: string, number: number, sha: string): Promise<CrewRun | null> {
    const v = await deps.store.get(runKey(repo, number, sha))
    return v && typeof v === 'object' ? (v as CrewRun) : null
  }

  async function previousOutcome(repo: string, number: number, sha: string): Promise<{ sha: string; findings: CrewFinding[] } | null> {
    const key = await deps.store.get(lastKey(repo, number))
    if (typeof key !== 'string') return null
    const prev = (await deps.store.get(key)) as CrewRun | null
    if (!prev?.outcome || prev.sha === sha) return null
    return { sha: prev.sha, findings: prev.outcome.blocking }
  }

  async function settle(run: CrewRun): Promise<void> {
    const results = run.reviewers.map((r) => ({
      reviewer: { name: r.name, agent: r.agent, blocking: r.blocking } as ReviewerSpec,
      verdict: r.verdict
    }))
    const verdicts = run.reviewers.filter((r) => r.verdict).length
    const missingBlocker = run.pass === 'all-blocking-approve' && run.reviewers.some((r) => r.blocking && !r.verdict)
    // A vote needs a quorum: more than half the crew must have answered.
    const noQuorum = run.pass !== 'all-blocking-approve' && verdicts * 2 <= run.reviewers.length
    if (verdicts === 0 || missingBlocker || noQuorum) {
      run.status = 'failed'
      run.error = verdicts === 0 ? 'no reviewer wrote a verdict' : missingBlocker ? 'a blocking reviewer wrote no verdict' : 'too few reviewers wrote a verdict to decide'
    } else {
      run.status = 'done'
      run.outcome = aggregate(results, { pass: run.pass, blockAt: run.blockAt } as MatriarchConfig['review'])
    }
    run.endedAt = deps.now()
    const key = runKey(run.repo, run.number, run.sha)
    if (run.status === 'done' && cleanup) await removeWorktree(run)
    // Anything whose worktree is still there stays listed, so the sweep retries or expires it.
    // A failed round's agents may still be working: its guard stays on until the worktree goes.
    if (run.worktree && !run.cleaned) await keep(key, true)
    else await keep(key, false)
    await deps.store.set(lastKey(run.repo, run.number), runKey(run.repo, run.number, run.sha))
  }

  /**
   * Reads every terminal in the round's worktree: their tails (to spot prompts) and whether any
   * produced output since the last look. Output means an agent is still working.
   */
  async function observe(run: CrewRun, now: number): Promise<{ tails: Map<string, string[]>; advanced: boolean }> {
    const tails = new Map<string, string[]>()
    if (!run.worktree) return { tails, advanced: false }
    const listed = obj(await deps.orca.run(['terminal', 'list', '--worktree', `path:${run.worktree.path}`]).catch(() => null))
    const handles = (Array.isArray(listed.terminals) ? listed.terminals : []).map((t) => str(obj(t).handle)).filter((h): h is string => h !== null)
    for (const r of run.reviewers) if (r.terminal && !handles.includes(r.terminal)) handles.push(r.terminal)
    const before = run.cursors ?? null
    const beforeSig = run.signatures ?? null
    const cursors: Record<string, number> = {}
    const signatures: Record<string, string> = {}
    let advanced = false
    for (const h of handles) {
      const t = obj(obj(await deps.orca.run(['terminal', 'read', '--terminal', h]).catch(() => null)).terminal)
      const tail = Array.isArray(t.tail) ? t.tail.map(String) : []
      tails.set(h, tail)
      const sig = hashText(tail.slice(-12).join('\n'))
      signatures[h] = sig
      if (beforeSig && beforeSig[h] !== undefined && beforeSig[h] !== sig) advanced = true
      const cursor = typeof t.latestCursor === 'number' ? t.latestCursor : null
      if (cursor === null) continue
      cursors[h] = cursor
      if (before && cursor > (before[h] ?? -1)) advanced = true
    }
    run.cursors = cursors
    run.signatures = signatures
    if (advanced) run.lastOutputAt = now
    return { tails, advanced }
  }

  /** Starts one reviewer in the round's worktree, locked down, and confirms it was. */
  async function launchReviewer(
    path: string,
    pr: PrSnapshot,
    reviewer: ReviewerSpec,
    round: number,
    maxRounds: number,
    previous: { sha: string; findings: CrewFinding[] } | null,
    focused = false
  ): Promise<CrewReviewer> {
        const brief = reviewerBrief({ pr, reviewer, round, maxRounds, previous, focused })
        const args = ['agent', 'launch', '--agent', reviewer.agent, '--worktree', `path:${path}`, '--surface', 'terminal', '--prompt', brief]
        args.push(...modelFlags(reviewer))
        const entry: CrewReviewer = {
          name: reviewer.name,
          agent: reviewer.agent,
          model: reviewer.model ?? null,
          effort: reviewer.effort ?? null,
          focus: reviewer.focus ?? null,
          blocking: reviewer.blocking,
          status: 'running',
          terminal: null,
          startedAt: deps.now(),
          endedAt: null,
          error: null,
          verdict: null
        }
        const failed = (error: string) => Object.assign(entry, { status: 'failed', error, endedAt: deps.now() })
        const lockable = LOCKABLE_AGENTS.includes(reviewer.agent)
        if (!lockable && reviewer.readOnly !== false) {
          failed(`not started: Matriarch can start only claude and codex reviewers read-only. Set "readOnly": false on "${reviewer.name}" to run ${reviewer.agent} with your usual permissions.`)
          return entry
        }
        if (!lockable) deps.lockdown?.exempt(path, reviewer.agent)
        const since = deps.now()
        try {
          entry.terminal = launchedTerminal(await deps.orca.run(args))
        } catch (error) {
          failed(`launch failed: ${(error as Error).message}`)
        }
        if (entry.status === 'running' && deps.lockdown) {
          // The hook runs while Orca starts the agent; give a slow answer a moment.
          // A reload of the plugin mid-launch sends the hook to the new copy: its record counts too.
          const lock = deps.lockdown
          const check = async () => lock.confirmed(path, reviewer.agent, since) ?? (lock.recall ? await lock.recall(path, reviewer.agent, since) : null)
          let mode = await check()
          for (let waited = 0; !mode && waited < (deps.lockConfirmMs ?? LOCK_CONFIRM_MS); waited += 250) {
            await new Promise((r) => setTimeout(r, 250))
            mode = await check()
          }
          entry.lock = mode
          if (!mode) {
            // Orca started it without the lockdown (the hook timed out or did not run): stop it.
            if (entry.terminal) await deps.orca.run(['terminal', 'close', '--terminal', entry.terminal]).catch(() => {})
            failed(
              entry.terminal
                ? 'stopped: Orca started it without Matriarch\'s read-only lockdown (the launch hook did not answer in time)'
                : 'Orca started it without Matriarch\'s read-only lockdown and gave no terminal to stop; close it in the review worktree'
            )
          }
        }
        return entry
  }

  /** The reviewer at `i` started again, locked down, with its own settings. */
  async function relaunch(run: CrewRun, i: number, why: string, on?: RoleSpec): Promise<CrewReviewer> {
    const old = run.reviewers[i]
    const role: RoleSpec = on ?? { agent: old.agent, ...(old.model ? { model: old.model } : {}), ...(old.effort ? { effort: old.effort } : {}) }
    const spec: ReviewerSpec = {
      name: old.name, blocking: old.blocking, ...role,
      ...(old.focus ? { focus: old.focus } : {}),
      ...(old.lock === 'off' && !on ? { readOnly: false } : {})
    }
    const pr = { repo: run.repo, number: run.number, title: run.title ?? '', headSha: run.sha, headRef: run.headRef, baseRef: run.baseRef } as PrSnapshot
    if (old.terminal) await deps.orca.run(['terminal', 'close', '--terminal', old.terminal]).catch(() => {})
    const entry = await launchReviewer(run.worktree!.path, pr, spec, run.round, run.maxRounds ?? 3, await previousOutcome(run.repo, run.number, run.sha), run.focused === true)
    entry.restarts = (old.restarts ?? 0) + 1
    if (on || old.fellBack) entry.fellBack = true
    run.reviewers[i] = entry
    run.lastOutputAt = deps.now()
    deps.log(`${run.repo} #${run.number}: started the ${old.name} reviewer again (${why})`)
    return entry
  }

  return {
    get,
    guard: () => ({ ids, paths, pathOf }),
    async revive(repo, number, sha) {
      const run = await get(repo, number, sha)
      if (!run || run.status !== 'failed' || !run.worktree || run.cleaned) return null
      if (deps.now() - (run.endedAt ?? run.startedAt) > LATE_VERDICT_MS) return null
      let changed = false
      for (const r of run.reviewers) {
        if (r.status !== 'failed' || r.verdict || !(r.error ?? '').startsWith('timed out')) continue
        const text = await deps.readFile(`${run.worktree.path}/${verdictPath(run.sha, r.name)}`).catch(() => null)
        const verdict = text ? parseVerdict(text) : null
        if (!verdict) continue
        r.status = 'done'
        r.verdict = verdict
        r.error = null
        r.endedAt = deps.now()
        changed = true
      }
      if (changed) {
        await settle(run)
        await save(run)
        // settle() moved the status on; read it fresh rather than as narrowed above.
        if ((run.status as CrewRun['status']) === 'done') return run
      }
      // Timed out but still producing output: it was never failing, only slow. Resume the round.
      const timedOut = run.reviewers.filter((r) => r.status === 'failed' && !r.verdict && (r.error ?? '').startsWith('timed out'))
      if (timedOut.length === 0) return null
      const now = deps.now()
      const { advanced } = await observe(run, now)
      if (!advanced) {
        await save(run) // keeps the cursors, to compare on the next look
        return null
      }
      for (const r of timedOut) {
        r.status = 'running'
        r.error = null
        r.endedAt = null
        r.activeSince = now
      }
      run.status = 'running'
      run.error = null
      run.endedAt = null
      remember(run)
      await save(run)
      await keep(runKey(run.repo, run.number, run.sha), false)
      const list = await active()
      await deps.store.set(ACTIVE, [...new Set([...list, runKey(run.repo, run.number, run.sha)])])
      return run
    },
    async supersede(repo, number, headSha) {
      const prefix = `crew:${repo}#${number}:`
      const stopped: CrewRun[] = []
      const keys = await active()
      for (const key of keys) {
        if (!key.startsWith(prefix) || (headSha !== null && key === runKey(repo, number, headSha))) continue
        const run = (await deps.store.get(key)) as CrewRun | null
        if (!run || run.status !== 'running') continue
        run.status = 'failed'
        run.error = headSha ? `superseded: the PR moved to ${headSha.slice(0, 7)}` : 'stopped: the PR was merged or closed'
        run.endedAt = deps.now()
        for (const r of run.reviewers) if (r.status === 'running') Object.assign(r, { status: 'failed', error: 'superseded', endedAt: run.endedAt })
        await removeWorktree(run)
        if (!run.cleaned) await keep(key, true)
        await save(run)
        stopped.push(run)
      }
      if (stopped.length > 0) {
        const gone = new Set(stopped.map((r) => runKey(r.repo, r.number, r.sha)))
        await deps.store.set(ACTIVE, keys.filter((k) => !gone.has(k)))
      }
      return stopped
    },

    async sweep() {
      const kept = await listAt(KEPT)
      if (kept.length === 0) return
      const still: string[] = []
      for (const key of kept) {
        const run = (await deps.store.get(key)) as CrewRun | null
        if (!run || run.cleaned || !run.worktree) continue
        if (run.status === 'running') {
          still.push(key)
          continue
        }
        if (run.status === 'failed' && deps.now() - (run.endedAt ?? run.startedAt) <= LATE_VERDICT_MS) {
          still.push(key)
          continue
        }
        await removeWorktree(run)
        await save(run)
        if (!run.cleaned) still.push(key)
      }
      if (still.length !== kept.length) await deps.store.set(KEPT, still)
    },

    async restart({ pr, config, name }) {
      const run = await get(pr.repo, pr.number, pr.headSha)
      if (!run || run.status !== 'running' || !run.worktree || run.cleaned) return { restarted: false, message: 'that review round is not running; run the review again instead' }
      const i = run.reviewers.findIndex((r) => r.name === name)
      if (i < 0) return { restarted: false, message: `no reviewer "${name}" in this round` }
      const old = run.reviewers[i]
      if (old.status === 'done') return { restarted: false, message: `${name} already wrote its verdict` }
      const spec: ReviewerSpec = config.reviewers.find((r) => r.name === name) ?? {
        name: old.name, agent: old.agent, blocking: old.blocking,
        ...(old.model ? { model: old.model } : {}), ...(old.effort ? { effort: old.effort } : {}), ...(old.focus ? { focus: old.focus } : {})
      }
      if (old.terminal) await deps.orca.run(['terminal', 'close', '--terminal', old.terminal]).catch(() => {})
      const entry = await launchReviewer(run.worktree.path, pr, spec, run.round, config.review.maxRounds, await previousOutcome(pr.repo, pr.number, pr.headSha), config.review.followUp === 'focused')
      run.reviewers[i] = entry
      // Its quiet time starts over with it.
      run.lastOutputAt = deps.now()
      await save(run)
      return entry.status === 'running'
        ? { restarted: true, message: `${name} restarted (${entry.agent}${entry.model ? ` ${entry.model}` : ''})` }
        : { restarted: false, message: `${name} could not be restarted: ${entry.error ?? 'unknown'}` }
    },

    async load() {
      for (const key of [...(await active()), ...(await listAt(KEPT))]) {
        const run = (await deps.store.get(key)) as CrewRun | null
        if (run && run.worktree && !run.cleaned) remember(run)
      }
    },

    async start({ pr, root, config, round, reviewers }) {
      const existing = await get(pr.repo, pr.number, pr.headSha)
      if (existing?.status === 'running') return existing
      // A re-run replaces an earlier attempt on this commit: remove what it left first.
      if (existing?.worktree && !existing.cleaned) {
        await removeWorktree(existing)
        await save(existing)
        if (existing.cleaned) await keep(runKey(existing.repo, existing.number, existing.sha), false)
      }
      const now = deps.now()
      const run: CrewRun = {
        v: 1,
        repo: pr.repo,
        number: pr.number,
        sha: pr.headSha,
        round,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        pass: config.review.pass,
        blockAt: config.review.blockAt,
        startedAt: now,
        endedAt: null,
        status: 'running',
        worktree: null,
        reviewers: [],
        outcome: null,
        error: null,
        cleaned: false,
        title: pr.title,
        maxRounds: config.review.maxRounds,
        focused: config.review.followUp === 'focused',
        fallback: config.review.fallback
      }
      const fail = async (error: string) => {
        run.status = 'failed'
        run.error = error
        run.endedAt = deps.now()
        forget(run)
        await save(run)
        // A worktree made before the failure is swept later, like any failed round's.
        if (run.worktree) await keep(runKey(run.repo, run.number, run.sha), true)
        return run
      }

      // 1. A worktree at the exact head commit.
      const fetched = await git(root, ['fetch', '--quiet', 'origin', pr.headRef, pr.baseRef])
      if (fetched.code !== 0) return fail(`git fetch failed: ${fetched.stderr.trim().slice(0, 300)}`)
      const short = pr.headSha.slice(0, 7)
      // Unique per attempt, so a re-run never collides with a worktree kept from before.
      const attempt = now.toString(36).slice(-4)
      let path: string | null
      let createdWorkspace: string | null = null
      try {
        const receipt = await deps.orca.run([
            'worktree', 'create', '--repo', `path:${root}`, '--name', `review-${pr.number}-${short}-${attempt}`,
            '--branch', `${REVIEW_BRANCH_PREFIX}${pr.number}-${short}-${attempt}`, '--base-branch', `origin/${pr.headRef}`,
            '--setup', 'skip', '--no-parent', '--comment', `Matriarch review of #${pr.number} at ${short}`
          ])
        path = createdPath(receipt)
        createdWorkspace = createdId(receipt)
      } catch (error) {
        return fail(`worktree create failed: ${(error as Error).message}`)
      }
      if (!path) return fail('worktree create gave no path')
      const head = await git(path, ['rev-parse', 'HEAD'], 15_000)
      if (head.stdout.trim() !== pr.headSha) {
        const moved = await git(path, ['checkout', '--quiet', '--detach', pr.headSha], 30_000)
        if (moved.code !== 0) return fail(`could not check out ${short}: ${moved.stderr.trim().slice(0, 200)}`)
      }
      run.worktree = { path, workspaceId: createdWorkspace ?? (await deps.workspaceIdFor(path).catch(() => null)) }
      remember(run)
      // Make it recognisable in Orca's sidebar: named for the PR, linked to it, with a note.
      await deps.orca
        .run(['worktree', 'set', '--worktree', `path:${path}`, '--display-name', `Matriarch review · #${pr.number} · ${short}`, '--pr', String(pr.number), '--comment', `Matriarch AI review round ${round} of #${pr.number} at ${short}. Removed when the round ends.`])
        .catch((error: Error) => deps.log(`could not label ${path}: ${error.message}`))

      // 2. One agent per reviewer, each on its own model.
      const previous = await previousOutcome(pr.repo, pr.number, pr.headSha)
      for (const reviewer of reviewers) {
        const entry = await launchReviewer(path, pr, reviewer, round, config.review.maxRounds, previous, config.review.followUp === 'focused')
        run.reviewers.push(entry)
      }
      if (run.reviewers.every((r) => r.status === 'failed')) {
        // Nothing is reviewing, so nothing is worth keeping: the worktree goes now, with any
        // terminal that was started without the lockdown.
        await removeWorktree(run)
        return fail(`no reviewer could be started (${run.reviewers.map((r) => `${r.name}: ${r.error ?? 'failed'}`).join('; ')})`)
      }
      await save(run)
      const list = await active()
      await deps.store.set(ACTIVE, [...new Set([...list, runKey(run.repo, run.number, run.sha)])])
      return run
    },

    async poll() {
      const finished: CrewRun[] = []
      const keys = await active()
      const still: string[] = []
      for (const key of keys) {
        const run = (await deps.store.get(key)) as CrewRun | null
        if (!run || run.status !== 'running' || !run.worktree) continue
        if (!run.worktree.workspaceId) {
          // Orca may list a new worktree a little later; the read-only guard needs its id.
          run.worktree.workspaceId = await deps.workspaceIdFor(run.worktree.path).catch(() => null)
          remember(run)
        }
        const now = deps.now()
        let seen: { tails: Map<string, string[]>; advanced: boolean } | null = null
        // An agent Orca resumed here without the lockdown is closed at once, and a reviewer whose
        // agent quit is started again: both locked down, a bounded number of times.
        if (run.reviewers.some((r) => r.status === 'running') && now - run.startedAt > PROBE_AFTER_MS) {
          seen = await observe(run, now)
          for (const [handle, tail] of seen.tails) {
            const agent = unlockedResume(tail.slice(-60))
            if (!agent) continue
            await deps.orca.run(['terminal', 'close', '--terminal', handle]).catch(() => {})
            deps.log(`${run.repo} #${run.number}: closed ${handle}, where ${agent} was resumed without Matriarch's read-only lockdown`)
            seen.tails.delete(handle)
            for (let i = 0; i < run.reviewers.length; i++) {
              const r = run.reviewers[i]
              if (r.status === 'running' && r.agent === agent && (r.restarts ?? 0) < MAX_RESTARTS) await relaunch(run, i, `${agent} was resumed without the lockdown`)
            }
          }
          for (let i = 0; i < run.reviewers.length; i++) {
            const r = run.reviewers[i]
            if (r.status !== 'running' || !r.terminal || !AGENT_QUIT.test((seen.tails.get(r.terminal) ?? []).slice(-15).join('\n'))) continue
            if ((r.restarts ?? 0) < MAX_RESTARTS) await relaunch(run, i, 'its agent quit')
          }
        }
        for (const r of run.reviewers) {
          if (r.status !== 'running') continue
          const text = await deps.readFile(`${run.worktree.path}/${verdictPath(run.sha, r.name)}`).catch(() => null)
          const verdict = text ? parseVerdict(text) : null
          if (verdict) {
            r.status = 'done'
            r.verdict = verdict
            r.endedAt = now
            continue
          }
          if (now - r.startedAt <= PROBE_AFTER_MS) continue
          // Look at the worktree's terminals once per poll: prompts, and whether output still flows.
          seen ??= await observe(run, now)
          const handles = r.terminal ? [r.terminal] : [...seen.tails.keys()]
          let reason: string | null = null
          let where: string | null = null
          for (const h of handles) {
            reason = blockingReason(seen.tails.get(h) ?? [])
            if (reason) {
              where = h
              break
            }
          }
          const was = r.blocked
          r.blocked = reason
          r.blockedTerminal = reason ? where : null
          r.blockedSince = reason ? (was ? (r.blockedSince ?? now) : now) : null
          // Time spent waiting on a person does not count against the reviewer.
          if (was && !reason) r.activeSince = now
          if (reason && !was && deps.alert) await deps.alert(run, r).catch((error: Error) => deps.log(`alert failed: ${error.message}`))
          // Timed out means quiet: no verdict and no output for the whole limit, and not waiting on a person.
          const quietSince = Math.max(r.activeSince ?? r.startedAt, run.lastOutputAt ?? 0)
          if (!r.blocked && now - quietSince > REVIEWER_TIMEOUT_MS) {
            r.status = 'failed'
            r.error = text ? 'the verdict file is not valid JSON in the asked shape' : 'timed out without writing a verdict or any output'
            r.endedAt = now
          } else if (r.blocked && now - (r.blockedSince ?? now) > BLOCKED_MAX_MS) {
            r.status = 'failed'
            r.error = `waited ${Math.round(BLOCKED_MAX_MS / 3600_000)} h for a person: ${r.blocked}`
            r.endedAt = now
          }
        }
        // A reviewer whose account ran out moves to the fallback, once, rather than wait for a person.
        for (let i = 0; i < run.reviewers.length; i++) {
          const r = run.reviewers[i]
          const fb = run.fallback
          if (r.status !== 'running' || !r.blocked || !/usage limit/i.test(r.blocked) || r.fellBack || !fb) continue
          if (fb.agent === r.agent && (fb.model ?? null) === r.model) continue
          await relaunch(run, i, `its account hit its usage limit; moved to ${fb.agent}${fb.model ? ` ${fb.model}` : ''}`, fb)
        }
        if (run.reviewers.every((r) => r.status !== 'running')) {
          await settle(run)
          finished.push(run)
        } else {
          still.push(key)
        }
        await save(run)
      }
      if (keys.length !== still.length) await deps.store.set(ACTIVE, still)
      return finished
    }
  }
}
