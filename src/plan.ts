// The planner: pure. From one PR's snapshot, its owning worker, the ledger of what Matriarch
// already did and the repo config, it answers the PR's lane, why, and the next actions.
// Every tick re-plans from current facts, so a message held back while a worker was busy goes
// out once it is free, and nothing is sent twice for the same commit.
import type { MatriarchConfig, ReviewerSpec } from './config.ts'
import { actionableThreads, type CheckInfo, type PrSnapshot, type ThreadInfo } from './github.ts'
import { matchingGlobs } from './glob.ts'
import { roundsUsed, type PrLedger } from './ledger.ts'

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
  | { kind: 'merge'; sha: string; method: 'squash' | 'merge' | 'rebase' }
  | { kind: 'escalate'; to: 'supervisor' | 'human'; key: string; reason: string; address: string | null }
  | { kind: 'notify'; key: string; title: string; body: string }

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
  now: number
}

export interface Plan {
  lane: Lane
  reason: string
  actions: Action[]
}

const short = (sha: string): string => sha.slice(0, 7)

/** A new commit's checks take a moment to register; until then "no checks" is not "green". */
export const CI_GRACE_MS = 3 * 60_000
/** A merge GitHub has not completed by now has stalled (a merge queue dropped it, say). */
export const MERGE_TIMEOUT_MS = 30 * 60_000

export function ciSignature(checks: readonly CheckInfo[]): string {
  return checks
    .filter((c) => c.state === 'failure')
    .map((c) => c.name)
    .sort()
    .join('|')
}

/** Reviewers for a PR, dropping those on the author's own agent when the config asks. */
export function selectReviewers(config: MatriarchConfig, authorAgent: string | null): { reviewers: ReviewerSpec[]; note: string | null } {
  const all = config.reviewers
  if (!config.review.differentProviderThanAuthor || !authorAgent) return { reviewers: all, note: null }
  const others = all.filter((r) => r.agent !== authorAgent)
  if (others.length === 0) {
    return { reviewers: all, note: `every reviewer runs on ${authorAgent}, the author's agent` }
  }
  const dropped = all.length - others.length
  return { reviewers: others, note: dropped ? `skipped ${dropped} reviewer(s) on ${authorAgent}, the author's agent` : null }
}

