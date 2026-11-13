// GitHub through the signed-in `gh` CLI. Each tick first asks GitHub whether anything changed,
// with conditional HEAD requests (an unchanged answer, 304, costs no rate limit): the newest PR
// update, the default branch, its checks, and the checks of each PR Matriarch follows. Only when
// one changed (or every few minutes regardless) does it read the open PRs over GraphQL; and the
// full detail of a PR only when its head, checks, base or update time changed (or it went stale).
// It is one of Matriarch's two forges (forge.ts): it also merges, updates branches, posts reviews
// and reads failed job logs, all with `gh`.
import type { Exec } from './exec.ts'
import { repoKey, tailLog, type Forge, type ForgeKind, type ForgeReader, type Outcome, type RepoRef } from './forge.ts'

export { repoKey, type RepoRef }

/** Hidden marker on everything Matriarch posts, so its own threads never count as a human's. */
export const OUR_MARKER = '<!-- matriarch'

export type CheckState = 'success' | 'failure' | 'pending' | 'cancelled' | 'skipped' | 'neutral'
export type CiState = 'passing' | 'failing' | 'pending' | 'cancelled' | 'none'

export interface CheckInfo {
  name: string
  state: CheckState
  url: string | null
  /** A GitHub Actions check run id, which is also its job id (for logs); on GitLab, the job's id. */
  jobId: number | null
}

export interface ThreadInfo {
  /** GraphQL node id of the thread (or `review:<id>` for a review body). */
  id: string
  resolved: boolean
  outdated: boolean
  path: string | null
  line: number | null
  author: string | null
  bot: boolean
  body: string
  url: string | null
  /** Posted by Matriarch itself. */
  ours: boolean
}

export interface PrSummary {
  number: number
  headRef: string
  headSha: string
  /** The branch it merges into. */
  baseRef?: string
  author: string | null
  updatedAt: string
  /** Its CI rollup in GitHub's words (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED), or null with no CI. */
  rollup: string | null
  /**
   * A stamp of its head's checks as GitHub last answered (their ETags), when Matriarch watches
   * them. It changes with any check, even when the overall rollup stays the same.
   */
  checksTag?: string | null
}

export interface PrSnapshot {
  /** Set on GitLab merge requests; absent on GitHub PRs, as in every snapshot stored before GitLab. */
  forge?: ForgeKind
  repo: string
  number: number
  url: string
  title: string
  body: string
  author: string | null
  headRef: string
  headSha: string
  baseRef: string
  draft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /**
   * GitHub's mergeStateStatus: CLEAN, BEHIND, BLOCKED, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN.
   * GitLab's detailed merge status is read into the same words (gitlab.ts, mergeabilityOf).
   */
  mergeState: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  ci: CiState
  checks: CheckInfo[]
  checksTruncated: boolean
  /** Review threads plus formal "changes requested" review bodies. */
  threads: ThreadInfo[]
  threadsTruncated: boolean
  files: string[]
  filesTruncated: boolean
  updatedAt: string
  /** When this detail was read (ms). */
  fetchedAt: number
}

export const LIST_QUERY = `query($owner: String!, $name: String!, $after: String) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { state } } } }
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number headRefName headRefOid baseRefName updatedAt author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
}`

export const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title body state isDraft headRefName headRefOid baseRefName
      mergeable mergeStateStatus reviewDecision updatedAt author { login }
      files(first: 100) { pageInfo { hasNextPage } nodes { path } }
      latestReviews(first: 20) { nodes { id state body url author { login __typename } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state
        contexts(first: 100) { pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl databaseId }
          ... on StatusContext { context state targetUrl } } } } } } }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { id isResolved isOutdated path line
        comments(first: 5) { nodes { url body author { login __typename } } } } }
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

