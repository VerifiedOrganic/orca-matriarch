// The forge a project lives on: GitHub through `gh`, or GitLab (gitlab.com or self-hosted)
// through `glab`. The engine, executor, planner and briefs ask a project's forge instead of
// GitHub directly. GitHub's side is in github.ts and GitLab's in gitlab.ts; both read a PR into
// the same PrSnapshot, so the planner never needs to know which one it reads.
import type { CheckInfo, ListOptions, OpenList, PrSnapshot, RateInfo } from './github.ts'

export type ForgeKind = 'github' | 'gitlab'

/**
 * A project on its forge. On GitHub, `owner/name` on github.com, with `kind` and `host` left out
 * as in everything stored before GitLab. On GitLab, `owner` is the project's namespace with every
 * nested group in it (`group/sub`), and `host` is gitlab.com or a self-hosted GitLab.
 */
export interface RepoRef {
  owner: string
  name: string
  kind?: ForgeKind
  host?: string
}

export const forgeKind = (r: { kind?: ForgeKind } | null | undefined): ForgeKind => r?.kind ?? 'github'

/** The project's path on its forge: `owner/name`, or `group/sub/project` on GitLab. */
export const projectPath = (r: RepoRef): string => `${r.owner}/${r.name}`

/**
 * A project's storage key and its name on the board. GitHub's stay `owner/name`: a live
 * installation's state is stored under them. GitLab's carry the host, `<host>/<path>`, so a
 * GitLab project never takes a GitHub project's records.
 */
export const repoKey = (r: RepoRef): string => (forgeKind(r) === 'gitlab' ? `${r.host ?? 'gitlab.com'}/${projectPath(r)}` : projectPath(r))

/** A GitLab project from its host and path; the namespace is everything before the last slash. */
export function gitlabRef(host: string, path: string): RepoRef {
  const cut = path.lastIndexOf('/')
  return { kind: 'gitlab', host, owner: path.slice(0, cut), name: path.slice(cut + 1) }
}

/** What happened when Matriarch acted: done, failed with the forge's or Orca's words, or skipped on purpose. */
export interface Outcome {
  ok: boolean
  error?: string
  /** Set when the action was deliberately not carried out (not built yet, say). */
  skipped?: string
  /** The message it sent, for the activity log: who to, its subject, and why it went there. */
  sent?: { to: 'worker' | 'supervisor' | 'you'; subject: string; note?: string }
}

/** An open issue, as handed to the supervisor. */
export interface IssueInfo {
  number: number
  /** Cut to ISSUE_TITLE_MAX. */
  title: string
  /** As written on the forge, cut to ISSUE_BODY_MAX: the issue's text, not the user's instructions. */
  body: string
  url: string
  author: string | null
  /** When the forge last saw any change to it, to know when a check is out of date. */
  updatedAt: string
}

export const ISSUE_TITLE_MAX = 300
export const ISSUE_BODY_MAX = 6000
/** Pages of 100 read at most: past this many open labeled issues, the board says it read only some. */
export const ISSUE_PAGES = 5

/** The open issues with a label, oldest first; `truncated` when there were more than ISSUE_PAGES. */
export interface IssueList {
  issues: IssueInfo[]
  truncated: boolean
}

/**
 * Whether an issue may be handed over: the label was last added by someone allowed to triage
 * issues, and neither its title nor its body changed after that. `at` is when that label event
 * happened, when it was found: each time the label is added is its own go-ahead.
 */
export type LabelCheck = { ok: true; by: string; at: string } | { ok: false; why: string; at?: string }

/** A title and body as the forge gave them, cut to size before anything keeps them. */
export const issueText = (title: string, body: string): { title: string; body: string } => ({
  title: title.slice(0, ISSUE_TITLE_MAX),
  body: body.length > ISSUE_BODY_MAX ? `${body.slice(0, ISSUE_BODY_MAX)}\n…(truncated; read the rest on the issue)` : body
})

/** Reads a forge's open PRs cheaply, and one PR in full. */
export interface ForgeReader {
  listOpen(repo: RepoRef, options?: ListOptions): Promise<OpenList>
  detail(repo: RepoRef, number: number): Promise<{ pr: PrSnapshot | null; rate: RateInfo | null }>
  /**
   * What the forge kept of each failed check, by check name, to tell a flaky failure from a real
   * one (flaky.ts): its log tail, and GitHub's annotations or GitLab's failure reason.
   */
  failureDetails?(repo: RepoRef, checks: readonly CheckInfo[]): Promise<Record<string, string>>
  /** Open issues with this label, oldest first, up to ISSUE_PAGES pages; absent where a forge cannot say. */
  labeledIssues?(repo: RepoRef, label: string): Promise<IssueList>
  /** Who last added the label, whether they may triage issues, and whether it was edited since. Throws when it cannot tell. */
  labelCheck?(repo: RepoRef, issue: IssueInfo, label: string): Promise<LabelCheck>
  /** Whether branch `ref` has commit `sha`; null when the forge cannot say. */
  isAncestor?(repo: RepoRef, sha: string, ref: string): Promise<boolean | null>
}

