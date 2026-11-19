// The planner: pure. From one PR's snapshot, its owning worker, the ledger of what Matriarch
// already did and the repo config, it answers the PR's lane, why, and the next actions.
// Every tick re-plans from current facts, so a message held back while a worker was busy goes
// out once it is free, and nothing is sent twice for the same commit. It reads GitHub and GitLab
// alike; only the words and commands in its reasons come from the PR's forge.
import { clip, shortSha } from './values.ts'
import { ALWAYS_FULL_REVIEW, type MatriarchConfig, type ReviewerSpec, type RoleSpec } from './config.ts'
import { forgeTerms } from './forge.ts'
import { actionableThreads, type CheckInfo, type PrSnapshot, type ThreadInfo } from './github.ts'
import { everyPathMatches, matchingGlobs } from './glob.ts'
import { checkKey, roundsUsed, type PrLedger, type StackParent } from './ledger.ts'
import { restackCommand } from './messages.ts'
import { LOCKABLE_AGENTS } from './lockdown.ts'

export type Lane =
  | 'building' // a worktree whose agent is working, no PR yet
  | 'idle' // a worktree with no PR and no agent working
  | 'working' // the PR's worker is mid-turn
  | 'awaiting-ci'
  | 'fixing-ci'
  | 'fixing-conflict'
  | 'fixing-review'
  | 'fixing' // a worker is changing the PR after its first version, for a reason Matriarch did not send
  | 'ai-review'
  | 'needs-you'
  | 'ready'
  | 'merging'
  | 'merged'
  | 'closed'
  | 'draft'

export type Activity = 'working' | 'waiting' | 'blocked' | 'done' | 'unknown'

/** The orchestration worker (or plain agent) whose workspace holds the PR's branch. */
export interface Owner {
  /** Where feedback goes: `dispatch:<id>`. Null when no supervised worker owns it. */
  address: string | null
  activity: Activity
  /** When `activity` began (ms). */
  since: number
  agent: string | null
  model: string | null
  workspaceId: string | null
}

export type Action =
  | { kind: 'send-ci-failure'; to: string; sha: string; round: number; checks: CheckInfo[]; signature: string }
  | { kind: 'send-rebase'; to: string; sha: string; round: number; base: string }
  | { kind: 'send-comments'; to: string; sha: string; round: number; threads: ThreadInfo[] }
  | { kind: 'update-branch'; sha: string; method: 'rebase' | 'merge' }
  | { kind: 'start-review'; sha: string; round: number; reviewers: ReviewerSpec[] }
  | { kind: 'send-findings'; to: string; sha: string; round: number }
  | { kind: 'publish-review'; sha: string; round: number }
  /** Merges the PR at `sha`; whether its branch goes with it is decided as it merges (executor.ts branchAtMerge). */
  | { kind: 'merge'; sha: string; method: 'squash' | 'merge' | 'rebase' }
  | { kind: 'escalate'; to: 'supervisor' | 'human'; key: string; reason: string; address: string | null }
  | { kind: 'notify'; key: string; title: string; body: string }
  /** Points the PR at its merged parent's base, when the forge left it on the parent's branch. */
  | { kind: 'retarget'; sha: string; parent: number; from: string; base: string }
  /** Asks the branch's owner to rebase it off a merged parent's commits. */
  | { kind: 'send-restack'; to: string; sha: string; parent: number; parentSha: string; base: string }
  /**
   * Runs failed checks' jobs once more: they looked like the infrastructure failing (flaky.ts).
   * Several only when they are jobs of one GitHub workflow run, which re-runs them together.
   */
  | { kind: 'rerun-check'; sha: string; checks: CheckInfo[]; why: string }

export interface PlanInput {
  pr: PrSnapshot
  owner: Owner | null
  ledger: PrLedger
  config: MatriarchConfig
  /** The supervisor's Run mailbox (`run:<id>`), when one is known. */
  supervisor: string | null
  /** No other merge into this PR's base branch is in flight. */
  mergeSlotFree: boolean
  /** Fewer reviews are running than `limits.maxConcurrentReviews`. */
  reviewSlotFree: boolean
  /** CI on the PR's base branch is red (known only for the default branch). */
  baseRed?: { sha: string | null } | null
  /** False when Orca's worker list could not be read: a PR without an owner is not orphaned then. */
  ownersKnown?: boolean
  /** Whether the base branch's head has any checks; false means the repository runs no CI there. */
  baseHasChecks?: boolean
  /** The PR this one is stacked on (its base is, or was, that PR's head branch), from the ledger. */
  stack?: StackParent | null
  /**
   * This PR's base is a branch with a worktree here, so it may be another open PR's head, and the
   * forge's list of open PRs was cut short: Matriarch cannot rule out that it is stacked.
   */
  unlistedBase?: boolean
  now: number
}

