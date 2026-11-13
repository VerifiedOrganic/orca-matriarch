// The review crew's contract: the brief each reviewer gets, the verdict file it writes, and how
// several verdicts become one outcome. Pure, so every policy is unit-tested.
import { SEVERITIES, type MatriarchConfig, type ReviewerSpec, type Severity } from './config.ts'
import { forgeTerms } from './forge.ts'
import { OUR_MARKER, type PrSnapshot } from './github.ts'

export interface Finding {
  severity: Severity
  file: string | null
  line: number | null
  title: string
  detail: string
  suggestion: string
}

export interface Verdict {
  verdict: 'approve' | 'request_changes'
  summary: string
  findings: Finding[]
}

/** A finding after merging duplicates across reviewers. */
export interface CrewFinding extends Finding {
  reviewers: string[]
}

export interface CrewOutcome {
  verdict: 'pass' | 'changes'
  /** Findings at or above `blockAt`: what the worker must fix. */
  blocking: CrewFinding[]
  /** Every finding, merged, most severe first. */
  findings: CrewFinding[]
  summary: string
}

/** Where a reviewer writes its verdict, relative to the review worktree. */
export const verdictPath = (sha: string, reviewer: string): string => `.matriarch/review/${sha.slice(0, 12)}/${reviewer}.json`

const rank = (s: Severity): number => SEVERITIES.indexOf(s) // blocker 0 … nit 3
export const atLeast = (s: Severity, floor: Severity): boolean => rank(s) <= rank(floor)

function severityOf(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase().trim()
  if (s === 'critical' || s === 'blocker' || s === 'high') return s === 'high' ? 'major' : 'blocker'
  if (s === 'major' || s === 'medium') return 'major'
  if (s === 'minor' || s === 'low') return 'minor'
  return 'nit'
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Reads a verdict file's JSON. Tolerant of wording, strict about shape; null when unusable. */
export function parseVerdict(raw: string): Verdict | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // Agents sometimes wrap JSON in a fence; take the outermost object.
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      data = JSON.parse(m[0])
    } catch {
      return null
    }
  }
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  const v = String(d.verdict ?? '').toLowerCase().replace(/[\s-]/g, '_')
  const verdict = v === 'approve' || v === 'approved' ? 'approve' : v === 'request_changes' || v === 'changes_requested' ? 'request_changes' : null
  if (!verdict) return null
  const list = Array.isArray(d.findings) ? d.findings : []
  const findings: Finding[] = list
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      severity: severityOf(f.severity),
      file: text(f.file ?? f.path, 300) || null,
      line: typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : null,
      title: text(f.title, 200) || text(f.detail, 120) || 'finding',
      detail: text(f.detail ?? f.body, 4000),
      suggestion: text(f.suggestion, 2000)
    }))
  return { verdict, summary: text(d.summary, 2000), findings }
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
function similar(a: string, b: string): boolean {
  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return a.toLowerCase() === b.toLowerCase()
  let common = 0
  for (const w of wa) if (wb.has(w)) common++
  return common / Math.min(wa.size, wb.size) >= 0.5
}

/** Two reviewers flagging the same place for the same reason is one finding with two voices. */
export function mergeFindings(byReviewer: readonly { reviewer: string; findings: readonly Finding[] }[]): CrewFinding[] {
  const out: CrewFinding[] = []
  for (const { reviewer, findings } of byReviewer) {
    for (const f of findings) {
      const same = out.find(
        (o) => o.file === f.file && (o.line === null || f.line === null || Math.abs(o.line - f.line) <= 3) && similar(o.title, f.title)
      )
      if (same) {
        if (!same.reviewers.includes(reviewer)) same.reviewers.push(reviewer)
        if (rank(f.severity) < rank(same.severity)) same.severity = f.severity
        if (f.detail.length > same.detail.length) same.detail = f.detail
        if (!same.suggestion && f.suggestion) same.suggestion = f.suggestion
      } else {
        out.push({ ...f, reviewers: [reviewer] })
      }
    }
  }
  return out.sort((a, b) => rank(a.severity) - rank(b.severity))
}

