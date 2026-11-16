// Carries out planned actions with the orca CLI and the project's forge (gh for GitHub, glab for
// GitLab). Only runs when autopilot is on. Merges are pinned to the head commit that passed the
// gate and never bypass the forge's own rules (no --admin on GitHub).
import type { MatriarchConfig } from './config.ts'
import type { Crew } from './crew.ts'
import type { Exec } from './exec.ts'
import { forgeKind, forgeTerms, stackableBranch, type BranchDeletion, type BranchUse, type ForgeActions, type ForgeKind, type Outcome, type RepoRef } from './forge.ts'
import { createGitHub, type PrSnapshot } from './github.ts'
import { createGitLab } from './gitlab.ts'
import { ciFailureMessage, commentsMessage, draftMessage, escalationMessage, rebaseMessage, restackMessage, updateMessage } from './messages.ts'
import { sendFrom, type Mailbox, type OrcaCli } from './orca-cli.ts'
import type { Action } from './plan.ts'
import { findingsMessage, githubReview } from './review.ts'

export interface ActionContext {
  repo: RepoRef
  pr: PrSnapshot
  config: MatriarchConfig
  /** The repository's main checkout. */
  root: string
  /** The supervisor's Run mailbox (`run:<id>`), when there is one. */
  supervisor?: string | null
  /** The PR's worktree. */
  worktree?: string | null
  /** Whether the worker that owns the branch is still running; null when unknown. */
  ownerLive?: boolean | null
  /** Where the worker that owns the branch gets mail (`dispatch:<id>`), when one does. */
  owner?: string | null
  /** Failed checks' log tails already read this commit (to judge a flaky failure), by check name. */
  failedLogs?: Record<string, string>
  /** The repository's default branch, when known: never deleted, nor a long-lived one. */
  defaultBranch?: string | null
}

/** GitLab moves up to this many merge requests into a branch it deletes at a merge (RetargetChainService). */
export const GITLAB_RETARGETS = 4

/**
 * Whether a PR's branch is deleted as it merges, for a project that deletes merged branches; when
 * it is kept although such a branch would go, why. Deleting a branch an open PR is based on closes
 * that PR on GitHub (it moves them only when its own auto-delete setting or a person deletes the
 * branch after the merge, not when the API does), so the branch is
 * kept, and deleted once they have moved off it (engine.ts deleteKeptBranches). GitLab moves the
 * merge requests into the branch itself when it deletes it at the merge: up to four, of this
 * project, so it is kept only past that, for a fork's, or for another merge request from it. The
 * forge is asked just before the merge, not from the list read at the start of the tick. The
 * default branch, a long-lived one (develop, release/*) and a fork's are never deleted.
 */
