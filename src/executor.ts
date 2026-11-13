// Carries out planned actions with the orca CLI and the project's forge (gh for GitHub). Only
// runs when autopilot is on. Merges are pinned to the head commit that passed the gate and never
// bypass the forge's own rules (no --admin on GitHub).
import type { MatriarchConfig } from './config.ts'
import type { Crew } from './crew.ts'
import type { Exec } from './exec.ts'
import { forgeKind, forgeTerms, type ForgeActions, type ForgeKind, type Outcome, type RepoRef } from './forge.ts'
import { createGitHub, type PrSnapshot } from './github.ts'
import { ciFailureMessage, commentsMessage, escalationMessage, rebaseMessage, updateMessage } from './messages.ts'
import { sendMessage, type OrcaCli } from './orca-cli.ts'
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
}

export interface ExecutorDeps {
  exec: Exec
  orca: OrcaCli
  notify(title: string, body: string): Promise<void>
  crew?: Crew
  ghBin?: string
  /** The forges' actions, by kind; GitHub's defaults to its own CLI (gh). */
  forges?: Partial<Record<ForgeKind, ForgeActions>>
  /**
   * Matriarch's own terminal in the project, to send orchestration mail from: Orca refuses a
   * sender it cannot place in a terminal (no_active_sender_terminal), and a plugin has none.
   */
  mailbox?: (ctx: ActionContext) => Promise<string | null>
}

export function createExecutor(deps: ExecutorDeps): Executor {
  // Each forge acts through its own CLI; the worker passes the same clients it reads with.
  const forges: Partial<Record<ForgeKind, ForgeActions>> = {
    github: createGitHub(deps.exec, Date.now, deps.ghBin ?? 'gh'),
    ...deps.forges
  }
  /** The forge the project lives on. */
  const forgeOf = (repo: RepoRef): ForgeActions => {
    const forge = forges[forgeKind(repo)]
    if (!forge) throw new Error(`Matriarch cannot act on ${forgeTerms(forgeKind(repo)).name} here`)
    return forge
  }

  async function send(ctx: ActionContext, to: string, subject: string, body: string, type?: 'escalation'): Promise<Outcome> {
    const from = deps.mailbox ? await deps.mailbox(ctx).catch(() => null) : null
    // A finished worker can only be woken by the Run's coordinator: the supervisor gets the work.
    const viaSupervisor = async (): Promise<Outcome> => {
      const m = forSupervisor(ctx, to, subject, body)
      // Not --type escalation: Orca takes that only from a worker ("No active Dispatch belongs to this message sender").
      await sendMessage(deps.orca, { to: ctx.supervisor!, subject: m.subject, body: m.body, from })
      return { ok: true }
    }
    try {
      if (to.startsWith('dispatch:') && ctx.ownerLive === false && ctx.supervisor) return await viaSupervisor()
      // Matriarch is not a worker, so an escalation goes as plain mail with the word in its subject.
      await sendMessage(deps.orca, { to, subject: type === 'escalation' && !/escalat/i.test(subject) ? `Escalation: ${subject}` : subject, body, from })
      return { ok: true }
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
    async execute(action, ctx) {
      const { pr, repo, config } = ctx
      switch (action.kind) {
        case 'send-ci-failure': {
          const logs = await forgeOf(repo).failedLogs(repo, action.checks)
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
        case 'merge':
          return forgeOf(repo).merge(repo, pr, action.sha, action.method, config.merge.deleteBranch)
        case 'escalate': {
          if (action.to === 'supervisor' && action.address) {
            const m = escalationMessage(pr, action.reason)
            return send(ctx, action.address, m.subject, m.body, 'escalation')
          }
          try {
            await deps.notify(`${pr.repo} #${pr.number} needs you`, action.reason)
            return { ok: true }
          } catch (error) {
            return { ok: false, error: `notification: ${(error as Error).message}` }
          }
        }
        case 'notify':
          try {
            await deps.notify(action.title, action.body)
            return { ok: true }
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