export interface Plan {
  lane: Lane
  reason: string
  actions: Action[]
}


/** A new commit's checks take a moment to register; until then "no checks" is not "green". */
export const CI_GRACE_MS = 3 * 60_000
/** A merge the forge has not completed by now has stalled (a merge queue dropped it, say). */
export const MERGE_TIMEOUT_MS = 30 * 60_000
/**
 * After a re-run is requested, the failed attempt can still be what the forge shows for a moment.
 * Until the forge shows a new attempt (a new job id), or for this long, the check is starting again.
 */
export const RERUN_START_MS = 10 * 60_000
/** A branch asked to rebase off its merged parent that has not moved in this long is escalated. */
export const RESTACK_STALL_MS = 60 * 60_000

export function ciSignature(checks: readonly CheckInfo[]): string {
  return checks
    .filter((c) => c.state === 'failure')
    .map((c) => c.name)
    .sort()
    .join('|')
}

/**
 * Reviewers for a PR. With `differentProviderThanAuthor`, a reviewer on the author's own agent
 * reviews on the first other reviewer's agent, model and thinking level instead, keeping its name,
 * focus and whether it blocks: every focus is still looked at, by an agent that did not write the
 * code. Only an agent Matriarch starts read-only (Claude Code, Codex) takes a moved reviewer: one
 * another reviewer runs without the lockdown was let off for that reviewer alone. With no such
 * agent to move to, every reviewer runs on its own.
 */
export function selectReviewers(config: MatriarchConfig, authorAgent: string | null): { reviewers: ReviewerSpec[]; note: string | null } {
  const all = config.reviewers
  if (!config.review.differentProviderThanAuthor || !authorAgent) return { reviewers: all, note: null }
  const moved = all.filter((r) => r.agent === authorAgent)
  if (moved.length === 0) return { reviewers: all, note: null }
  const other = all.find((r) => r.agent !== authorAgent && LOCKABLE_AGENTS.includes(r.agent))
  if (!other) return { reviewers: all, note: `no reviewer to move off ${authorAgent}, the author's agent, onto another agent started read-only` }
  // Only the fields the other reviewer sets: stored and sent as plain JSON, with no undefined.
  const role: RoleSpec = { agent: other.agent }
  if (other.model) role.model = other.model
  if (other.effort) role.effort = other.effort
  const reviewers = all.map((r) => {
    if (r.agent !== authorAgent) return r
    const { model: _model, effort: _effort, readOnly: _readOnly, ...own } = r
    return { ...own, ...role }
  })
  const on = other.model ? `${other.agent} (${other.model})` : other.agent
  return { reviewers, note: `${moved.map((r) => r.name).join(', ')} on ${on}, since ${authorAgent} wrote it` }
}

/**
 * Whether the PR is a light change (`review.light`): every changed file matches its paths, none is
 * an agent's instructions or a tool's config (ALWAYS_FULL_REVIEW), none was renamed or copied
 * (its old path is not known), and the forge listed them all and said which moved. Answers the
 * globs that matched, to say why, or null. Anything the forge cannot say counts against it.
 */
export function lightChange(config: MatriarchConfig, pr: PrSnapshot): string[] | null {
  if (!Array.isArray(pr.renamed) || pr.renamed.length > 0) return null
  return lightPaths(config, pr)
}

/**
 * The light test without renames: the forge listed every file, each matches the light paths and
 * none always gets the full crew. A PR that passes it but whose forge cannot say what was renamed
 * (GitLab) is worth asking file by file. Answers the globs that matched, or null.
 */
export function lightPaths(config: MatriarchConfig, pr: PrSnapshot): string[] | null {
  const { paths } = config.review.light
  if (pr.filesTruncated || !everyPathMatches(paths, pr.files) || matchingGlobs(ALWAYS_FULL_REVIEW, pr.files, { ignoreCase: true }).length > 0) return null
  return matchingGlobs(paths, pr.files)
}

/** Tries at moving a stacked PR's base before it is escalated. */
export const RETARGET_TRIES = 3
/** The wait after a refused move of the base: 5 minutes, then 10. */
export const retargetBackoff = (failures: number): number => 5 * 60_000 * 2 ** Math.max(0, failures - 1)

/** Minutes ago, as a person reads them. */
const minAgo = (now: number, at: number): string => `${Math.max(1, Math.round((now - at) / 60_000))} min ago`