export interface ReviewerResult {
  reviewer: ReviewerSpec
  verdict: Verdict | null
  error?: string
}

/** One outcome from the crew under the repo's pass policy. */
export function aggregate(results: readonly ReviewerResult[], review: MatriarchConfig['review']): CrewOutcome {
  const ok = results.filter((r) => r.verdict)
  const findings = mergeFindings(ok.map((r) => ({ reviewer: r.reviewer.name, findings: r.verdict!.findings })))
  const blocking = findings.filter((f) => atLeast(f.severity, review.blockAt))
  const approvals = ok.filter((r) => r.verdict!.verdict === 'approve').length
  let pass: boolean
  switch (review.pass) {
    case 'majority':
      // Of the whole crew, not just those who answered: silence is not a vote to approve.
      pass = approvals * 2 > results.length
      break
    case 'no-blockers':
      pass = blocking.length === 0 && ok.length * 2 > results.length
      break
    default: {
      const blockers = results.filter((r) => r.reviewer.blocking)
      pass = blocking.length === 0 && blockers.every((r) => r.verdict?.verdict === 'approve')
    }
  }
  const failed = results.filter((r) => !r.verdict).map((r) => r.reviewer.name)
  const votes = ok.map((r) => `${r.reviewer.name}: ${r.verdict!.verdict === 'approve' ? 'approve' : 'request changes'}`)
  const summary = [
    `${pass ? 'Pass' : 'Changes needed'} (${review.pass}): ${votes.join(', ')}${failed.length ? `; no verdict from ${failed.join(', ')}` : ''}.`,
    `${findings.length} finding(s), ${blocking.length} at or above ${review.blockAt}.`
  ].join(' ')
  return { verdict: pass ? 'pass' : 'changes', blocking, findings, summary }
}

export interface BriefInput {
  pr: PrSnapshot
  reviewer: ReviewerSpec
  round: number
  maxRounds: number
  /** The previous round's blocking findings, to check they were fixed. */
  previous: { sha: string; findings: readonly CrewFinding[] } | null
  /** A later round looks only at what changed since the previous one (`review.followUp: focused`). */
  focused?: boolean
}

