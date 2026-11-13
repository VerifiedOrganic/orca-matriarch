// Carries out planned actions with the orca and gh CLIs. Only runs when autopilot is on.
// Merges are pinned to the head commit that passed the gate and never use --admin.
import type { MatriarchConfig } from './config.ts'
import type { Crew } from './crew.ts'
import type { Exec } from './exec.ts'
import type { PrSnapshot, RepoRef } from './github.ts'
import { ciFailureMessage, commentsMessage, escalationMessage, rebaseMessage } from './messages.ts'
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

export interface Outcome {
  ok: boolean
  error?: string
  /** Set when the action was deliberately not carried out (not built yet, say). */
  skipped?: string
}

export interface Executor {
  execute(action: Action, ctx: ActionContext): Promise<Outcome>
}

export interface ExecutorDeps {
  exec: Exec
  orca: OrcaCli
  notify(title: string, body: string): Promise<void>
  crew?: Crew
  ghBin?: string
  /**
   * Matriarch's own terminal in the project, to send orchestration mail from: Orca refuses a
   * sender it cannot place in a terminal (no_active_sender_terminal), and a plugin has none.
   */
  mailbox?: (ctx: ActionContext) => Promise<string | null>
}

const LOG_LINES = 40
// GitHub Actions log lines start with an ISO timestamp; colour codes add noise for an agent.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

export function tailLog(raw: string, lines = LOG_LINES): string {
  const cleaned = raw
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, '').replace(ANSI, ''))
    .filter((l) => l.trim() !== '')
  return cleaned.slice(-lines).join('\n')
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const gh = deps.ghBin ?? 'gh'
  const repoArg = (r: RepoRef) => `${r.owner}/${r.name}`

  async function run(args: string[]): Promise<Outcome> {
    const res = await deps.exec(gh, args, { timeoutMs: 120_000 })
    return res.code === 0 ? { ok: true } : { ok: false, error: `${gh} ${args.slice(0, 2).join(' ')}: ${(res.stderr || res.stdout).trim().slice(0, 400)}` }
  }

  async function jobLogs(repo: RepoRef, jobIds: readonly { name: string; jobId: number | null }[]): Promise<Record<string, string>> {
    const logs: Record<string, string> = {}
    for (const { name, jobId } of jobIds.slice(0, 5)) {
      if (jobId === null) continue
      const res = await deps.exec(gh, ['api', `repos/${repoArg(repo)}/actions/jobs/${jobId}/logs`], { timeoutMs: 60_000 })
      if (res.code === 0 && res.stdout) logs[name] = tailLog(res.stdout)
    }
    return logs
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
          const logs = await jobLogs(repo, action.checks)
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
        case 'update-branch':
          return run(['pr', 'update-branch', String(pr.number), '--repo', repoArg(repo), ...(action.method === 'rebase' ? ['--rebase'] : [])])
        case 'merge':
          return run([
            'pr',
            'merge',
            String(pr.number),
            '--repo',
            repoArg(repo),
            `--${action.method}`,
            '--match-head-commit',
            action.sha,
            ...(config.merge.deleteBranch ? ['--delete-branch'] : [])
          ])
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
          const review = githubReview(pr, run.outcome, action.round)
          const post = (comments: typeof review.comments) =>
            deps.exec(gh, ['api', `repos/${repoArg(repo)}/pulls/${pr.number}/reviews`, '-X', 'POST', '--input', '-'], {
              input: JSON.stringify({ commit_id: action.sha, event: 'COMMENT', body: review.body, comments: comments.map((c) => ({ ...c, side: 'RIGHT' })) }),
              timeoutMs: 60_000
            })
          let res = await post(review.comments)
          // A finding on a line outside the diff makes GitHub refuse inline comments: keep the summary.
          if (res.code !== 0 && review.comments.length > 0 && /422|Unprocessable|line/i.test(res.stderr + res.stdout)) res = await post([])
          return res.code === 0 ? { ok: true } : { ok: false, error: `gh api reviews: ${(res.stderr || res.stdout).trim().slice(0, 300)}` }
        }
      }
    }
  }
}