export function checkState(node: Obj): CheckState {
  if (node.__typename === 'StatusContext') {
    switch (node.state) {
      case 'SUCCESS':
        return 'success'
      case 'FAILURE':
      case 'ERROR':
        return 'failure'
      default:
        return 'pending'
    }
  }
  if (node.status !== 'COMPLETED') return 'pending'
  switch (node.conclusion) {
    case 'SUCCESS':
      return 'success'
    case 'NEUTRAL':
      return 'neutral'
    case 'SKIPPED':
      return 'skipped'
    case 'CANCELLED':
    case 'STALE':
      return 'cancelled'
    default:
      // FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
      return 'failure'
  }
}

export function ciStateOf(checks: readonly CheckInfo[]): CiState {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.state === 'failure')) return 'failing'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  if (checks.some((c) => c.state === 'cancelled')) return 'cancelled'
  return 'passing'
}

const isBot = (author: Obj): boolean => author.__typename === 'Bot' || (str(author.login) ?? '').endsWith('[bot]')

export function normalizePr(raw: unknown, repo: string, fetchedAt: number): PrSnapshot | null {
  const pr = obj(raw)
  const number = num(pr.number)
  const headSha = str(pr.headRefOid)
  if (number === null || headSha === null) return null

  const commit = obj(nodes(pr.commits)[0]?.commit)
  const rollup = obj(commit.statusCheckRollup)
  const checks: CheckInfo[] = nodes(rollup.contexts).map((c) => ({
    name: str(c.name) ?? str(c.context) ?? 'check',
    state: checkState(c),
    url: str(c.detailsUrl) ?? str(c.targetUrl),
    jobId: c.__typename === 'CheckRun' ? num(c.databaseId) : null
  }))

  const threads: ThreadInfo[] = nodes(pr.reviewThreads).map((t) => {
    const comments = nodes(t.comments)
    const first = comments[0] ?? {}
    const author = obj(first.author)
    return {
      id: str(t.id) ?? '',
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
      path: str(t.path),
      line: num(t.line),
      author: str(author.login),
      bot: isBot(author),
      body: comments.map((c) => str(c.body) ?? '').join('\n\n---\n\n'),
      url: str(first.url),
      ours: comments.some((c) => (str(c.body) ?? '').includes(OUR_MARKER))
    }
  })
  // A formal "changes requested" review body is feedback too, even without inline threads.
  for (const review of nodes(pr.latestReviews)) {
    if (review.state !== 'CHANGES_REQUESTED') continue
    const author = obj(review.author)
    const body = str(review.body) ?? ''
    threads.push({
      id: `review:${str(review.id) ?? ''}`,
      resolved: false,
      outdated: false,
      path: null,
      line: null,
      author: str(author.login),
      bot: isBot(author),
      body: body || '(changes requested with no comment)',
      url: str(review.url),
      ours: body.includes(OUR_MARKER)
    })
  }

  // GitHub's own rollup is the authority when the check list was cut short.
  const truncated = hasNext(rollup.contexts)
  let ci = ciStateOf(checks)
  if (truncated) {
    const rs = str(rollup.state)
    if (rs === 'FAILURE' || rs === 'ERROR') ci = 'failing'
    else if (rs === 'PENDING' || rs === 'EXPECTED') ci = 'pending'
  }
  const state = pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : 'OPEN'
  const mergeable = pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN'
  const decision = pr.reviewDecision
  return {
    repo,
    number,
    url: str(pr.url) ?? `https://github.com/${repo}/pull/${number}`,
    title: str(pr.title) ?? '',
    body: str(pr.body) ?? '',
    author: str(obj(pr.author).login),
    headRef: str(pr.headRefName) ?? '',
    headSha,
    baseRef: str(pr.baseRefName) ?? '',
    draft: pr.isDraft === true,
    state,
    mergeable,
    mergeState: str(pr.mergeStateStatus) ?? 'UNKNOWN',
    reviewDecision:
      decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED' ? decision : null,
    ci,
    checks,
    checksTruncated: truncated,
    threads,
    threadsTruncated: hasNext(pr.reviewThreads),
    files: nodes(pr.files).map((f) => str(f.path) ?? '').filter(Boolean),
    filesTruncated: hasNext(pr.files),
    updatedAt: str(pr.updatedAt) ?? '',
    fetchedAt
  }
}