/** The supervisor's answer as the person reads it: its latest words, with when it wrote those, and when it first answered if earlier. */
function answeredWords(a: { at: number; text: string; textAt?: number; count?: number }, now: number): string {
  const wrote = a.textAt ?? a.at
  const first = (a.count ?? 1) > 1 && wrote !== a.at ? ` (it first answered ${minAgo(now, a.at)})` : ''
  return `The supervisor wrote ${minAgo(now, wrote)}${first}: "${clip(a.text.replace(/\s+/g, ' ').trim(), 400)}"`
}

/**
 * Worker → supervisor → human. Each step happens once per problem key (which carries the commit,
 * so a new push starts over). The person hears of it once the supervisor has had
 * `humanAfterMinutes` to deal with it; a supervisor that answered gets that long again from its
 * first answer, and if the problem is still there after it, the person hears with its answer.
 */
function escalate(input: PlanInput, problemKey: string, reason: string): { actions: Action[]; toHuman: boolean } {
  const { ledger, config, supervisor, now } = input
  const supKey = `${problemKey}:supervisor`
  const humanKey = `${problemKey}:human`
  if (ledger.escalations[humanKey]) return { actions: [], toHuman: true }
  const sup = ledger.escalations[supKey]
  if (config.escalation.supervisorFirst && supervisor) {
    if (!sup) return { actions: [{ kind: 'escalate', to: 'supervisor', key: supKey, reason, address: supervisor }], toHuman: false }
    const since = sup.answered ? Math.max(sup.at, sup.answered.at) : sup.at
    if (now - since < config.escalation.humanAfterMinutes * 60_000) return { actions: [], toHuman: false }
  }
  const answer = sup?.answered ? `. ${answeredWords(sup.answered, now)}, and it is still so` : ''
  return { actions: [{ kind: 'escalate', to: 'human', key: humanKey, reason: `${reason}${answer}`, address: null }], toHuman: true }
}

function notifyOnce(ledger: PrLedger, key: string, title: string, body: string): Action[] {
  return ledger.notified[key] ? [] : [{ kind: 'notify', key, title, body }]
}

type FixKind = 'ci' | 'conflicts' | 'comments'
const FIX_LANE: Record<FixKind, Lane> = { ci: 'fixing-ci', conflicts: 'fixing-conflict', comments: 'fixing-review' }

function fixStep(
  input: PlanInput,
  kind: FixKind,
  problem: string,
  state: { sentOnThisCommit: boolean; newRound: boolean },
  makeAction: (to: string, round: number) => Action
): Plan {
  const { pr, owner, ledger, config } = input
  const policy = config.fix[kind]
  const lane = FIX_LANE[kind]
  const used = roundsUsed(ledger, kind)
  const pr7 = `#${pr.number} (${shortSha(pr.headSha)})`
  if (!policy.enabled) {
    return {
      lane: 'needs-you',
      reason: `${problem}; automatic ${kind} fixes are off`,
      actions: notifyOnce(ledger, `${kind}-off:${pr.headSha}`, `${pr.repo} ${pr7} needs you`, problem)
    }
  }
  if (state.sentOnThisCommit) {
    return { lane, reason: `${problem}; sent to the worker (round ${used}/${policy.maxRounds}), waiting for a push`, actions: [] }
  }
  if (state.newRound && used >= policy.maxRounds) {
    const e = escalate(input, `${kind}:${pr.headSha}`, `${problem}; ${used}/${policy.maxRounds} fix rounds used`)
    return {
      lane: e.toHuman ? 'needs-you' : lane,
      reason: `${problem}; ${used}/${policy.maxRounds} rounds used, escalated to ${e.toHuman ? 'you' : 'the supervisor'}`,
      actions: e.actions
    }
  }
  if (!owner?.address) {
    if (input.ownersKnown === false) return { lane, reason: `${problem}; waiting to see Orca's workers again`, actions: [] }
    const e = escalate(input, `orphan-${kind}:${pr.headSha}`, `${problem}; no supervised worker owns branch ${pr.headRef}`)
    return { lane: e.toHuman ? 'needs-you' : lane, reason: `${problem}; no worker owns this branch`, actions: e.actions }
  }
  const round = state.newRound ? used + 1 : used
  return {
    lane,
    reason: `${problem}; sending to the worker (round ${round}/${policy.maxRounds})`,
    actions: [makeAction(owner.address, round)]
  }
}

/**
 * What a worker mid-turn on a PR is doing. Fixing what Matriarch sent it for this commit (failing
 * checks, conflicts, review findings or comments); fixing it for some other reason, when another
 * worker took the PR over or its builder came back after finishing; or still building it.
 */
