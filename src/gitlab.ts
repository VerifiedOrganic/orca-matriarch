// GitLab through the signed-in `glab` CLI, on gitlab.com or a self-hosted GitLab. glab signs in
// to any host and keeps the token; Matriarch only names the host (`--hostname`), never a token.
//
// GitLab has no free way to ask whether anything changed: a conditional request answers 304 but
// still counts against the rate limit (checked on gitlab.com). So each tick reads the open merge
// requests in one GraphQL query, with each one's head pipeline status, the signed-in user, and the
// default branch's head and latest pipeline. A merge request's detail (jobs, threads, files,
// mergeability, approvals) is read again, in one more query, only when its head, update time or
// pipeline status moved, or every few minutes (QUIET_REFRESH_MS) for what the list cannot show.
// Merge requests are read into the same PrSnapshot as GitHub's PRs, so the planner reads both.
import type { Exec, ExecOptions, ExecResult } from './exec.ts'
import { projectPath, repoKey, tailLog, type Forge, type ForgeReview, type Outcome, type RepoRef } from './forge.ts'
import {
  ciStateOf,
  OUR_MARKER,
  QUIET_REFRESH_MS,
  type BaseBranch,
  type CheckInfo,
  type CheckState,
  type PrSnapshot,
  type PrSummary,
  type RateInfo,
  type ThreadInfo
} from './github.ts'

// Field names checked against gitlab.com's GraphQL API (2026-11-13). `iid` is a string there.
export const LIST_QUERY = `query($path: ID!, $ref: String!, $after: String) {
  currentUser { username }
  project(fullPath: $path) {
    repository { rootRef tree(ref: $ref) { lastCommit { sha } } }
    pipelines(ref: $ref, first: 1) { nodes { status sha } }
    mergeRequests(state: opened, first: 50, after: $after, sort: UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes { iid sourceBranch targetBranch diffHeadSha updatedAt author { username } headPipeline { status } }
    }
  }
}`

export const DETAIL_QUERY = `query($path: ID!, $iid: String!) {
  currentUser { username }
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      iid webUrl title description state draft sourceBranch targetBranch diffHeadSha updatedAt
      detailedMergeStatus conflicts approved
      author { username }
      approvedBy { nodes { username } }
      reviewers { nodes { username bot mergeRequestInteraction { reviewState } } }
      headPipeline { status jobs(first: 100, retried: false) { pageInfo { hasNextPage } nodes { id name status allowFailure webPath } } }
      discussions(first: 100) { pageInfo { hasNextPage } nodes { id resolvable resolved
        notes(first: 5) { nodes { body url author { username bot } position { newPath newLine oldPath oldLine } } } } }
      diffStatsSummary { fileCount }
      diffStats { path }
    }
  }
}`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nodes = (conn: unknown): Obj[] => {
  const n = obj(conn).nodes
  return Array.isArray(n) ? n.map(obj) : []
}
const hasNext = (conn: unknown): boolean => obj(obj(conn).pageInfo).hasNextPage === true
const lower = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '')

/** A job's status as a check state. A failure the job is allowed is a warning, not red. */
export function jobState(status: unknown, allowFailure: boolean): CheckState {
  switch (lower(status)) {
    case 'success':
      return 'success'
    case 'failed':
      return allowFailure ? 'neutral' : 'failure'
    case 'canceled':
    case 'canceling':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
    case 'manual':
      // A manual job nobody has to run is skipped; one the pipeline waits on holds it.
      return allowFailure ? 'skipped' : 'pending'
    default:
      // created, waiting_for_resource, preparing, pending, running, scheduled, waiting_for_callback
      return 'pending'
  }
}

/**
 * A pipeline status in the words the engine reads GitHub's CI rollup in: FAILURE when it failed,
 * PENDING while it has not finished, null when there is no pipeline.
 */
export function pipelineRollup(status: unknown): string | null {
  const s = lower(status)
  if (!s) return null
  if (s === 'success') return 'SUCCESS'
  if (s === 'failed') return 'FAILURE'
  if (s === 'canceled' || s === 'canceling') return 'CANCELLED'
  if (s === 'skipped') return 'SKIPPED'
  return 'PENDING'
}