/**
 * Feedback a worker should act on: unresolved, not Matriarch's own, and either from a person
 * or a bot comment anchored to a line (a bot summary is not a request).
 */
export function actionableThreads(pr: PrSnapshot): ThreadInfo[] {
  return pr.threads.filter((t) => !t.resolved && !t.ours && (!t.bot || (t.path !== null && t.line !== null)))
}

export interface RateInfo {
  cost: number
  remaining: number
  resetAt: string
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** The default branch and its CI rollup (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED or null). */
export interface BaseBranch {
  name: string
  sha: string | null
  rollup: string | null
}

export interface OpenList {
  viewer: string
  prs: PrSummary[]
  rate: RateInfo | null
  base?: BaseBranch | null
  /** True when GitHub said nothing changed since the last read, so this is that read again. */
  unchanged?: boolean
  /**
   * How long a PR's detail may be reused while its summary looks the same, when the forge cannot
   * tell every change from the list (GitLab). The engine's own limit applies when it is shorter.
   */
  detailMaxAgeMs?: number
}

export interface ListOptions {
  /** The PRs whose checks are worth watching between reads (the ones Matriarch follows). */
  watch?: (pr: PrSummary, viewer: string) => boolean
}

/** Reading GitHub: the open PRs, cheaply, and one PR in full. Every forge reads this way. */
export type GitHub = ForgeReader

/** Even when every check says nothing changed, read the open PRs again this often. */
export const QUIET_REFRESH_MS = 5 * 60_000
/** Conditional requests in flight at once, per repository. */
const PROBE_CONCURRENCY = 4

/** The HTTP status and ETag from `gh api -i` output (headers on stdout, and on stderr for a 304). */
export function parseHead(stdout: string, stderr: string): { status: number; etag: string | null } | null {
  for (const text of [stdout, stderr]) {
    const clean = text.replace(/\r/g, '')
    const status = clean.match(/^HTTP\/[\d.]+\s+(\d{3})/m)
    if (!status) continue
    const head = clean.slice(status.index).split('\n\n')[0]
    return { status: Number(status[1]), etag: head.match(/^etag:\s*(.+)$/im)?.[1].trim() ?? null }
  }
  return null
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(lanes)
  return out
}

const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/')
const checkPaths = (repo: RepoRef, sha: string): string[] => [
  `repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs?per_page=100`,
  `repos/${repo.owner}/${repo.name}/commits/${sha}/status`
]

function rateOf(data: Obj): RateInfo | null {
  const r = obj(data.rateLimit)
  const remaining = num(r.remaining)
  return remaining === null ? null : { cost: num(r.cost) ?? 0, remaining, resetAt: str(r.resetAt) ?? '' }
}

export function createGitHub(exec: Exec, now: () => number = Date.now, bin = 'gh', options: { quietRefreshMs?: number } = {}): Forge {
  const quietRefreshMs = options.quietRefreshMs ?? QUIET_REFRESH_MS
  /** Per repository: the last full read, and the ETag GitHub last gave for each watched path. */
  const watches = new Map<string, { list: OpenList; at: number; etags: Map<string, string> }>()

  /** Asks GitHub whether a path changed since `etag`; null when it could not tell. */
  async function probe(path: string, etag: string | undefined): Promise<{ status: number; etag: string | null } | null> {
    const args = ['api', '-X', 'HEAD', '-i', '-H', 'Accept: application/vnd.github+json']
    if (etag) args.push('-H', `If-None-Match: ${etag}`)
    args.push(path)
    const res = await exec(bin, args, { timeoutMs: 20_000 }).catch(() => null)
    return res ? parseHead(res.stdout, res.stderr) : null
  }

  /** The paths whose change means the last read is out of date. */
  function watchedPaths(repo: RepoRef, list: OpenList, watch: ListOptions['watch']): string[] {
    const paths = [`repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&per_page=1`]
    if (list.base?.name) {
      paths.push(`repos/${repo.owner}/${repo.name}/git/ref/heads/${enc(list.base.name)}`)
      if (list.base.sha) paths.push(...checkPaths(repo, list.base.sha))
    }
    for (const pr of list.prs) if (watch?.(pr, list.viewer)) paths.push(...checkPaths(repo, pr.headSha))
    return paths
  }

  /** Probes every path, keeping the new ETags; true when any changed or could not be told. */
  async function anyChanged(paths: readonly string[], etags: Map<string, string>): Promise<boolean> {
    const results = await mapLimit(paths, PROBE_CONCURRENCY, async (path) => {
      const known = etags.get(path)
      const r = await probe(path, known)
      if (r?.status === 304) return false
      if (r?.status === 200 && r.etag) {
        etags.set(path, r.etag)
        return r.etag !== known
      }
      etags.delete(path)
      return true
    })
    return results.some(Boolean)
  }

  const stamp = (repo: RepoRef, sha: string, etags: Map<string, string>): string | null => {
    const tags = checkPaths(repo, sha).map((p) => etags.get(p))
    return tags.every((t) => t === undefined) ? null : tags.map((t) => t ?? '').join('|')
  }

  async function graphql(query: string, vars: Record<string, string | number | undefined>): Promise<Obj> {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) continue
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    const res = await exec(bin, args, { timeoutMs: 30_000 })
    if (res.code !== 0) {
      const text = `${res.stderr}${res.stdout}`.trim()
      throw new GitHubError(`gh api graphql failed: ${text.slice(0, 500)}`, /rate limit|secondary rate|abuse/i.test(text))
    }
    let parsed: Obj
    try {
      parsed = obj(JSON.parse(res.stdout))
    } catch {
      throw new GitHubError('gh api graphql returned non-JSON output', false)
    }
    const errors = parsed.errors
    if (Array.isArray(errors) && errors.length > 0 && parsed.data === undefined) {
      const message = errors.map((e) => str(obj(e).message) ?? '').join('; ')
      throw new GitHubError(`GitHub GraphQL error: ${message}`, /rate limit/i.test(message))
    }
    return obj(parsed.data)
  }

