// Cheaper polling: conditional HEAD requests decide whether the open PRs need reading again.
import { assert, describe, test } from 'orca/testing'
import type { Exec } from './exec.ts'
import { createGitHub, parseHead, QUIET_REFRESH_MS, type PrSummary } from './github.ts'
import { SHA } from './testing/fixtures.ts'

const repo = { owner: 'acme', name: 'app' }
const BASE = 'b'.repeat(40)

/** A fake `gh`: GraphQL answers one open PR; HEAD requests answer 304 while the ETag matches. */
function fakeGh() {
  const etags = new Map<string, string>()
  let graphql = 0
  let probes = 0
  let failProbes = false
  const exec: Exec = async (_bin, args) => {
    if (args[1] === 'graphql') {
      graphql++
      const pr = { number: 12, headRefName: 'feature/login', headRefOid: SHA, baseRefName: 'main', updatedAt: 'u1', author: { login: 'me' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }
      const data = { viewer: { login: 'me' }, rateLimit: { cost: 1, remaining: 4999, resetAt: 'r' }, repository: { defaultBranchRef: { name: 'main', target: { oid: BASE, statusCheckRollup: { state: 'SUCCESS' } } }, pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pr] } } }
      return { code: 0, stdout: JSON.stringify({ data }), stderr: '' }
    }
    probes++
    if (failProbes) return { code: 1, stdout: '', stderr: 'error connecting to api.github.com' }
    const path = args.at(-1)!
    const sent = args.find((a) => a.startsWith('If-None-Match: '))?.slice('If-None-Match: '.length)
    const current = etags.get(path) ?? '"e0"'
    if (sent === current) return { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\nX-Ratelimit-Used: 3\r\n\r\n', stderr: 'gh: HTTP 304\nHTTP/2.0 304 Not Modified\n' }
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: ${current}\r\nX-Ratelimit-Used: 4\r\n\r\n`, stderr: '' }
  }
  return {
    exec,
    change: (path: string, etag: string) => etags.set(path, etag),
    failProbes: (on: boolean) => (failProbes = on),
    counts: () => ({ graphql, probes })
  }
}

const follows = (pr: PrSummary) => pr.headRef === 'feature/login'
const runsPath = `repos/acme/app/commits/${SHA}/check-runs?per_page=100`

describe('polling GitHub cheaply', () => {
  test('HEAD output parses on stdout or stderr, with CRLF and any header case', () => {
    assert.deepEqual(parseHead('HTTP/2.0 200 OK\r\nETag: W/"abc"\r\n\r\nbody', ''), { status: 200, etag: 'W/"abc"' })
    assert.deepEqual(parseHead('', 'gh: HTTP 304\nHTTP/2.0 304 Not Modified\nX-Ratelimit-Used: 1\n'), { status: 304, etag: null })
    assert.equal(parseHead('', 'error connecting'), null)
  })

  test('the open PRs are read again only when GitHub says something changed', async () => {
    let now = 0
    const gh = fakeGh()
    const github = createGitHub(gh.exec, () => now)
    const first = await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 1)
    assert.ok(!first.unchanged)
    // Nothing to compare against yet: the first probes count as a change.
    await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 2)
    // Every probe answers 304 now: no GraphQL, and no rate limit spent.
    const quiet = await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 2)
    assert.equal(quiet.unchanged, true)
    assert.deepEqual(quiet.prs.map((p) => p.number), [12])
    // Pulls, the default branch ref, its two check paths, and the followed PR's two.
    assert.equal(gh.counts().probes, 6 * 2)
    const tag = quiet.prs[0].checksTag
    assert.ok(tag)

    // A check on the PR's head moved: read again, and the PR's checks stamp changes.
    gh.change(runsPath, '"e1"')
    now += 45_000
    const moved = await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 3)
    assert.ok(moved.prs[0].checksTag && moved.prs[0].checksTag !== tag)
    assert.equal((await github.listOpen(repo, { watch: follows })).unchanged, true)

    // Quiet for the whole refresh interval: read anyway.
    now += QUIET_REFRESH_MS
    await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 4)
  })

  test('a probe that cannot tell counts as a change, so nothing is missed', async () => {
    const gh = fakeGh()
    const github = createGitHub(gh.exec, () => 0)
    await github.listOpen(repo, { watch: follows })
    await github.listOpen(repo, { watch: follows })
    gh.failProbes(true)
    await github.listOpen(repo, { watch: follows })
    assert.equal(gh.counts().graphql, 3)
  })

  test('a PR that is not followed has its checks left alone', async () => {
    const gh = fakeGh()
    const github = createGitHub(gh.exec, () => 0)
    await github.listOpen(repo, { watch: () => false })
    await github.listOpen(repo, { watch: () => false })
    const before = gh.counts().graphql
    gh.change(runsPath, '"e9"')
    const list = await github.listOpen(repo, { watch: () => false })
    assert.equal(gh.counts().graphql, before, 'its checks are not probed')
    assert.equal(list.prs[0].checksTag, null)
  })
})