/** Worker → supervisor → human. Each step happens once per problem key. */
function escalate(input: PlanInput, problemKey: string, reason: string): { actions: Action[]; toHuman: boolean } {
  const { ledger, config, supervisor, now } = input
  const supKey = `${problemKey}:supervisor`
  const humanKey = `${problemKey}:human`
  if (ledger.escalations[humanKey]) return { actions: [], toHuman: true }
  if (config.escalation.supervisorFirst && supervisor) {
    const sup = ledger.escalations[supKey]
    if (!sup) return { actions: [{ kind: 'escalate', to: 'supervisor', key: supKey, reason, address: supervisor }], toHuman: false }
    if (now - sup.at < config.escalation.humanAfterMinutes * 60_000) return { actions: [], toHuman: false }
  }
  return { actions: [{ kind: 'escalate', to: 'human', key: humanKey, reason, address: null }], toHuman: true }
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
  const pr7 = `#${pr.number} (${short(pr.headSha)})`
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
          reason: `#${pr.number} has been a draft for ${Math.round(quietFor / 60_000)} min with nobody working on it. Matriarch takes a PR through CI, review and merge only once it is ready. If its work is done, mark it ready (gh pr ready ${pr.number}); if it waits on something, leave it as a draft.`
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
    if (ledger.merge.status === 'requested') return { lane: 'merging', reason: 'merge requested, waiting for GitHub', actions: [] }
    if (ledger.merge.status === 'failed') {
      const e = escalate(input, `merge:${sha}`, `merge failed: ${ledger.merge.error ?? 'unknown error'}`)
      return { lane: e.toHuman ? 'needs-you' : 'ready', reason: `merge failed: ${ledger.merge.error ?? 'unknown error'}`, actions: e.actions }
    }
  }

  if (owner?.activity === 'working') return workingLane(input)
  if (owner?.activity === 'waiting' || owner?.activity === 'blocked') {
    const e = escalate(input, `input:${owner.since}`, `the worker on #${pr.number} is waiting for input`)
    return { lane: 'needs-you', reason: `the worker is ${owner.activity} on input`, actions: e.actions }
  }

  // 1. CI failing, once every check finished, so one message carries every failure.
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  if (pr.ci === 'failing') {
    const failing = pr.checks.filter((c) => c.state === 'failure')
    const names = failing.map((c) => c.name).join(', ')
    if (pending > 0) return { lane: 'awaiting-ci', reason: `failing: ${names}; ${pending} check(s) still running`, actions: [] }
    const signature = ciSignature(pr.checks)
    const sent = ledger.ci[sha]
    return fixStep(
      input,
      'ci',
      `CI failing on ${short(sha)}: ${names}`,
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
  if (pr.ci === 'none' && fresh && !noCi) return { lane: 'awaiting-ci', reason: `waiting for checks to start on ${short(sha)}`, actions: [] }
  if (pr.ci === 'pending' || pr.ci === 'cancelled') {
    if (config.review.trigger === 'pr-open') {
      const early = reviewStep(input)
      if (early.plan) return early.plan
    }
    return pr.ci === 'pending'
      ? { lane: 'awaiting-ci', reason: `${pending} check(s) running on ${short(sha)}`, actions: [] }
      : { lane: 'awaiting-ci', reason: 'a check was cancelled; re-run it', actions: [] }
  }

  // 5. The AI review crew, on this exact commit.
  const review = reviewStep(input)
  if (review.plan) return review.plan
  const gate = mergeGate(input)
  return review.pre.length > 0 ? { ...gate, actions: [...review.pre, ...gate.actions] } : gate
}

/**
 * Step 5: the crew's part. A plan when the review decides the lane (start, running, failed,
 * changes requested); otherwise null and any actions to run before the merge gate.
 */
function reviewStep(input: PlanInput): { plan: Plan | null; pre: Action[] } {
  const { pr, owner, ledger, config } = input
  const sha = pr.headSha
  if (!config.review.enabled || config.reviewers.length === 0) return { plan: null, pre: [] }
  const rec = ledger.reviews[sha]
  if (!rec) {
    const used = roundsUsed(ledger, 'reviews')
    if (used >= config.review.maxRounds) {
      const e = escalate(input, `review:${sha}`, `AI review still requests changes after ${used}/${config.review.maxRounds} rounds`)
      return { plan: { lane: e.toHuman ? 'needs-you' : 'fixing-review', reason: `${used}/${config.review.maxRounds} review rounds used`, actions: e.actions }, pre: [] }
    }
    if (!input.reviewSlotFree) return { plan: { lane: 'ai-review', reason: 'waiting for a free review slot', actions: [] }, pre: [] }
    const { reviewers, note } = selectReviewers(config, owner?.agent ?? null)
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
    const e = escalate(input, `review-failed:${sha}`, `the review crew failed on ${short(sha)}`)
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
  if (merge.requireHuman.length > 0) {
    const hits = matchingGlobs(merge.requireHuman, pr.files)
    if (hits.length > 0 || pr.filesTruncated) {
      const why = hits.length > 0 ? `touches protected paths (${hits.join(', ')})` : 'too many files to check protected paths'
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
    const why = 'GitHub blocks the merge (branch protection: approvals or required checks)'
    return { lane: 'needs-you', reason: why, actions: notifyOnce(ledger, `blocked:${sha}`, `${pr.repo} #${pr.number} is blocked`, why) }
  }
  if (pr.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeState)) {
    return { lane: 'awaiting-ci', reason: 'GitHub is still working out whether it can merge', actions: [] }
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
