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
import { obj, type Obj } from './values.ts'
import type { Exec, ExecOptions, ExecResult } from './exec.ts'
import { ISSUE_PAGES, issueText, projectPath, repoKey, tailLog, type Forge, type ForgeReview, type IssueInfo, type LabelCheck, type Outcome, type RepoRef, type FileMoves } from './forge.ts'
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
      nodes { iid sourceBranch targetBranch sourceProjectId targetProjectId diffHeadSha updatedAt author { username } headPipeline { status } }
    }
  }
}`

export const DETAIL_QUERY = `query($path: ID!, $iid: String!) {
  currentUser { username }
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      iid webUrl title description state draft sourceBranch targetBranch sourceProjectId targetProjectId diffHeadSha updatedAt
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

/** A string field, kept even when empty (a forge's empty title or body is still one), or null. */
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

/** A merge request from a fork: its source project is not the project it merges into. */
const fromFork = (mr: Obj): boolean => num(mr.sourceProjectId) !== null && num(mr.targetProjectId) !== null && mr.sourceProjectId !== mr.targetProjectId

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
    ...(fromFork(mr) ? { crossRepo: true } : {}),
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
    // No count means no way to tell the list is whole: it is taken as cut short.
    filesTruncated: fileCount === null || fileCount > files.length,
    // GitLab's diff stats name each file's path, not whether it was renamed: unknown.
    renamed: null,
    updatedAt: str(mr.updatedAt) ?? '',
    fetchedAt
  }
}

/** GitLab's Reporter role: the lowest that may add labels to issues. */
const REPORTER = 20
/**
 * The usernames GitLab gives bot users: a project or group access token's
 * (`project_<id>_bot_<hex>`, `group_<id>_bot_<hex>`), and its own bots (support-bot, alert-bot, ...).
 */
export const GITLAB_BOT_USERNAME = /^(?:project|group)_\d+_bot(?:_\w+)?$|-bot$/i