export function reviewerBrief(input: BriefInput): string {
  const { pr, reviewer, round, maxRounds, previous } = input
  const out = verdictPath(pr.headSha, reviewer.name)
  const since = previous ? previous.sha.slice(0, 12) : ''
  const followUp = previous !== null && input.focused === true
  const lines = [
    `You are the "${reviewer.name}" reviewer on Matriarch's review crew for PR #${pr.number} "${pr.title}" in ${pr.repo} (round ${round} of ${maxRounds}).`,
    reviewer.focus ? `Your focus: ${reviewer.focus}. Report other serious problems too, but spend your effort there.` : '',
    `This worktree is a read-only checkout of the PR head ${pr.headSha.slice(0, 12)} (branch ${pr.headRef}, base ${pr.baseRef}).`,
    '',
    'Steps:',
    followUp
      ? `1. This is a follow-up round. Read what changed since the last review: git diff ${since}..HEAD and git log --oneline ${since}..HEAD, and check that each finding listed below was fixed.`
      : `1. Read the change: git diff origin/${pr.baseRef}...HEAD and git log --oneline origin/${pr.baseRef}..HEAD. Read surrounding code where you need context.`,
    followUp
      ? '2. Review only the lines that changed since then and what they affect; do not review again code that did not change. Point at the exact file and line for every finding.'
      : '2. Review only what this PR changes. Point at the exact file and line for every finding.',
    `3. Do not edit, commit, push, install, build or run tests, and post nothing to ${forgeTerms(pr.forge).name}. Other reviewers work beside you.`,
    '   This session is locked to reading this worktree: anything that would change files outside .matriarch/review/, or read outside this worktree, is refused automatically. Use paths relative to the worktree. Do not retry a refused command; read with git, grep and cat instead.',
    `4. Write your verdict as JSON to ${out} (create the folders), exactly this shape:`,
    '{"verdict": "approve" | "request_changes", "summary": "two or three sentences", "findings": [{"severity": "blocker" | "major" | "minor" | "nit", "file": "path/from/repo/root", "line": 12, "title": "short", "detail": "what is wrong and why", "suggestion": "how to fix"}]}',
    '   Use request_changes only when at least one finding is major or blocker. An empty findings list is fine.',
    '5. After writing the file, stop. Do not wait for replies.'
  ]
  if (previous && previous.findings.length > 0) {
    lines.push(
      '',
      `The last round (at ${previous.sha.slice(0, 7)}) asked for these fixes. Check each one in git diff ${previous.sha.slice(0, 12)}..HEAD and keep any that is not fixed:`,
      ...previous.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.title}`)
    )
  }
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n')
}

/** The worker's message when the crew asks for changes: one list, most severe first. */
/** How many findings below the blocking level the worker's message carries, shortest first. */
const OPTIONAL_MAX = 15

export function findingsMessage(pr: PrSnapshot, outcome: CrewOutcome, round: number, maxRounds: number): { subject: string; body: string } {
  const item = (f: CrewFinding, i: number, short = false) =>
    `${i + 1}. [${f.severity}] ${f.file ?? '(general)'}${f.line ? `:${f.line}` : ''}: ${f.title} (${f.reviewers.join(', ')})\n${short ? f.detail.slice(0, 300) : f.detail}${f.suggestion ? `\nSuggested fix: ${short ? f.suggestion.slice(0, 200) : f.suggestion}` : ''}`
  // Every finding the summary counts is in the message, so none has to be looked for elsewhere.
  const blocking = new Set(outcome.blocking)
  const optional = outcome.findings.filter((f) => !blocking.has(f))
  return {
    subject: `AI review asks for changes on #${pr.number}, round ${round}/${maxRounds}`,
    body: [
      `Matriarch's review crew reviewed PR #${pr.number} "${pr.title}" at ${pr.headSha.slice(0, 7)}. ${outcome.summary}`,
      '',
      `Required to pass (${outcome.blocking.length}):`,
      ...outcome.blocking.map((f, i) => item(f, i)),
      ...(optional.length
        ? ['', `Optional (${optional.length}, below the blocking level): fix them if it is cheap and safe, otherwise leave them.`, ...optional.slice(0, OPTIONAL_MAX).map((f, i) => item(f, i, true)), ...(optional.length > OPTIONAL_MAX ? [`(${optional.length - OPTIONAL_MAX} more minor findings left out)`] : [])]
        : []),
      '',
      `Fix each item, run the checks, then commit and push to ${pr.headRef}. If you believe a finding is wrong, say why in your commit message instead of changing the code.`,
      'The crew reviews the new commit after CI passes.'
    ].join('\n')
  }
}

/**
 * One review as Matriarch posts it: the summary as the body, blocking findings inline. GitHub
 * takes it as a comment review; GitLab as one note, with the inline findings folded in.
 */
export function githubReview(pr: PrSnapshot, outcome: CrewOutcome, round: number): { body: string; comments: { path: string; line: number; body: string }[] } {
  const marker = `${OUR_MARKER}:review round=${round} sha=${pr.headSha} -->`
  const rows = outcome.findings.map((f) => `| ${f.severity} | ${f.file ?? ''}${f.line ? `:${f.line}` : ''} | ${f.title.replace(/\|/g, '\\|')} | ${f.reviewers.join(', ')} |`)
  const body = [
    marker,
    `### Matriarch AI review, round ${round}: ${outcome.verdict === 'pass' ? 'passed' : 'changes requested'}`,
    outcome.summary,
    ...(rows.length ? ['', '| Severity | Where | Finding | Reviewers |', '|---|---|---|---|', ...rows] : [])
  ].join('\n')
  const comments = outcome.blocking
    .filter((f): f is CrewFinding & { file: string; line: number } => f.file !== null && f.line !== null)
    .map((f) => ({
      path: f.file,
      line: f.line,
      body: `${OUR_MARKER}:finding -->\n**[${f.severity}] ${f.title}** (${f.reviewers.join(', ')})\n\n${f.detail}${f.suggestion ? `\n\nSuggested fix: ${f.suggestion}` : ''}`
    }))
  return { body, comments }
}