function workingLane(input: PlanInput): Plan {
  const { pr, owner, ledger } = input
  const sha = pr.headSha
  const who = owner?.agent ?? 'the worker'
  const draft = pr.draft ? 'draft PR; ' : ''
  if (ledger.ci[sha]) return { lane: 'fixing-ci', reason: `${draft}${who} is fixing the failing checks it was sent`, actions: [] }
  if (ledger.conflicts[sha]) return { lane: 'fixing-conflict', reason: `${draft}${who} is resolving the conflicts with ${pr.baseRef}`, actions: [] }
  const st = input.stack
  if (st && ledger.restacks?.[st.number]?.sha === sha) return { lane: 'fixing-conflict', reason: `${draft}${who} is rebasing it onto ${pr.baseRef}, off the commits of #${st.number}, which merged`, actions: [] }
  const review = ledger.reviews[sha]
  if ((review?.verdict === 'changes' && (review.delivered || review.published)) || ledger.comments[sha]) {
    return { lane: 'fixing-review', reason: `${draft}${who} is addressing the review`, actions: [] }
  }
  const b = ledger.builder
  if (b && owner?.address && (b.address !== owner.address || b.done)) {
    return { lane: 'fixing', reason: `${draft}${who} is fixing it after its first version`, actions: [] }
  }
  return { lane: 'working', reason: `${draft}the worker is mid-turn`, actions: [] }
}

/** How long a draft sits with nobody working on it before the supervisor is asked about it. */
export const DRAFT_NUDGE_MS = 15 * 60_000