/** One AI review as it goes on the PR: a summary, and the findings anchored to lines. */
export interface ForgeReview {
  body: string
  comments: { path: string; line: number; body: string }[]
}

/** What Matriarch does on a forge when autopilot is on. Each answers what the forge said. */
export interface ForgeActions {
  /** Merges exactly `sha`, the reviewed commit, never bypassing the forge's own merge rules. */
  merge(repo: RepoRef, pr: PrSnapshot, sha: string, method: 'squash' | 'merge' | 'rebase', deleteBranch: boolean): Promise<Outcome>
  /** Brings a branch that is only behind its base up to date. */
  updateBranch(repo: RepoRef, pr: PrSnapshot, method: 'rebase' | 'merge'): Promise<Outcome>
  /** The update methods the forge carries out itself; for another, the worker is asked to do it. */
  readonly updates: readonly ('rebase' | 'merge')[]
  /** Posts the review as the signed-in person, marked as Matriarch's own. */
  publishReview(repo: RepoRef, pr: PrSnapshot, sha: string, review: ForgeReview): Promise<Outcome>
  /** The last lines of each failed check's log, by check name, where the forge keeps one. */
  failedLogs(repo: RepoRef, checks: readonly CheckInfo[]): Promise<Record<string, string>>
  /** Points a PR at another base branch: a stacked PR, once the PR it was stacked on merged. */
  retarget(repo: RepoRef, pr: PrSnapshot, base: string): Promise<Outcome>
  /** Runs failed checks' jobs again (checks that looked flaky); several only when they share a GitHub workflow run. */
  rerun(repo: RepoRef, checks: readonly CheckInfo[]): Promise<Outcome>
  /** Posts one comment on an issue as the signed-in person. */
  commentIssue?(repo: RepoRef, number: number, body: string): Promise<Outcome>
}

export interface Forge extends ForgeReader, ForgeActions {
  readonly kind: ForgeKind
}

/** How a forge is named, and the commands an agent runs there, for briefs and messages. */
export interface ForgeTerms {
  /** GitHub or GitLab. */
  name: string
  /** Where a PR's own text goes. */
  body: string
  /** Opens a PR from the current branch into `base`. */
  create(base: string): string
  /** Marks a draft ready. */
  ready(number: number | string): string
  /** The state a merged PR shows, and the command that shows it. */
  merged(number: number | string): string
  /** How a worker resolves a review thread it fixed. */
  resolve: string
  /** Why the forge refuses to merge a PR that is otherwise ready. */
  blocked: string
}

const TERMS: Record<ForgeKind, ForgeTerms> = {
  github: {
    name: 'GitHub',
    body: 'PR body',
    create: (base) => `gh pr create --base ${base} --fill`,
    ready: (n) => `gh pr ready ${n}`,
    merged: (n) => `MERGED (gh pr view ${n} --json state)`,
    resolve: 'GraphQL resolveReviewThread with the thread id',
    blocked: 'GitHub blocks the merge (branch protection: approvals or required checks)'
  },
  gitlab: {
    name: 'GitLab',
    body: 'merge request description',
    create: (base) => `glab mr create --target-branch ${base} --fill --yes`,
    ready: (n) => `glab mr update ${n} --ready`,
    merged: (n) => `state merged (glab mr view ${n} -F json)`,
    resolve: 'glab api graphql with the mutation discussionToggleResolve, the thread id and resolve: true',
    blocked: 'GitLab blocks the merge (approvals, unresolved threads or another merge check)'
  }
}

/** The names and agent-facing commands of a forge; GitHub's when none is given. */
export const forgeTerms = (kind: ForgeKind | undefined = 'github'): ForgeTerms => TERMS[kind]

/**
 * A git remote's host and project path, from the https, `ssh://` and scp-like `git@host:path`
 * forms, with a trailing `.git` or `/` dropped. An https port is part of the web host and is
 * kept; an ssh port is not (the API is not served there). Null when it names no project.
 */
export function parseRemote(url: string): { host: string; path: string } | null {
  const u = url.trim()
  const m =
    u.match(/^(?:ssh|git\+ssh):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i) ??
    u.match(/^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/i) ??
    u.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/)
  if (!m) return null
  const path = m[2].replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '')
  const parts = path.split('/')
  if (parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..' || /\s/.test(p))) return null
  return { host: m[1].toLowerCase(), path }
}

const LOG_LINES = 40
// GitHub Actions log lines start with an ISO timestamp; colour codes add noise for an agent.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

/** The last lines of a CI log, without timestamps, colour codes or blank lines. */
export function tailLog(raw: string, lines = LOG_LINES): string {
  const cleaned = raw
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, '').replace(ANSI, ''))
    .filter((l) => l.trim() !== '')
  return cleaned.slice(-lines).join('\n')
}
