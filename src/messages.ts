// What Matriarch tells workers and the supervisor. One message per round, written as
// instructions an agent can follow without asking. Commands come from the PR's forge.
import { forgeTerms } from './forge.ts'
import type { CheckInfo, PrSnapshot, ThreadInfo } from './github.ts'

export interface Message {
  subject: string
  body: string
}

const short = (sha: string): string => sha.slice(0, 7)
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text)

function closing(round: number, max: number): string {
  return round >= max
    ? `This is the last automatic round (${round}/${max}); if it still fails, the supervisor takes over.`
    : `This is round ${round} of ${max}.`
}

export function ciFailureMessage(pr: PrSnapshot, checks: readonly CheckInfo[], logs: Readonly<Record<string, string>>, round: number, max: number): Message {
  const parts = checks.map((c) => {
    const log = logs[c.name]
    const head = `- ${c.name}${c.url ? `: ${c.url}` : ''}`
    return log ? `${head}\n  Last lines of its log:\n\`\`\`\n${clip(log, 4000)}\n\`\`\`` : head
  })
  return {
    subject: `CI failed on #${pr.number} (${short(pr.headSha)}), round ${round}/${max}`,
    body: [
      `CI failed on PR #${pr.number} "${pr.title}" at ${short(pr.headSha)} (branch ${pr.headRef}).`,
      '',
      'Failing checks:',
      ...parts,
      '',
      `Fix the cause, run the same checks locally, then commit and push to ${pr.headRef}. Do not open a new PR. Matriarch watches CI after you push.`,
      closing(round, max)
    ].join('\n')
  }
}

export function rebaseMessage(pr: PrSnapshot, round: number, max: number): Message {
  return {
    subject: `#${pr.number} conflicts with ${pr.baseRef}, round ${round}/${max}`,
    body: [
      `PR #${pr.number} "${pr.title}" (branch ${pr.headRef}) has merge conflicts with ${pr.baseRef}.`,
      '',
      `Run git fetch, rebase ${pr.headRef} onto origin/${pr.baseRef}, and resolve every conflict keeping the intent of both sides.`,
      `Run the checks, then push with git push --force-with-lease. Do not merge ${pr.baseRef} into the branch and do not open a new PR.`,
      closing(round, max)
    ].join('\n')
  }
}

/**
 * A branch that is only behind its base, when its forge cannot update it the way the project
 * asked (GitLab has no API to merge the base into a branch): the worker brings it up to date.
 */
export function updateMessage(pr: PrSnapshot, method: 'rebase' | 'merge'): Message {
  const how =
    method === 'merge'
      ? `Run git fetch, merge origin/${pr.baseRef} into ${pr.headRef}, resolve any conflict keeping the intent of both sides, run the checks, then push (no force push).`
      : `Run git fetch, rebase ${pr.headRef} onto origin/${pr.baseRef}, resolve any conflict keeping the intent of both sides, run the checks, then push with git push --force-with-lease.`
  return {
    subject: `#${pr.number} is behind ${pr.baseRef}: bring it up to date`,
    body: [
      `PR #${pr.number} "${pr.title}" (branch ${pr.headRef}) is behind ${pr.baseRef}, and ${forgeTerms(pr.forge).name} cannot ${method === 'merge' ? `merge ${pr.baseRef} into it` : 'rebase it'} for Matriarch.`,
      '',
      how,
      'Do not open a new PR. Matriarch watches CI after you push.'
    ].join('\n')
  }
}

export function commentsMessage(pr: PrSnapshot, threads: readonly ThreadInfo[], round: number, max: number): Message {
  const items = threads.map((t, i) => {
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ''}` : 'review'
    const who = t.author ? `@${t.author}` : 'a reviewer'
    const id = t.id.startsWith('review:') ? '' : ` [thread ${t.id}]`
    return `${i + 1}. ${where}, ${who}${id}${t.url ? ` ${t.url}` : ''}\n${clip(t.body, 2000)}`
  })
  return {
    subject: `Review feedback on #${pr.number}, round ${round}/${max}`,
    body: [
      `Review feedback on PR #${pr.number} "${pr.title}" needs changes:`,
      '',
      ...items,
      '',
      `Address each item, run the checks, then commit and push to ${pr.headRef}. Where you disagree, reply on the thread instead of changing code.`,
      `After pushing, resolve the threads you fixed (${forgeTerms(pr.forge).resolve}).`,
      closing(round, max)
    ].join('\n')
  }
}

/** A draft nobody works on: a routine question for the supervisor, not a problem to decide. */
export function draftMessage(pr: PrSnapshot, reason: string): Message {
  return {
    subject: `${pr.repo} #${pr.number} is still a draft`,
    body: [`PR #${pr.number} "${pr.title}" (branch ${pr.headRef}, ${short(pr.headSha)}): ${reason}`, pr.url].join('\n')
  }
}

export function escalationMessage(pr: PrSnapshot, reason: string): Message {
  return {
    subject: `Matriarch needs a decision on ${pr.repo} #${pr.number}`,
    body: [
      `PR #${pr.number} "${pr.title}" (branch ${pr.headRef}, ${short(pr.headSha)}) is stuck: ${reason}.`,
      pr.url,
      '',
      'Decide the next step: send the worker new instructions, start a fixer on a stronger tier, resolve it yourself in a fresh worktree, split the PR, or close it.',
      'Matriarch keeps watching the PR and continues when its state changes.'
    ].join('\n')
  }
}