  async function readOpen(repo: RepoRef): Promise<OpenList> {
      const prs: PrSummary[] = []
      let viewer = ''
      let rate: RateInfo | null = null
      let base: BaseBranch | null = null
      let after: string | undefined
      for (let page = 0; page < 4; page++) {
        const data = await graphql(LIST_QUERY, { owner: repo.owner, name: repo.name, after })
        viewer = str(obj(data.viewer).login) ?? viewer
        rate = rateOf(data) ?? rate
        const def = obj(obj(data.repository).defaultBranchRef)
        if (!base && str(def.name)) {
          const target = obj(def.target)
          base = { name: str(def.name)!, sha: str(target.oid), rollup: str(obj(target.statusCheckRollup).state) }
        }
        const conn = obj(obj(data.repository).pullRequests)
        for (const n of nodes(conn)) {
          const number = num(n.number)
          const headSha = str(n.headRefOid)
          if (number === null || headSha === null) continue
          prs.push({
            number,
            headRef: str(n.headRefName) ?? '',
            headSha,
            baseRef: str(n.baseRefName) ?? undefined,
            author: str(obj(n.author).login),
            updatedAt: str(n.updatedAt) ?? '',
            rollup: str(obj(obj(nodes(n.commits)[0]?.commit).statusCheckRollup).state)
          })
        }
        const info = obj(conn.pageInfo)
        if (info.hasNextPage !== true || typeof info.endCursor !== 'string') break
        after = info.endCursor
      }
      return { viewer, prs, rate, base }
  }