/**
 * GitLab's detailed merge status in the words the planner reads GitHub's in: whether it can merge
 * (mergeable) and why not (mergeStateStatus). REST spells it in lower case, GraphQL in upper.
 */
export function mergeabilityOf(detailed: unknown, conflicts: boolean): { mergeable: PrSnapshot['mergeable']; mergeState: string } {
  const known = conflicts ? 'CONFLICTING' : 'MERGEABLE'
  switch (lower(detailed)) {
    case 'mergeable':
      return { mergeable: 'MERGEABLE', mergeState: 'CLEAN' }
    case 'conflict':
    case 'broken_status':
      return { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }
    case 'need_rebase':
      return { mergeable: known, mergeState: 'BEHIND' }
    case 'draft_status':
      return { mergeable: known, mergeState: 'DRAFT' }
    case 'ci_must_pass':
    case 'ci_still_running':
      // Waiting on its pipeline: the planner follows the pipeline's jobs itself.
      return { mergeable: known, mergeState: 'UNKNOWN' }
    case 'checking':
    case 'unchecked':
    case 'preparing':
    case 'approvals_syncing':
    case 'not_open':
    case '':
      return { mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }
    default:
      // not_approved, discussions_not_resolved, blocked_status, requested_changes, and the other
      // checks a person settles (external status checks, locked paths, merge time, title rules...).
      return { mergeable: known, mergeState: 'BLOCKED' }
  }
}

/** The project a job ran in, from its page (`/group/sub/project/-/jobs/1`): a fork's pipeline runs in the fork. */
export function jobProject(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).pathname.match(/^\/(.+?)\/-\/jobs\/\d+$/)?.[1] ?? null
  } catch {
    return null
  }
}

const OPEN_STATES: Record<string, PrSnapshot['state']> = { opened: 'OPEN', locked: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }

/**
 * A merge request's GraphQL detail as a PrSnapshot. Jobs of its head pipeline are its checks;
 * resolvable threads are its review threads (the viewer's own and Matriarch's marked ones count as
 * ours); a reviewer who requested changes is feedback too, like a GitHub "changes requested" review.
 */