export function plan(input: PlanInput): Plan {
  const { pr, owner, ledger, config } = input
  const sha = pr.headSha

  if (pr.state === 'MERGED') return { lane: 'merged', reason: 'merged', actions: [] }
  if (pr.state === 'CLOSED') return { lane: 'closed', reason: 'closed without merging', actions: [] }
  if (pr.draft) {
    // A draft is still being built: its worker's turn shows as work, and a worker stuck on a
    // prompt is a stall, as on any PR. Only a draft nobody is working on is quiet.
    if (owner?.activity === 'working') return workingLane(input)
    if (owner?.activity === 'waiting' || owner?.activity === 'blocked') {
      const e = escalate(input, `input:${owner.since}`, `the worker on draft #${pr.number} is waiting for input`)
      return { lane: 'needs-you', reason: `draft PR; the worker is ${owner.activity} on input`, actions: e.actions }
    }
    // Matriarch takes a PR through CI, review and merge only once it is ready. A draft nobody is
    // working on waits for someone to mark it so: ask the supervisor, once per commit, to mark it
    // ready if its work is done or leave it if it waits on something (a check of its own). Never
    // you: a draft you keep on purpose is yours, and without a supervisor nothing is sent.
    const quietFor = input.now - (ledger.heads[sha] ?? input.now)
    if (input.supervisor && quietFor >= DRAFT_NUDGE_MS) {
      const key = `draft:${sha}:supervisor`
      if (ledger.escalations[key]) return { lane: 'draft', reason: 'draft PR; the supervisor was asked to mark it ready or say why it waits', actions: [] }
      return {
        lane: 'draft',
        reason: 'draft PR; asking the supervisor to mark it ready or say why it waits',
        actions: [{
          kind: 'escalate', to: 'supervisor', key, address: input.supervisor,
          reason: `#${pr.number} has been a draft for ${Math.round(quietFor / 60_000)} min with nobody working on it. Matriarch takes a PR through CI, review and merge only once it is ready. If its work is done, mark it ready (${forgeTerms(pr.forge).ready(pr.number)}); if it waits on something, leave it as a draft.`
        }]
      }
    }
    return { lane: 'draft', reason: 'draft PR', actions: [] }
  }

  if (ledger.merge?.sha === sha) {
    if (ledger.merge.status === 'requested' && input.now - ledger.merge.at > MERGE_TIMEOUT_MS) {
      const e = escalate(input, `merge-stalled:${sha}`, `a merge requested ${Math.round((input.now - ledger.merge.at) / 60_000)} min ago has not completed`)
      return { lane: e.toHuman ? 'needs-you' : 'merging', reason: 'the merge has not completed', actions: e.actions }
    }
    if (ledger.merge.status === 'requested') return { lane: 'merging', reason: `merge requested, waiting for ${forgeTerms(pr.forge).name}`, actions: [] }
    if (ledger.merge.status === 'failed') {
      const e = escalate(input, `merge:${sha}`, `merge failed: ${ledger.merge.error ?? 'unknown error'}`)
      return { lane: e.toHuman ? 'needs-you' : 'ready', reason: `merge failed: ${ledger.merge.error ?? 'unknown error'}`, actions: e.actions }
    }
  }

  // A PR stacked on one that merged, still pointing at that PR's branch (the forge moves it only
  // when the branch goes): it is moved to where its parent went. A forge action, not the worker's.
  const st = input.stack
  if (st?.state === 'MERGED' && pr.baseRef === st.headRef && st.baseRef !== st.headRef) {
    if (!st.baseRef) {
      const why = `#${st.number}, which this PR is stacked on, merged, and Matriarch cannot tell where it merged to: point this PR at that branch`
      return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `stack-base:${st.number}`, `${pr.repo} #${pr.number} needs you`, why) }
    }
    if (ledger.retargets?.[st.number]) return { lane: 'awaiting-ci', reason: `#${st.number} merged; base moved to ${st.baseRef}, waiting for ${forgeTerms(pr.forge).name} to show it`, actions: [] }
    // The forge refused: tried again after a while, and a few refusals go to the supervisor, then you.
    const failed = ledger.retargetFailures?.[st.number]
    if (failed && failed.count >= RETARGET_TRIES) {
      const why = `${forgeTerms(pr.forge).name} refused to move the base from ${st.headRef} to ${st.baseRef} ${failed.count} times (${failed.error}): move it by hand`
      const e = escalate(input, `retarget:${st.number}`, why)
      return { lane: e.toHuman ? 'needs-you' : 'awaiting-ci', reason: why, actions: e.actions }
    }
    if (failed && input.now - failed.at < retargetBackoff(failed.count)) {
      return { lane: 'awaiting-ci', reason: `#${st.number} merged; moving the base to ${st.baseRef} failed (${failed.error}), trying again shortly`, actions: [] }
    }
    return {
      lane: 'awaiting-ci',
      reason: `#${st.number} merged; moving the base from ${st.headRef} to ${st.baseRef}`,
      actions: [{ kind: 'retarget', sha, parent: st.number, from: st.headRef, base: st.baseRef }]
    }
  }

  if (owner?.activity === 'working') return workingLane(input)
  if (owner?.activity === 'waiting' || owner?.activity === 'blocked') {
    const e = escalate(input, `input:${owner.since}`, `the worker on #${pr.number} is waiting for input`)
    return { lane: 'needs-you', reason: `the worker is ${owner.activity} on input`, actions: e.actions }
  }

  // 0. Its parent merged: the branch still carries the parent's commits until it is rebased off
  // them. Not when the base kept those commits as they are (a merge commit, a fast-forward).
  if (st?.state === 'MERGED' && st.headAtMerge === sha && st.forkInBase !== true) {
    const step = restackStep(input, st)
    if (step) return step
  }

  // 1. CI failing, once every check finished, so one message carries every failure.
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  const rerunning = rerunNote(input)
  if (pr.ci === 'failing') {
    // A check re-run a moment ago still shows the attempt that failed: it is starting again.
    const failing = pr.checks.filter((c) => c.state === 'failure' && !restarting(input, c))
    const names = failing.map((c) => c.name).join(', ')
    if (failing.length === 0) return { lane: 'awaiting-ci', reason: rerunning ?? `${pending} check(s) running on ${shortSha(sha)}`, actions: [] }
    if (pending > 0 || rerunning) return { lane: 'awaiting-ci', reason: `failing: ${names}; ${rerunning ?? `${pending} check(s) still running`}`, actions: [] }
    // A check that failed on the infrastructure (a lost runner, a registry out of reach) runs once
    // more before a worker spends a round on it; whatever still fails then goes to the worker.
    if (config.fix.ci.rerunFlaky && !ledger.ci[sha]) {
      const flaky = failing.filter((c) => c.jobId !== null && ledger.flaky?.[checkKey(sha, c.name)] && !ledger.reruns?.[checkKey(sha, c.name)])
      // GitHub re-runs one job of a workflow run at a time: jobs of one run go together.
      const runs = new Map<string, CheckInfo[]>()
      for (const c of flaky) {
        const key = c.runId ? `run:${c.runId}` : `job:${c.jobId}`
        runs.set(key, [...(runs.get(key) ?? []), c])
      }
      const again: Action[] = [...runs.values()].map((checks) => ({
        kind: 'rerun-check',
        sha,
        checks,
        why: [...new Set(checks.map((c) => ledger.flaky![checkKey(sha, c.name)]!))].join('; ')
      }))
      if (again.length > 0) {
        const what = flaky.map((c) => `${c.name} (${ledger.flaky![checkKey(sha, c.name)]})`).join(', ')
        return { lane: 'awaiting-ci', reason: `re-running ${what} once: it looks like the infrastructure failed, not the code`, actions: again }
      }
    }
    const signature = ciSignature(pr.checks)
    const sent = ledger.ci[sha]
    return fixStep(
      input,
      'ci',
      `CI failing on ${shortSha(sha)}: ${names}`,
      { sentOnThisCommit: sent?.signature === signature, newRound: !sent },
      (to, round) => ({ kind: 'send-ci-failure', to, sha, round, checks: failing, signature })
    )
  }

  // 2. Merge conflict with the base branch.
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    return fixStep(
      input,
      'conflicts',
      `conflicts with ${pr.baseRef}`,
      { sentOnThisCommit: Boolean(ledger.conflicts[sha]), newRound: true },
      (to, round) => ({ kind: 'send-rebase', to, sha, round, base: pr.baseRef })
    )
  }

  // 3. Review feedback from people (and line-anchored bots).
  const threads = actionableThreads(pr)
  if (threads.length > 0) {
    const sentHere = ledger.comments[sha]
    const unsent = threads.filter((t) => !sentHere?.threadIds.includes(t.id))
    return fixStep(
      input,
      'comments',
      `${threads.length} unresolved review comment(s)`,
      { sentOnThisCommit: unsent.length === 0, newRound: !sentHere },
      (to, round) => ({ kind: 'send-comments', to, sha, round, threads: unsent })
    )
  }

  // 4. Wait for CI. With review.trigger "pr-open" the crew starts without waiting for it.
  const fresh = input.now - (ledger.heads[sha] ?? input.now) < CI_GRACE_MS
  // A repository with no CI (no checks on its base, none ever on this PR) has nothing to wait for.
  const noCi = input.baseHasChecks === false && !ledger.ciSeen
  if (pr.ci === 'none' && fresh && !noCi) return { lane: 'awaiting-ci', reason: `waiting for checks to start on ${shortSha(sha)}`, actions: [] }
  if (pr.ci === 'pending' || pr.ci === 'cancelled') {
    if (config.review.trigger === 'pr-open') {
      const early = reviewStep(input)
      if (early.plan) return early.plan
    }
    return pr.ci === 'pending'
      ? { lane: 'awaiting-ci', reason: rerunning ?? `${pending} check(s) running on ${shortSha(sha)}`, actions: [] }
      : { lane: 'awaiting-ci', reason: 'a check was cancelled; re-run it', actions: [] }
  }

  // 5. The AI review crew, on this exact commit.
  const review = reviewStep(input)
  if (review.plan) return review.plan
  const gate = mergeGate(input)
  const withNote = review.note ? { ...gate, reason: `${gate.reason}; ${review.note}` } : gate
  return review.pre.length > 0 ? { ...withNote, actions: [...review.pre, ...withNote.actions] } : withNote
}

