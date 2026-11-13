// What Matriarch already did for each PR, kept in plugin storage. Entries are keyed by head
// commit, so a new push starts a new round and an old one is never repeated. An action is
// recorded only after it succeeded: a crash costs at most one repeat, never a lost step.
import type { Action } from './plan.ts'

export interface ReviewRecord {
  round: number
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  verdict?: 'pass' | 'changes'
  /** Blocking findings in the outcome. */
  findings?: number
  /** The findings reached the worker. */
  delivered?: boolean
  /** The review was posted to GitHub. */
  published?: boolean
  /** Stopped because the PR moved to a new commit; does not use up a round. */
  superseded?: boolean
}

export interface Escalation {
  to: 'supervisor' | 'human'
  at: number
  reason: string
}

export interface PrLedger {
  v: 1
  ci: Record<string, { at: number; signature: string }>
  conflicts: Record<string, { at: number }>
  comments: Record<string, { at: number; threadIds: string[] }>
  reviews: Record<string, ReviewRecord>
  updates: Record<string, { at: number }>
  escalations: Record<string, Escalation>
  notified: Record<string, number>
  merge: { sha: string; at: number; status: 'requested' | 'merged' | 'failed'; error?: string } | null
  /** When each head commit was first seen: gives CI time to register its checks. */
  heads: Record<string, number>
  /** CI checks have shown up on this PR at least once: "no checks" is then a gap, not "no CI". */
  ciSeen?: boolean
  /**
   * The worker that built the PR (the first one seen on it), and whether it has finished a turn
   * since. Work by another worker, or by this one after that, is a fix.
   */
  builder?: { address: string; done: boolean }
}

export const ledgerKey = (repo: string, number: number): string => `pr:${repo}#${number}`

export function emptyLedger(): PrLedger {
  return { v: 1, ci: {}, conflicts: {}, comments: {}, reviews: {}, updates: {}, escalations: {}, notified: {}, merge: null, heads: {} }
}

const rec = (v: unknown): Record<string, never> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, never>) : {}

/** Reads a stored ledger, filling anything missing, so an older shape never breaks a tick. */
export function loadLedger(raw: unknown): PrLedger {
  const r = rec(raw)
  const base = emptyLedger()
  const merge = rec(r.merge)
  return {
    v: 1,
    ci: { ...rec(r.ci) },
    conflicts: { ...rec(r.conflicts) },
    comments: { ...rec(r.comments) },
    reviews: { ...rec(r.reviews) },
    updates: { ...rec(r.updates) },
    escalations: { ...rec(r.escalations) },
    notified: { ...rec(r.notified) },
    merge: typeof merge.sha === 'string' ? (merge as unknown as PrLedger['merge']) : base.merge,
    heads: { ...rec(r.heads) },
    ...(r.ciSeen === true ? { ciSeen: true } : {}),
    ...(typeof rec(r.builder).address === 'string' ? { builder: { address: rec(r.builder).address as string, done: rec(r.builder).done === true } } : {})
  }
}

/** Fix rounds used: each head commit that got a message counts once. */
export function roundsUsed(ledger: PrLedger, kind: 'ci' | 'conflicts' | 'comments' | 'reviews'): number {
  // Only rounds that asked for changes (or failed) count: a pass is not a round spent fixing.
  if (kind === 'reviews') return Object.values(ledger.reviews).filter((r) => !r.superseded && (r.status === 'failed' || r.verdict === 'changes')).length
  return Object.keys(ledger[kind]).length
}

/** The ledger after `action` succeeded. Pure. */
export function record(ledger: PrLedger, action: Action, now: number): PrLedger {
  const next: PrLedger = loadLedger(structuredClone(ledger))
  switch (action.kind) {
    case 'send-ci-failure':
      next.ci[action.sha] = { at: now, signature: action.signature }
      break
    case 'send-rebase':
      next.conflicts[action.sha] = { at: now }
      break
    case 'send-comments': {
      const prior = next.comments[action.sha]?.threadIds ?? []
      next.comments[action.sha] = { at: now, threadIds: [...new Set([...prior, ...action.threads.map((t) => t.id)])] }
      break
    }
    case 'update-branch':
      next.updates[action.sha] = { at: now }
      break
    case 'start-review':
      next.reviews[action.sha] = { round: action.round, status: 'running', startedAt: now }
      break
    case 'send-findings':
      if (next.reviews[action.sha]) next.reviews[action.sha] = { ...next.reviews[action.sha], delivered: true }
      break
    case 'publish-review':
      if (next.reviews[action.sha]) next.reviews[action.sha] = { ...next.reviews[action.sha], published: true }
      break
    case 'merge':
      next.merge = { sha: action.sha, at: now, status: 'requested' }
      break
    case 'escalate':
      next.escalations[action.key] = { to: action.to, at: now, reason: action.reason }
      break
    case 'notify':
      next.notified[action.key] = now
      break
  }
  return next
}
