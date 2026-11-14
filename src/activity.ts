// The activity log's lines: what Matriarch did on a track, said the way a person would say it.
// Only actions it carried out (or tried and failed) are logged, never what dry run would do.
import { forgeTerms, type ForgeKind, type Outcome } from './forge.ts'
import type { Action } from './plan.ts'
import type { LogEntry, Mark } from './protocol.ts'

const short = (sha: string): string => sha.slice(0, 7)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const WHO = { worker: 'the worker', supervisor: 'the supervisor', you: 'you' } as const

/** What was done, in the past tense; `who` is who a message went to. */
function done(action: Action, who: string, forge: ForgeKind): string {
  switch (action.kind) {
    case 'send-ci-failure':
      return `Sent ${who} ${plural(action.checks.length, 'failing check')} (${action.checks.map((c) => c.name).join(', ')}), round ${action.round}`
    case 'send-rebase':
      return `Asked ${who} to rebase onto ${action.base}, round ${action.round}`
    case 'send-comments':
      return `Sent ${who} ${plural(action.threads.length, 'review comment')}, round ${action.round}`
    case 'update-branch':
      return `Updated the branch from its base (${action.method})`
    case 'start-review':
      return `Started AI review round ${action.round}: ${action.reviewers.map((r) => `${r.name} (${r.agent}${r.model ? ` ${r.model}` : ''})`).join(', ')}`
    case 'send-findings':
      return `Sent ${who} the AI review findings, round ${action.round}`
    case 'publish-review':
      return forge === 'gitlab' ? 'Posted the AI review on the merge request as a note' : 'Posted the AI review on the PR as a comment review'
    case 'merge':
      return `Asked ${forgeTerms(forge).name} to merge ${short(action.sha)} (${action.method})`
    case 'escalate':
      if (action.to === 'human') return `Told you: ${action.reason}`
      return action.key.startsWith('draft:') ? `Asked ${who} whether the draft is ready: ${action.reason}` : `Escalated to ${who}: ${action.reason}`
    case 'notify':
      return `Told you: ${action.title}`
    case 'retarget':
      return `Moved the ${forge === 'gitlab' ? 'merge request' : 'PR'} from ${action.from} onto ${action.base}: #${action.parent}, which it was stacked on, merged`
    case 'send-restack':
      return `Asked ${who} to rebase off #${action.parent}'s commits onto ${action.base}, now that #${action.parent} merged`
    case 'rerun-check':
      return `Re-ran ${action.checks.map((c) => c.name).join(', ')} once: ${action.why}`
    default:
      // A kind this log has no words for yet still shows up, by its name.
      return (action as { kind: string }).kind
  }
}

/**
 * The log line for an action Matriarch carried out, or tried: `planned` is how the board words it
 * beforehand (the engine's describe), used for one that failed.
 */
export function logEntry(action: Action, outcome: Outcome, at: number, forge: ForgeKind, planned: string): LogEntry {
  const sent = outcome.sent
  if (!outcome.ok) return { at, kind: action.kind, text: `Tried to ${planned}`, error: outcome.error ?? 'failed' }
  // A branch update the forge cannot do went to the worker as a message.
  const text = action.kind === 'update-branch' && sent
    ? `Asked ${WHO[sent.to]} to ${action.method === 'merge' ? 'merge its base in' : 'rebase onto its base'}${forge === 'gitlab' ? ` (${forgeTerms(forge).name} cannot)` : ''}`
    : done(action, sent ? WHO[sent.to] : 'the worker', forge)
  return {
    at,
    kind: action.kind,
    text: sent?.note ? `${text} (${sent.note})` : text,
    ...(sent ? { to: sent.to, subject: sent.subject } : {})
  }
}

/** A timeline mark that is not an action (a new commit, a review that finished) as a log line. */
export function markEntry(mark: Mark): LogEntry {
  switch (mark.kind) {
    case 'push':
      return { at: mark.at, kind: 'push', text: `New commit: ${mark.label.replace(/^pushed /, '')}` }
    case 'review-done':
      return { at: mark.at, kind: 'review-done', text: `AI review finished: ${mark.label}` }
    default:
      return { at: mark.at, kind: mark.kind, text: mark.label }
  }
}