export async function branchAtMerge(forge: ForgeActions, ctx: ActionContext): Promise<{ delete: boolean; kept?: string }> {
  const { pr, repo } = ctx
  if (pr.crossRepo || !stackableBranch(pr.headRef, ctx.defaultBranch ?? null)) return { delete: false }
  let use: BranchUse
  try {
    use = await forge.branchUse(repo, pr.headRef)
  } catch (error) {
    return { delete: false, kept: `Matriarch could not tell whether another ${pr.forge === 'gitlab' ? 'merge request' : 'PR'} is based on it (${(error as Error).message})` }
  }
  const from = use.from.filter((n) => n !== pr.number)
  const gitlabMoves = pr.forge === 'gitlab' && use.based.length <= GITLAB_RETARGETS && use.based.every((b) => !b.crossRepo)
  if (from.length === 0 && (use.based.length === 0 || gitlabMoves)) return { delete: true }
  const refs = (ns: number[]) => (ns.length === 1 ? `#${ns[0]}` : `${ns.slice(0, -1).map((n) => `#${n}`).join(', ')} and #${ns.at(-1)}`)
  const why = [
    use.based.length > 0 ? `${refs(use.based.map((b) => b.number))} ${use.based.length === 1 ? 'is' : 'are'} based on it` : null,
    from.length > 0 ? `${refs(from)} ${from.length === 1 ? 'comes' : 'come'} from it` : null
  ].filter(Boolean)
  return { delete: false, kept: why.join(', and ') }
}

/** Orca's answer when only the Run's coordinator may wake a finished worker. */
const COORDINATOR_ONLY = /needs the coordinator bound to the Run|worker on an active Dispatch/i

/** Work for a finished worker, addressed to the supervisor, who can start a follow-up. */
export function forSupervisor(ctx: ActionContext, worker: string, subject: string, body: string): { subject: string; body: string } {
  const { pr } = ctx
  return {
    subject: `#${pr.number} needs a follow-up: ${subject}`,
    body: [
      `PR #${pr.number} (${pr.url}), branch ${pr.headRef}${ctx.worktree ? `, worktree ${ctx.worktree}` : ''}, needs another pass, and its worker (${worker}) has finished.`,
      'Only you can start a follow-up there: start a worker on that worktree, on the PR\'s existing branch',
      `(orca orchestration worker-start --worktree path:${ctx.worktree ?? '<its worktree>'} ...), with the instructions below. It pushes to the same PR.`,
      '',
      `--- ${subject} ---`,
      body
    ].join('\n')
  }
}

export type { Outcome }
// The log tidying now lives with the forges; re-exported for its earlier callers.
export { tailLog } from './forge.ts'

export interface Executor {
  execute(action: Action, ctx: ActionContext): Promise<Outcome>
  /** Deletes a merged PR's branch that was kept for the PRs based on it, while it still points at `sha`. */
  deleteBranch?(repo: RepoRef, branch: string, sha: string): Promise<BranchDeletion>
}

export interface ExecutorDeps {
  exec: Exec
  orca: OrcaCli
  /** Tells the person, in Orca and on the away webhook; `about` says what kind of alert it is. */
  notify(title: string, body: string, about?: { kind: 'needs-you' | 'ready'; repo: string; number: number; url: string }): Promise<void>
  crew?: Crew
  ghBin?: string
  glabBin?: string
  /** The forges' actions, by kind; each defaults to its own CLI (gh, glab). */
  forges?: Partial<Record<ForgeKind, ForgeActions>>
  /**
   * Matriarch's own terminal in the project, to send orchestration mail from: Orca refuses a
   * sender it cannot place in a terminal (no_active_sender_terminal), and a plugin has none.
   */
  mailbox?: (ctx: ActionContext) => Promise<string | null>
  /** Orca says the mailbox mail went from is gone: the next one asked for is made anew. */
  mailboxGone?: (ctx: ActionContext, handle: string) => void
}

export function createExecutor(deps: ExecutorDeps): Executor {
  // Each forge acts through its own CLI; the worker passes the same clients it reads with.
  const forges: Partial<Record<ForgeKind, ForgeActions>> = {
    github: createGitHub(deps.exec, Date.now, deps.ghBin ?? 'gh'),
    gitlab: createGitLab(deps.exec, Date.now, deps.glabBin ?? 'glab'),
    ...deps.forges
  }
  /** The forge the project lives on. */
  const forgeOf = (repo: RepoRef): ForgeActions => {
    const forge = forges[forgeKind(repo)]
    if (!forge) throw new Error(`Matriarch cannot act on ${forgeTerms(forgeKind(repo)).name} here`)
    return forge
  }

  async function send(ctx: ActionContext, to: string, subject: string, body: string, type?: 'escalation'): Promise<Outcome> {
    // Every message goes from the project's mailbox (sendFrom); a closed one is made anew next time.
    const mailbox: Mailbox | null = deps.mailbox ? { address: () => deps.mailbox!(ctx), gone: (handle) => deps.mailboxGone?.(ctx, handle) } : null
    // A finished worker can only be woken by the Run's coordinator: the supervisor gets the work.
    const viaSupervisor = async (): Promise<Outcome> => {
      const m = forSupervisor(ctx, to, subject, body)
      // Not --type escalation: Orca takes that only from a worker ("No active Dispatch belongs to this message sender").
      const receipt = await sendFrom(deps.orca, mailbox, { to: ctx.supervisor!, subject: m.subject, body: m.body })
      return { ok: true, sent: { to: 'supervisor', subject: m.subject, note: 'its worker had finished, so the supervisor got it', address: ctx.supervisor!, messageId: receipt.id, from: receipt.from } }
    }
    try {
      if (to.startsWith('dispatch:') && ctx.ownerLive === false && ctx.supervisor) return await viaSupervisor()
      // Matriarch is not a worker, so an escalation goes as plain mail with the word in its subject.
      const sentSubject = type === 'escalation' && !/escalat/i.test(subject) ? `Escalation: ${subject}` : subject
      const receipt = await sendFrom(deps.orca, mailbox, { to, subject: sentSubject, body })
      return { ok: true, sent: { to: to.startsWith('dispatch:') ? 'worker' : 'supervisor', subject: sentSubject, address: to, messageId: receipt.id, from: receipt.from } }
    } catch (error) {
      const message = (error as Error).message
      if (to.startsWith('dispatch:') && ctx.supervisor && COORDINATOR_ONLY.test(message)) {
        try {
          return await viaSupervisor()
        } catch (again) {
          return { ok: false, error: (again as Error).message }
        }
      }
      return { ok: false, error: message }
    }
  }

  return {
    deleteBranch: (repo, branch, sha) => forgeOf(repo).deleteBranch(repo, branch, sha),
    async execute(action, ctx) {
      const { pr, repo, config } = ctx
      switch (action.kind) {
        case 'send-ci-failure': {
          // The tails read to judge the failure are reused; only the rest are downloaded.
          const kept = ctx.failedLogs ?? {}
          const missing = action.checks.filter((c) => kept[c.name] === undefined)
          const logs = { ...kept, ...(missing.length ? await forgeOf(repo).failedLogs(repo, missing) : {}) }
          const m = ciFailureMessage(pr, action.checks, logs, action.round, config.fix.ci.maxRounds)
          return send(ctx, action.to, m.subject, m.body)
        }
        case 'send-rebase': {
          const m = rebaseMessage(pr, action.round, config.fix.conflicts.maxRounds)
          return send(ctx, action.to, m.subject, m.body)
        }
        case 'send-comments': {
          const m = commentsMessage(pr, action.threads, action.round, config.fix.comments.maxRounds)
          return send(ctx, action.to, m.subject, m.body)
        }
        case 'update-branch': {
          const forge = forgeOf(repo)
          if (forge.updates.includes(action.method)) return forge.updateBranch(repo, pr, action.method)
          // The forge cannot update the branch this way (GitLab cannot merge the base in): the
          // worker that owns the branch does it, or the supervisor when no worker does.
          const to = ctx.owner ?? ctx.supervisor
          if (!to) return { ok: false, error: `${forgeTerms(forgeKind(repo)).name} cannot ${action.method === 'merge' ? 'merge the base into a branch' : 'rebase a branch'} for Matriarch, and no worker owns ${pr.headRef}` }
          const m = updateMessage(pr, action.method)
          return send(ctx, to, m.subject, m.body)
        }
        case 'merge': {
          // Whether its branch goes with it is asked of the forge just before (branchAtMerge).
          const branch = config.merge.deleteBranch ? await branchAtMerge(forgeOf(repo), ctx) : { delete: false }
          const out = await forgeOf(repo).merge(repo, pr, action.sha, action.method, branch.delete)
          return out.ok && branch.kept ? { ...out, keptBranch: branch.kept } : out
        }
        case 'retarget':
          return forgeOf(repo).retarget(repo, pr, action.base)
        case 'rerun-check':
          return forgeOf(repo).rerun(repo, action.checks)
        case 'send-restack': {
          const m = restackMessage(pr, action.parent, action.parentSha, action.base)
          return send(ctx, action.to, m.subject, m.body)
        }
        case 'escalate': {
          if (action.to === 'supervisor' && action.address) {
            // Asking about a quiet draft is a routine question, sent as plain mail, not an escalation.
            if (action.key.startsWith('draft:')) {
              const d = draftMessage(pr, action.reason)
              return send(ctx, action.address, d.subject, d.body)
            }
            const m = escalationMessage(pr, action.reason)
            return send(ctx, action.address, m.subject, m.body, 'escalation')
          }
          try {
            const title = `${pr.repo} #${pr.number} needs you`
            await deps.notify(title, action.reason, { kind: 'needs-you', repo: pr.repo, number: pr.number, url: pr.url })
            return { ok: true, sent: { to: 'you', subject: title } }
          } catch (error) {
            return { ok: false, error: `notification: ${(error as Error).message}` }
          }
        }
        case 'notify':
          try {
            // A ready PR is its own kind of alert; every other notice is something that needs you.
            await deps.notify(action.title, action.body, { kind: action.key.startsWith('ready:') ? 'ready' : 'needs-you', repo: pr.repo, number: pr.number, url: pr.url })
            return { ok: true, sent: { to: 'you', subject: action.title } }
          } catch (error) {
            return { ok: false, error: `notification: ${(error as Error).message}` }
          }
        case 'start-review': {
          if (!deps.crew) return { ok: false, skipped: 'no review crew in this host' }
          const run = await deps.crew.start({ pr, root: ctx.root, config, round: action.round, reviewers: action.reviewers })
          return run.status === 'failed' ? { ok: false, error: `review crew: ${run.error}` } : { ok: true }
        }
        case 'send-findings': {
          const run = await deps.crew?.get(pr.repo, pr.number, action.sha)
          if (!run?.outcome) return { ok: false, error: 'no review outcome to send' }
          const m = findingsMessage(pr, run.outcome, action.round, config.review.maxRounds)
          return send(ctx, action.to, m.subject, m.body)
        }
        case 'publish-review': {
          const run = await deps.crew?.get(pr.repo, pr.number, action.sha)
          if (!run?.outcome) return { ok: false, error: 'no review outcome to publish' }
          return forgeOf(repo).publishReview(repo, pr, action.sha, githubReview(pr, run.outcome, action.round))
        }
      }
    }
  }
}