export function normalizeMr(raw: unknown, repo: string, host: string, viewer: string, fetchedAt: number): PrSnapshot | null {
  const mr = obj(raw)
  const number = Number(str(mr.iid) ?? num(mr.iid))
  const headSha = str(mr.diffHeadSha)
  if (!Number.isInteger(number) || number <= 0 || headSha === null) return null

  const pipeline = obj(mr.headPipeline)
  const jobs = obj(pipeline.jobs)
  const checks: CheckInfo[] = nodes(jobs).map((j) => {
    const page = str(j.webPath)
    const id = str(j.id) ?? ''
    return {
      name: str(j.name) ?? 'job',
      state: jobState(j.status, j.allowFailure === true),
      url: page ? `https://${host}${page}` : null,
      // Only a build has a log; a bridge job starts another pipeline.
      jobId: /\/Ci::Build\/\d+$/.test(id) ? Number(id.slice(id.lastIndexOf('/') + 1)) : null
    }
  })
  // The pipeline's own status is the authority when its job list was cut short.
  const checksTruncated = hasNext(jobs)
  let ci = ciStateOf(checks)
  if (checksTruncated) {
    const rollup = pipelineRollup(pipeline.status)
    if (rollup === 'FAILURE') ci = 'failing'
    else if (rollup === 'PENDING') ci = 'pending'
  }

  const mine = (who: string | null) => viewer !== '' && who === viewer
  const threads: ThreadInfo[] = []
  for (const d of nodes(mr.discussions)) {
    // Only a thread someone can resolve asks for something; system notes and plain comments do not.
    if (d.resolvable !== true) continue
    const notes = nodes(d.notes)
    const first = notes[0] ?? {}
    const author = obj(first.author)
    const where = obj(first.position)
    const login = str(author.username)
    threads.push({
      id: str(d.id) ?? '',
      resolved: d.resolved === true,
      outdated: false,
      path: str(where.newPath) ?? str(where.oldPath),
      line: num(where.newLine) ?? num(where.oldLine),
      author: login,
      bot: author.bot === true,
      body: notes.map((n) => str(n.body) ?? '').join('\n\n---\n\n'),
      url: str(first.url),
      ours: mine(login) || notes.some((n) => (str(n.body) ?? '').includes(OUR_MARKER))
    })
  }
  for (const r of nodes(obj(mr.reviewers))) {
    if (obj(r.mergeRequestInteraction).reviewState !== 'REQUESTED_CHANGES') continue
    const login = str(r.username)
    threads.push({
      id: `review:${login ?? ''}`,
      resolved: false,
      outdated: false,
      path: null,
      line: null,
      author: login,
      bot: r.bot === true,
      body: '(changes requested; see their threads on the merge request)',
      url: str(mr.webUrl),
      ours: mine(login)
    })
  }

  const detailed = lower(mr.detailedMergeStatus)
  const { mergeable, mergeState } = mergeabilityOf(detailed, mr.conflicts === true)
  const approvers = nodes(obj(mr.approvedBy)).length
  const reviewDecision = threads.some((t) => t.id.startsWith('review:') && !t.ours)
    ? 'CHANGES_REQUESTED'
    : detailed === 'not_approved'
      ? 'REVIEW_REQUIRED'
      : mr.approved === true && approvers > 0
        ? 'APPROVED'
        : null

  const stats = Array.isArray(mr.diffStats) ? mr.diffStats.map(obj) : []
  const files = stats.map((f) => str(f.path) ?? '').filter(Boolean)
  const fileCount = num(obj(mr.diffStatsSummary).fileCount)
  return {
    forge: 'gitlab',
    repo,
    number,
    url: str(mr.webUrl) ?? `https://${host}/${repo.slice(host.length + 1)}/-/merge_requests/${number}`,
    title: str(mr.title) ?? '',
    body: str(mr.description) ?? '',
    author: str(obj(mr.author).username),
    headRef: str(mr.sourceBranch) ?? '',
    headSha,
    baseRef: str(mr.targetBranch) ?? '',
    draft: mr.draft === true,
    state: OPEN_STATES[lower(mr.state)] ?? 'OPEN',
    mergeable,
    mergeState,
    reviewDecision,
    ci,
    checks,
    checksTruncated,
    threads,
    threadsTruncated: hasNext(mr.discussions),
    files,
    filesTruncated: fileCount !== null && fileCount > files.length,
    updatedAt: str(mr.updatedAt) ?? '',
    fetchedAt
  }
}

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean
  ) {
    super(message)
    this.name = 'GitLabError'
  }
}

/** The status, headers and body of `glab api -i` output; output without headers is all body. */
export function splitInclude(stdout: string): { status: number | null; headers: Record<string, string>; body: string } {
  const status = stdout.match(/^HTTP\/[\d.]+\s+(\d{3})[^\n]*\n/)
  if (!status) return { status: null, headers: {}, body: stdout }
  const rest = stdout.slice(status[0].length)
  const end = rest.match(/\r?\n\r?\n/)
  const head = end ? rest.slice(0, end.index) : rest
  const headers: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { status: Number(status[1]), headers, body: end ? rest.slice(end.index! + end[0].length) : '' }
}

/** GitLab's rate limit from its RateLimit-* headers; null when the instance sends none (self-hosted may not). */
export function rateFromHeaders(headers: Readonly<Record<string, string>>): RateInfo | null {
  const left = headers['ratelimit-remaining']
  const remaining = Number(left)
  if (left === undefined || left === '' || !Number.isFinite(remaining)) return null
  const reset = Number(headers['ratelimit-reset'])
  return { cost: 1, remaining, resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : (headers['ratelimit-resettime'] ?? '') }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
/** GitLab's collapsible section markers in a job log, which its page folds away. */
const SECTION = /section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?/g
/** A runner's own line prefix when it timestamps logs: time, stream and continuation mark. */
const RUNNER_STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9a-f]{2}[OE]\+? ?/