/**
 * A failed check re-run moments ago, whose failed attempt the forge still shows: the same job id
 * as the attempt that failed (a new attempt gets a new one), not refused, and not long ago.
 */
function restarting(input: PlanInput, c: CheckInfo): boolean {
  const r = input.ledger.reruns?.[checkKey(input.pr.headSha, c.name)]
  return Boolean(r && !r.error && r.jobId !== null && c.jobId === r.jobId && input.now - r.at < RERUN_START_MS)
}

/** Checks running again because they looked flaky on this commit, as the board says it; null when none. */
function rerunNote(input: PlanInput): string | null {
  const { pr, ledger } = input
  const again = pr.checks.filter((c) => (c.state === 'pending' && ledger.reruns?.[checkKey(pr.headSha, c.name)] && !ledger.reruns[checkKey(pr.headSha, c.name)].error) || (c.state === 'failure' && restarting(input, c)))
  return again.length ? `re-running ${again.map((c) => `${c.name} (${ledger.reruns![checkKey(pr.headSha, c.name)].why})`).join(', ')} once` : null
}

/**
 * Step 0, for a PR whose parent merged while this branch still carries the parent's commits (a
 * squash or rebase merge leaves them looking new): once, the owner is asked to rebase off them.
 * Nothing else happens until the branch moves; then the PR goes on like any other.
 */