  const repoArg = (r: RepoRef) => `${r.owner}/${r.name}`

  /** Runs one gh command for an action; a failure answers what gh said. */
  async function run(args: string[]): Promise<Outcome> {
    const res = await exec(bin, args, { timeoutMs: 120_000 })
    return res.code === 0 ? { ok: true } : { ok: false, error: `${bin} ${args.slice(0, 2).join(' ')}: ${(res.stderr || res.stdout).trim().slice(0, 400)}` }
  }

  return {
    kind: 'github',
    updates: ['rebase', 'merge'],
    async listOpen(repo, options = {}) {
      const key = repoKey(repo)
      const seen = watches.get(key)
      // ETags are taken before the read, so a change during the read shows on the next probe.
      if (seen) {
        const changed = await anyChanged(watchedPaths(repo, seen.list, options.watch), seen.etags)
        if (!changed && now() - seen.at < quietRefreshMs) {
          return { ...seen.list, prs: seen.list.prs.map((p) => ({ ...p, checksTag: stamp(repo, p.headSha, seen.etags) })), unchanged: true }
        }
      }
      const list = await readOpen(repo)
      const etags = seen?.etags ?? new Map<string, string>()
      // A path no longer watched (a merged PR's head) is forgotten.
      const live = new Set(watchedPaths(repo, list, options.watch))
      for (const path of [...etags.keys()]) if (!live.has(path)) etags.delete(path)
      watches.set(key, { list, at: now(), etags })
      return { ...list, prs: list.prs.map((p) => ({ ...p, checksTag: stamp(repo, p.headSha, etags) })) }
    },
    async detail(repo, number) {
      const data = await graphql(DETAIL_QUERY, { owner: repo.owner, name: repo.name, number })
      return { pr: normalizePr(obj(data.repository).pullRequest, repoKey(repo), now()), rate: rateOf(data) }
    },
    updateBranch: (repo, pr, method) => run(['pr', 'update-branch', String(pr.number), '--repo', repoArg(repo), ...(method === 'rebase' ? ['--rebase'] : [])]),
    merge: (repo, pr, sha, method, deleteBranch) =>
      run([
        'pr',
        'merge',
        String(pr.number),
        '--repo',
        repoArg(repo),
        `--${method}`,
        '--match-head-commit',
        sha,
        ...(deleteBranch ? ['--delete-branch'] : [])
      ]),
    async failedLogs(repo, checks) {
      const logs: Record<string, string> = {}
      for (const { name, jobId } of checks.slice(0, 5)) {
        if (jobId === null) continue
        const res = await exec(bin, ['api', `repos/${repoArg(repo)}/actions/jobs/${jobId}/logs`], { timeoutMs: 60_000 })
        if (res.code === 0 && res.stdout) logs[name] = tailLog(res.stdout)
      }
      return logs
    },
    async publishReview(repo, pr, sha, review) {
      const post = (comments: typeof review.comments) =>
        exec(bin, ['api', `repos/${repoArg(repo)}/pulls/${pr.number}/reviews`, '-X', 'POST', '--input', '-'], {
          input: JSON.stringify({ commit_id: sha, event: 'COMMENT', body: review.body, comments: comments.map((c) => ({ ...c, side: 'RIGHT' })) }),
          timeoutMs: 60_000
        })
      let res = await post(review.comments)
      // A finding on a line outside the diff makes GitHub refuse inline comments: keep the summary.
      if (res.code !== 0 && review.comments.length > 0 && /422|Unprocessable|line/i.test(res.stderr + res.stdout)) res = await post([])
      return res.code === 0 ? { ok: true } : { ok: false, error: `gh api reviews: ${(res.stderr || res.stdout).trim().slice(0, 300)}` }
    }
  }
}

/** `https://github.com/acme/app.git`, `git@github.com:acme/app.git` and `ssh://...` forms. */
export function parseGitHubRemote(url: string): RepoRef | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], name: m[2] } : null
}