/** The last lines of a job log, as the job page shows them. */
export function traceTail(raw: string): string {
  // A line redrawn with \r (a progress bar) shows only its last state.
  const lines = raw.split('\n').map((l) => l.replace(RUNNER_STAMP, '').split('\r').filter((part) => part.replace(ANSI, '').trim() !== '').pop() ?? '')
  return tailLog(lines.join('\n').replace(SECTION, ''))
}

/** One note for GitLab: the review's summary, then each blocking finding with its file and line. */
export function reviewNote(review: ForgeReview): string {
  if (review.comments.length === 0) return review.body
  const findings = review.comments.map((c) => {
    const text = c.body.split('\n').filter((l) => !l.startsWith(OUR_MARKER)).join('\n').trim()
    return `- \`${c.path}:${c.line}\` ${text.replace(/\n/g, '\n  ')}`
  })
  return [review.body, '', '#### Blocking findings', '', ...findings].join('\n')
}

export function createGitLab(exec: Exec, now: () => number = Date.now, bin = 'glab'): Forge {
  /** Each project's default branch as GitLab last named it, to read that branch's pipelines. */
  const defaults = new Map<string, string>()
  const hostOf = (repo: RepoRef): string => repo.host ?? 'gitlab.com'
  /** A REST path under the project, its path encoded as GitLab asks (`group%2Fsub%2Fproject`). */
  const rest = (project: string, path: string): string => `projects/${encodeURIComponent(project)}/${path}`

  const glab = (repo: RepoRef, args: string[], options: ExecOptions = {}): Promise<ExecResult> =>
    exec(bin, ['api', '--hostname', hostOf(repo), ...args], { timeoutMs: 30_000, ...options })

  async function graphql(repo: RepoRef, query: string, vars: Record<string, string | undefined>): Promise<{ data: Obj; rate: RateInfo | null }> {
    const args = ['graphql', '-i', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) args.push('-f', `${key}=${value}`)
    const res = await glab(repo, args)
    if (res.code === 127) throw new GitLabError('glab is not installed, or not on the PATH Orca gives plugins', false)
    const { headers, body } = splitInclude(res.stdout)
    let parsed: Obj | null = null
    try {
      parsed = obj(JSON.parse(body))
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed.data === 'object' && parsed.data !== null) return { data: obj(parsed.data), rate: rateFromHeaders(headers) }
    const errors = parsed?.errors
    const text = Array.isArray(errors) && errors.length > 0 ? errors.map((e) => str(obj(e).message) ?? '').join('; ') : `${res.stderr}${body}`.trim()
    throw new GitLabError(`glab api graphql failed: ${text.slice(0, 500)}`, /rate limit|too many requests|\b429\b/i.test(text))
  }

  /** The open merge requests and the default branch, read with `ref` as the default branch's name. */
  async function readOpen(repo: RepoRef, ref: string): Promise<{ list: { viewer: string; prs: PrSummary[]; rate: RateInfo | null; base: BaseBranch | null }; rootRef: string | null }> {
    const path = projectPath(repo)
    const prs: PrSummary[] = []
    let viewer = ''
    let rate: RateInfo | null = null
    let base: BaseBranch | null = null
    let rootRef: string | null = null
    let after: string | undefined
    for (let page = 0; page < 4; page++) {
      const { data, rate: r } = await graphql(repo, LIST_QUERY, { path, ref, after })
      rate = r ?? rate
      viewer = str(obj(data.currentUser).username) ?? viewer
      if (!data.project) throw new GitLabError(`${hostOf(repo)} has no project ${path}, or glab's account there cannot see it`, false)
      const project = obj(data.project)
      const repository = obj(project.repository)
      rootRef = str(repository.rootRef)
      if (page === 0 && rootRef) {
        const head = str(obj(obj(repository.tree).lastCommit).sha)
        const latest = nodes(project.pipelines)[0]
        // The default branch is red when its latest pipeline, for its head, failed. A head with no
        // pipeline yet has no CI result, as on GitHub.
        base = { name: rootRef, sha: head, rollup: latest && head && str(latest.sha) === head ? pipelineRollup(latest.status) : null }
      }
      const conn = obj(project.mergeRequests)
      for (const n of nodes(conn)) {
        const number = Number(str(n.iid))
        const headSha = str(n.diffHeadSha)
        if (!Number.isInteger(number) || headSha === null) continue
        prs.push({
          number,
          headRef: str(n.sourceBranch) ?? '',
          headSha,
          baseRef: str(n.targetBranch) ?? undefined,
          author: str(obj(n.author).username),
          updatedAt: str(n.updatedAt) ?? '',
          rollup: pipelineRollup(obj(n.headPipeline).status)
        })
      }
      const info = obj(conn.pageInfo)
      if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break
      after = info.endCursor
    }
    return { list: { viewer, prs, rate, base }, rootRef }
  }

  async function act(repo: RepoRef, what: string, args: string[]): Promise<Outcome> {
    const res = await glab(repo, args, { timeoutMs: 120_000 })
    return res.code === 0 ? { ok: true } : { ok: false, error: `glab api ${what}: ${(res.stderr || res.stdout).trim().slice(0, 400)}` }
  }

  return {
    kind: 'gitlab',
    // GitLab rebases a merge request on request; it has no API to merge the base into a branch.
    updates: ['rebase'],
    async listOpen(repo) {
      const key = repoKey(repo)
      const known = defaults.get(key)
      let read = await readOpen(repo, known ?? 'HEAD')
      // The default branch was not known yet, or was renamed: read its pipeline by its name.
      if (read.rootRef && read.rootRef !== known) {
        defaults.set(key, read.rootRef)
        read = await readOpen(repo, read.rootRef)
      }
      return { ...read.list, detailMaxAgeMs: QUIET_REFRESH_MS }
    },
    async detail(repo, number) {
      const { data, rate } = await graphql(repo, DETAIL_QUERY, { path: projectPath(repo), iid: String(number) })
      const raw = obj(data.project).mergeRequest
      let pr = raw ? normalizeMr(raw, repoKey(repo), hostOf(repo), str(obj(data.currentUser).username) ?? '', now()) : null
      // GitLab works mergeability out lazily, and GraphQL does not ask it to. Reading the merge
      // request over REST does, for someone who may merge it, and may already have the answer.
      if (pr && pr.state === 'OPEN' && pr.mergeable === 'UNKNOWN') {
        const res = await glab(repo, [rest(projectPath(repo), `merge_requests/${number}`)]).catch(() => null)
        let fresh: Obj = {}
        try {
          fresh = res?.code === 0 ? obj(JSON.parse(res.stdout)) : {}
        } catch {
          fresh = {}
        }
        const m = mergeabilityOf(fresh.detailed_merge_status, fresh.has_conflicts === true)
        if (m.mergeable !== 'UNKNOWN') pr = { ...pr, ...m }
      }
      return { pr, rate }
    },
    // Pinned to the reviewed commit: GitLab refuses the merge when `sha` is no longer the head.
    merge: (repo, pr, sha, method, deleteBranch) =>
      act(repo, 'merge', [
        '-X',
        'PUT',
        rest(projectPath(repo), `merge_requests/${pr.number}/merge`),
        '-f',
        `sha=${sha}`,
        '-F',
        `squash=${method === 'squash'}`,
        '-F',
        `should_remove_source_branch=${deleteBranch}`
      ]),
    // Asynchronous, like gh pr update-branch: GitLab answers at once and rebases in the background.
    updateBranch: (repo, pr) => act(repo, 'rebase', ['-X', 'PUT', rest(projectPath(repo), `merge_requests/${pr.number}/rebase`)]),
    publishReview: (repo, pr, _sha, review) =>
      act(repo, 'notes', ['-X', 'POST', rest(projectPath(repo), `merge_requests/${pr.number}/notes`), '-f', `body=${reviewNote(review)}`]),
    async failedLogs(repo, checks) {
      const logs: Record<string, string> = {}
      for (const { name, jobId, url } of checks.slice(0, 5)) {
        if (jobId === null) continue
        const res = await glab(repo, [rest(jobProject(url) ?? projectPath(repo), `jobs/${jobId}/trace`)], { timeoutMs: 60_000 })
        if (res.code === 0 && res.stdout) logs[name] = traceTail(res.stdout)
      }
      return logs
    }
  }
}