export const ISSUE_EDIT_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { issue(iid: $iid) { lastEditedAt } }
}`

/** One page of GitLab's REST issue list: `iid` is the number people see, `description` its text. */
export function parseIssues(stdout: string): { issues: IssueInfo[]; rows: number } {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new GitLabError('glab api issues returned non-JSON output', false)
  }
  const rows = Array.isArray(raw) ? raw.map(obj) : []
  const issues: IssueInfo[] = []
  for (const item of rows) {
    const number = num(item.iid)
    const url = str(item.web_url)
    if (number === null || url === null) continue
    issues.push({ number, ...issueText(str(item.title) ?? '', str(item.description) ?? ''), url, author: str(obj(item.author).username), updatedAt: str(item.updated_at) ?? '' })
  }
  return { issues, rows: rows.length }
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

/** Pages of 100 files read for a merge request's moves: more than this, and it cannot say. */
const MAX_DIFF_PAGES = 30
/** Pages of 100 label events read for an issue: its newest addition of the label is among them. */
const LABEL_EVENT_PAGES = 5
const RATE_LIMITED = /rate limit|too many requests|\b429\b/i
const NOT_FOUND = /\b404\b|Not Found/i

/** JSON, or undefined when the text is not JSON: GitLab's answer is never trusted to parse. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** What one REST read answered: its text (and headers, when asked for), or that GitLab has no such thing. */
type RestRead = { missing: true } | { missing: false; text: string; headers: Record<string, string> }

export function createGitLab(exec: Exec, now: () => number = Date.now, bin = 'glab'): Forge {
  /** Each project's default branch as GitLab last named it, to read that branch's pipelines. */
  const defaults = new Map<string, string>()
  const hostOf = (repo: RepoRef): string => repo.host ?? 'gitlab.com'
  /** A REST path under the project, its path encoded as GitLab asks (`group%2Fsub%2Fproject`). */
  const projectApi = (project: string, path: string): string => `projects/${encodeURIComponent(project)}/${path}`

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
  async function readOpen(repo: RepoRef, ref: string): Promise<{ list: { viewer: string; prs: PrSummary[]; rate: RateInfo | null; base: BaseBranch | null; truncated?: boolean }; rootRef: string | null }> {
    const path = projectPath(repo)
    const prs: PrSummary[] = []
    let viewer = ''
    let rate: RateInfo | null = null
    let base: BaseBranch | null = null
    let rootRef: string | null = null
    let after: string | undefined
    let truncated = false
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
          rollup: pipelineRollup(obj(n.headPipeline).status),
          ...(fromFork(n) ? { crossRepo: true } : {})
        })
      }
      const info = obj(conn.pageInfo)
      truncated = info.hasNextPage === true
      if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break
      after = info.endCursor
    }
    return { list: { viewer, prs, rate, base, ...(truncated ? { truncated } : {}) }, rootRef }
  }

  /** A failed glab call as an error with GitLab's words, saying whether it was turned away for its rate. */
  const failure = (what: string, res: ExecResult): GitLabError => {
    const text = `${res.stderr}${res.stdout}`.trim()
    return new GitLabError(`glab api ${what}: ${text.slice(0, 300)}`, RATE_LIMITED.test(text))
  }

  /**
   * Every REST read goes through here: its text, `{ missing: true }` when GitLab answered 404, or
   * a GitLabError with GitLab's words otherwise. With `include` (`glab api -i`), also its headers,
   * to page by X-Next-Page; where glab prints no status line, its exit code and words decide.
   */
  async function restRead(repo: RepoRef, what: string, path: string, options: { include?: boolean; timeoutMs?: number } = {}): Promise<RestRead> {
    const res = await glab(repo, [...(options.include ? ['-i'] : []), path], { timeoutMs: options.timeoutMs ?? 30_000 })
    if (res.code === 127) throw new GitLabError('glab is not installed, or not on the PATH Orca gives plugins', false)
    if (options.include) {
      const { status, headers, body } = splitInclude(res.stdout)
      if (status === 404) return { missing: true }
      if (status !== null) {
        if (status >= 200 && status < 300) return { missing: false, text: body, headers }
        throw failure(what, res)
      }
    }
    if (res.code === 0) return { missing: false, text: res.stdout, headers: {} }
    if (NOT_FOUND.test(`${res.stderr}${res.stdout}`)) return { missing: true }
    throw failure(what, res)
  }

  /** A read that may fail without harm: its JSON, or undefined when it failed, is missing or is not JSON. */
  const readJson = async (repo: RepoRef, what: string, path: string): Promise<unknown> => {
    const r = await restRead(repo, what, path).catch(() => null)
    return r && !r.missing ? parseJson(r.text) : undefined
  }

  /** Old and new paths from GitLab's per-file diff entries, or null when one is malformed. */
  function movesOf(entries: readonly unknown[]): FileMoves | null {
    const renamed: string[] = []
    const paths = new Set<string>()
    for (const e of entries) {
      const o = obj(e)
      const from = str(o.old_path)
      const to = str(o.new_path)
      if (!from || !to || typeof o.renamed_file !== 'boolean') return null
      paths.add(from)
      paths.add(to)
      if (o.renamed_file) renamed.push(to)
    }
    return { renamed, paths: [...paths] }
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
        const fresh = obj(await readJson(repo, 'merge request', projectApi(projectPath(repo), `merge_requests/${number}`)))
        const m = mergeabilityOf(fresh.detailed_merge_status, fresh.has_conflicts === true)
        if (m.mergeable !== 'UNKNOWN') pr = { ...pr, ...m }
      }
      return { pr, rate }
    },
    // Each file's old and new path, from the merge request's diffs (GitLab 15.7 and later), else
    // from its changes on an older GitLab. Anything short of the whole list answers null.
    async fileMoves(repo, number) {
      const base = projectApi(projectPath(repo), `merge_requests/${number}`)
      const entries: unknown[] = []
      try {
        for (let page = 1; page <= MAX_DIFF_PAGES; page++) {
          const res = await restRead(repo, 'diffs', `${base}/diffs?per_page=100&page=${page}`, { include: true, timeoutMs: 60_000 })
          if (res.missing) {
            if (page > 1) return null
            // No diffs endpoint here: the older changes endpoint lists every file, unless it overflowed.
            const old = await restRead(repo, 'changes', `${base}/changes`, { include: true, timeoutMs: 60_000 })
            const body = obj(old.missing ? undefined : parseJson(old.text))
            if (old.missing || body.overflow === true || !Array.isArray(body.changes)) return null
            return movesOf(body.changes)
          }
          const list = parseJson(res.text)
          if (!Array.isArray(list)) return null
          entries.push(...list)
          if (!res.headers['x-next-page']) return movesOf(entries)
        }
      } catch {
        // A read that failed says nothing of the moves: the merge request gets the full crew.
        return null
      }
      // More files than Matriarch reads one by one.
      return null
    },
    // Pinned to the reviewed commit: GitLab refuses the merge when `sha` is no longer the head.
    merge: (repo, pr, sha, method, deleteBranch) =>
      act(repo, 'merge', [
        '-X',
        'PUT',
        projectApi(projectPath(repo), `merge_requests/${pr.number}/merge`),
        '-f',
        `sha=${sha}`,
        '-F',
        `squash=${method === 'squash'}`,
        '-F',
        `should_remove_source_branch=${deleteBranch}`
      ]),
    // Asynchronous, like gh pr update-branch: GitLab answers at once and rebases in the background.
    updateBranch: (repo, pr) => act(repo, 'rebase', ['-X', 'PUT', projectApi(projectPath(repo), `merge_requests/${pr.number}/rebase`)]),
    retarget: (repo, pr, base) => act(repo, 'update', ['-X', 'PUT', projectApi(projectPath(repo), `merge_requests/${pr.number}`), '-f', `target_branch=${base}`]),
    // Each job on its own, in the project it ran in: a fork's pipeline runs in the fork.
    async rerun(repo, checks) {
      for (const check of checks) {
        if (check.jobId === null) return { ok: false, error: `${check.name} is not a job GitLab can retry` }
        const done = await act(repo, 'retry', ['-X', 'POST', projectApi(jobProject(check.url) ?? projectPath(repo), `jobs/${check.jobId}/retry`)])
        if (!done.ok) return done
      }
      return { ok: true }
    },
    async isAncestor(repo, sha, ref) {
      // The merge base of a commit and a branch is that commit exactly when the branch has it.
      const id = str(obj(await readJson(repo, 'merge base', projectApi(projectPath(repo), `repository/merge_base?refs[]=${encodeURIComponent(sha)}&refs[]=${encodeURIComponent(ref)}`))).id)
      return id === null ? null : id === sha
    },
    async failureDetails(repo, checks) {
      const details: Record<string, string> = {}
      const logs: Record<string, string> = {}
      for (const { name, jobId, url } of checks.slice(0, 5)) {
        if (jobId === null) continue
        const project = jobProject(url) ?? projectPath(repo)
        // GitLab says itself when a job failed around its script (a runner or the scheduler failing).
        const [job, trace] = await Promise.all([
          readJson(repo, 'job', projectApi(project, `jobs/${jobId}`)),
          restRead(repo, 'trace', projectApi(project, `jobs/${jobId}/trace`), { timeoutMs: 60_000 }).catch(() => null)
        ])
        const reason = str(obj(job).failure_reason)
        if (trace && !trace.missing && trace.text) logs[name] = traceTail(trace.text)
        details[name] = [reason ? `failure_reason: ${reason}` : '', logs[name] ?? ''].filter(Boolean).join('\n')
      }
      return { details, logs }
    },
    publishReview: (repo, pr, _sha, review) =>
      act(repo, 'notes', ['-X', 'POST', projectApi(projectPath(repo), `merge_requests/${pr.number}/notes`), '-f', `body=${reviewNote(review)}`]),
    async labeledIssues(repo, label) {
      const issues: IssueInfo[] = []
      for (let page = 1; page <= ISSUE_PAGES; page++) {
        const res = await restRead(repo, 'issues', projectApi(projectPath(repo), `issues?state=opened&labels=${encodeURIComponent(label)}&order_by=created_at&sort=asc&per_page=100&page=${page}`))
        if (res.missing) throw new GitLabError(`${hostOf(repo)} has no project ${projectPath(repo)}, or glab's account there cannot see its issues`, false)
        const read = parseIssues(res.text)
        issues.push(...read.issues)
        if (read.rows < 100) return { issues, truncated: false }
      }
      return { issues, truncated: true }
    },
    // GitLab keeps label events with who made them; the member's access counts groups' too
    // (members/all); lastEditedAt moves with an edit of the title or the description.
    async labelCheck(repo, issue, label): Promise<LabelCheck> {
      const events: Obj[] = []
      for (let page = 1; page <= LABEL_EVENT_PAGES; page++) {
        const res = await restRead(repo, 'label events', projectApi(projectPath(repo), `issues/${issue.number}/resource_label_events?per_page=100&page=${page}`))
        const raw = res.missing ? undefined : parseJson(res.text)
        if (!Array.isArray(raw)) throw new GitLabError(`glab api label events: GitLab gave no list for #${issue.number}`, false)
        const rows = raw.map(obj)
        events.push(...rows)
        if (rows.length < 100) break
      }
      const want = label.toLowerCase()
      const added = events.filter((e) => e.action === 'add' && lower(obj(e.label).name) === want).at(-1)
      const at = added ? str(added.created_at) : null
      const user = obj(added?.user)
      const by = str(user.username)
      const id = num(user.id)
      if (!added || !at || !by || id === null) return { ok: false, why: `Matriarch cannot tell who added ${label}` }
      const { data } = await graphql(repo, ISSUE_EDIT_QUERY, { path: projectPath(repo), iid: String(issue.number) })
      const edited = str(obj(obj(data.project).issue).lastEditedAt)
      if (edited && Date.parse(edited) > Date.parse(at)) return { ok: false, why: `it was edited after ${by} added ${label}`, at }
      const member = await restRead(repo, 'members', projectApi(projectPath(repo), `members/all/${id}`))
      if (member.missing) return { ok: false, why: `${label} was added by ${by}, who is not a member of the project`, at }
      const level = num(obj(parseJson(member.text)).access_level)
      if (level === null || level < REPORTER) return { ok: false, why: `${label} was added by ${by}, whose role in the project is below Reporter`, at }
      // A bot user (an access token, or one of GitLab's own) can hold Reporter, but its label is
      // no person's go-ahead, as an app's is not on GitHub. Its user record says so; where that
      // record is hidden (a private profile on a locked-down instance), its username does.
      if (GITLAB_BOT_USERNAME.test(by)) return { ok: false, why: `${label} was added by ${by}, a bot, not a person with Reporter access`, at }
      const who = await restRead(repo, 'users', `users/${id}`)
      if (!who.missing && obj(parseJson(who.text)).bot === true) return { ok: false, why: `${label} was added by ${by}, a bot, not a person with Reporter access`, at }
      return { ok: true, by, at }
    },
    commentIssue: (repo, number, body) => act(repo, 'issue notes', ['-X', 'POST', projectApi(projectPath(repo), `issues/${number}/notes`), '-f', `body=${body}`]),
    async failedLogs(repo, checks) {
      const logs: Record<string, string> = {}
      for (const { name, jobId, url } of checks.slice(0, 5)) {
        if (jobId === null) continue
        const res = await restRead(repo, 'trace', projectApi(jobProject(url) ?? projectPath(repo), `jobs/${jobId}/trace`), { timeoutMs: 60_000 }).catch(() => null)
        if (res && !res.missing && res.text) logs[name] = traceTail(res.text)
      }
      return logs
    }
  }
}