function restackStep(input: PlanInput, st: StackParent): Plan | null {
  const { pr, owner, ledger } = input
  const what = `#${st.number}, which this PR was stacked on, merged into ${pr.baseRef}`
  // Where this branch's own commits start: the parent's head it was built on.
  const fork = st.forkSha ?? st.headSha
  const sent = ledger.restacks?.[st.number]
  if (sent) {
    const waited = input.now - sent.at
    if (waited < RESTACK_STALL_MS) return { lane: 'fixing-conflict', reason: `${what}; waiting for the branch to be rebased off its commits`, actions: [] }
    // Nothing pushed in all this time: the rebase may have been a no-op, or the worker is stuck.
    const e = escalate(input, `restack-stalled:${st.number}`, `${what}; branch ${pr.headRef} was asked ${Math.round(waited / 60_000)} min ago to be rebased off its commits and has not moved. Rebase it (${restackCommand(pr.baseRef, fork)}), or, if it has nothing of #${st.number}'s left, push it as it is`)
    return { lane: e.toHuman ? 'needs-you' : 'fixing-conflict', reason: `${what}; the branch has not moved since it was asked to rebase`, actions: e.actions }
  }
  if (!owner?.address) {
    if (input.ownersKnown === false) return { lane: 'fixing-conflict', reason: `${what}; waiting to see Orca's workers again`, actions: [] }
    const e = escalate(input, `restack:${st.number}`, `${what}, and branch ${pr.headRef} still carries its commits, with no supervised worker on it. Rebase it off them in its worktree: ${restackCommand(pr.baseRef, fork)}`)
    return { lane: e.toHuman ? 'needs-you' : 'fixing-conflict', reason: `${what}; no worker owns this branch to rebase it`, actions: e.actions }
  }
  return {
    lane: 'fixing-conflict',
    reason: `${what}; asking the worker to rebase off its commits`,
    actions: [{ kind: 'send-restack', to: owner.address, sha: pr.headSha, parent: st.number, parentSha: fork, base: pr.baseRef }]
  }
}

/**
 * Step 5: the crew's part. A plan when the review decides the lane (start, running, failed,
 * changes requested); otherwise null, any actions to run before the merge gate, and a note when
 * the review was skipped as a light change.
 */
function reviewStep(input: PlanInput): { plan: Plan | null; pre: Action[]; note?: string } {
  const { pr, owner, ledger, config } = input
  const sha = pr.headSha
  if (!config.review.enabled || config.reviewers.length === 0) return { plan: null, pre: [] }
  const rec = ledger.reviews[sha]
  // A light change (only docs, say) gets one reviewer, or none: then it passes the review as is,
  // unless a round already ran on this commit (started by hand, or before the setting) and still
  // decides: one running, or one that asked for changes.
  const light = lightChange(config, pr)
  if (light && config.review.light.crew === 'none' && (!rec || rec.status === 'failed')) {
    return { plan: null, pre: [], note: `AI review skipped: a light change (only ${light.join(', ')})` }
  }
  if (!rec) {
    const used = roundsUsed(ledger, 'reviews')
    if (used >= config.review.maxRounds) {
      const e = escalate(input, `review:${sha}`, `AI review still requests changes after ${used}/${config.review.maxRounds} rounds`)
      return { plan: { lane: e.toHuman ? 'needs-you' : 'fixing-review', reason: `${used}/${config.review.maxRounds} review rounds used`, actions: e.actions }, pre: [] }
    }
    if (!input.reviewSlotFree) return { plan: { lane: 'ai-review', reason: 'waiting for a free review slot', actions: [] }, pre: [] }
    const selected = selectReviewers(config, owner?.agent ?? null)
    // One reviewer for a light change: the first that must approve, else the first.
    const reviewers = light ? [selected.reviewers.find((r) => r.blocking) ?? selected.reviewers[0]] : selected.reviewers
    const note = [selected.note, light ? `a light change (only ${light.join(', ')}): one reviewer` : null].filter(Boolean).join('; ')
    const names = reviewers.map((r) => r.name).join(', ')
    return {
      plan: {
        lane: 'ai-review',
        reason: `starting review round ${used + 1}/${config.review.maxRounds}: ${names}${note ? ` (${note})` : ''}`,
        actions: [{ kind: 'start-review', sha, round: used + 1, reviewers }]
      },
      pre: []
    }
  }
  if (rec.status === 'running') return { plan: { lane: 'ai-review', reason: `review round ${rec.round} running`, actions: [] }, pre: [] }
  if (rec.status === 'failed') {
    const e = escalate(input, `review-failed:${sha}`, `the review crew failed on ${shortSha(sha)}`)
    return { plan: { lane: e.toHuman ? 'needs-you' : 'ai-review', reason: 'the review crew failed', actions: e.actions }, pre: [] }
  }
  const publish: Action[] = config.review.publish === 'github' && !rec.published ? [{ kind: 'publish-review', sha, round: rec.round }] : []
  if (rec.verdict !== 'changes') return { plan: null, pre: publish }
  const n = rec.findings ?? 0
  if (rec.delivered) {
    return { plan: { lane: 'fixing-review', reason: `review round ${rec.round}: ${n} finding(s) sent to the worker, waiting for a push`, actions: publish }, pre: [] }
  }
  if (!owner?.address) {
    if (input.ownersKnown === false) return { plan: { lane: 'fixing-review', reason: `review round ${rec.round} asks for ${n} change(s); waiting to see Orca's workers again`, actions: publish }, pre: [] }
    const e = escalate(input, `orphan-review:${sha}`, `AI review asks for ${n} change(s) but no supervised worker owns branch ${pr.headRef}`)
    return {
      plan: { lane: e.toHuman ? 'needs-you' : 'fixing-review', reason: `review round ${rec.round} asks for ${n} change(s); no worker owns this branch`, actions: [...publish, ...e.actions] },
      pre: []
    }
  }
  return {
    plan: { lane: 'fixing-review', reason: `review round ${rec.round}: sending ${n} finding(s) to the worker`, actions: [...publish, { kind: 'send-findings', to: owner.address, sha, round: rec.round }] },
    pre: []
  }
}

/** Step 6: whether and how this commit may merge. */
function mergeGate(input: PlanInput): Plan {
  const { pr, ledger, config } = input
  const sha = pr.headSha
  const { merge } = config
  // Merging a stacked PR now would merge it into its parent's branch: it waits for its parent.
  const st = input.stack
  if (st && pr.baseRef === st.headRef) {
    if (st.state === 'OPEN') return { lane: 'ready', reason: `stacked on #${st.number}; merges after it`, actions: [] }
    if (st.state === 'CLOSED') {
      const why = `stacked on #${st.number}, which closed without merging: retarget it or close it`
      return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `stack-closed:${st.number}`, `${pr.repo} #${pr.number} needs you`, why) }
    }
  }
  if (input.unlistedBase) {
    const why = `its base ${pr.baseRef} may be another open PR's branch, and ${forgeTerms(pr.forge).name} listed too many open PRs to tell: merge it yourself`
    return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `unlisted-base:${sha}`, `${pr.repo} #${pr.number} needs a human merge`, why) }
  }
  if (merge.requireHuman.length > 0) {
    const hits = matchingGlobs(merge.requireHuman, pr.files, { ignoreCase: true })
    if (hits.length > 0 || pr.filesTruncated) {
      const why = hits.length > 0 ? `touches protected paths (${hits.join(', ')})` : `${forgeTerms(pr.forge).name} did not list every changed file, so protected paths cannot be checked`
      return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `protected:${sha}`, `${pr.repo} #${pr.number} needs a human merge`, why) }
    }
  }
  if (pr.threadsTruncated || pr.checksTruncated) {
    const why = pr.threadsTruncated ? 'too many review threads to check them all' : 'too many checks to read them all'
    return { lane: 'needs-you', reason: `${why}; merge it yourself`, actions: notifyOnce(ledger, `truncated:${sha}`, `${pr.repo} #${pr.number} needs a human merge`, why) }
  }
  if (pr.mergeState === 'BEHIND') {
    // Updating pushes a commit to the PR: only when Matriarch is the one merging.
    if (merge.mode !== 'auto') return { lane: 'ready', reason: `behind ${pr.baseRef}; update the branch when you merge`, actions: [] }
    if (merge.updateBranch === 'off') return { lane: 'needs-you', reason: `behind ${pr.baseRef} and branch updates are off`, actions: [] }
    if (ledger.updates[sha]) return { lane: 'awaiting-ci', reason: `behind ${pr.baseRef}; update requested`, actions: [] }
    return { lane: 'awaiting-ci', reason: `behind ${pr.baseRef}; updating the branch`, actions: [{ kind: 'update-branch', sha, method: merge.updateBranch }] }
  }
  if (pr.mergeState === 'BLOCKED') {
    const why = forgeTerms(pr.forge).blocked
    return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `blocked:${sha}`, `${pr.repo} #${pr.number} is blocked`, why) }
  }
  if (pr.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeState)) {
    return { lane: 'awaiting-ci', reason: `${forgeTerms(pr.forge).name} is still working out whether it can merge`, actions: [] }
  }
  if (merge.mode === 'manual') {
    return {
      lane: 'ready',
      reason: 'ready to merge',
      actions: notifyOnce(ledger, `ready:${sha}`, `${pr.repo} #${pr.number} is ready to merge`, pr.title)
    }
  }
  if (input.baseRed) {
    // Merging onto a broken base hides which change broke it and stacks more on top.
    const why = `merge train paused: CI on ${pr.baseRef} is red`
    const e = escalate(input, `base-red:${input.baseRed.sha ?? pr.baseRef}`, `${why}; ${merge.onBaseRed === 'revert' ? 'find and revert the change that broke it' : 'fix it forward'} before more merges`)
    return { lane: 'ready', reason: why, actions: e.actions }
  }
  if (!input.mergeSlotFree) return { lane: 'ready', reason: `queued: another merge into ${pr.baseRef} is in flight`, actions: [] }
  return { lane: 'merging', reason: `merging (${merge.method})`, actions: [{ kind: 'merge', sha, method: merge.method }] }
}
