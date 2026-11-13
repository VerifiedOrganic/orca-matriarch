// GitLab: remotes and detection, reading merge requests into PrSnapshot, the glab calls behind
// each action, an engine tick over a GitLab project, and the commands agents are given. A fake
// glab answers in the shapes gitlab.com gives (src/testing/gitlab.ts); nothing reaches a network.
import { assert, describe, test } from 'orca/testing'
import { forgeSettingOf, validateConfig } from './config.ts'
import { tick, type EngineDeps, type Workspace } from './engine.ts'
import { createExecutor, type Executor } from './executor.ts'
import { forgeTerms, gitlabRef, parseRemote, repoKey, type ForgeReader } from './forge.ts'
import { actionableThreads, type PrSnapshot } from './github.ts'
import { createGitLab, GitLabError, jobProject, jobState, mergeabilityOf, normalizeMr, pipelineRollup, reviewNote, splitInclude, traceTail } from './gitlab.ts'
import { ledgerKey } from './ledger.ts'
import { commentsMessage } from './messages.ts'
import { createOrcaCli } from './orca-cli.ts'
import { DRAFT_NUDGE_MS, plan, type Action } from './plan.ts'
import { supervisorBrief } from './supervisor.ts'
import { config, input, owner, pr, SHA, thread } from './testing/fixtures.ts'
import { BASE_SHA, detailData, fakeGlab, field, HOST, included, KEY, listData, PATH, REPO } from './testing/gitlab.ts'
import { createRepoResolver, detectForge } from './worker.ts'

describe('GitLab remotes', () => {
  test('https, scp-like and ssh:// forms, with nested groups, ports, .git and a trailing slash', () => {
    assert.deepEqual(parseRemote('https://gitlab.com/group/sub/project.git'), { host: 'gitlab.com', path: 'group/sub/project' })
    assert.deepEqual(parseRemote('https://oauth2@gitlab.example.com:8443/group/sub/deeper/app/'), { host: 'gitlab.example.com:8443', path: 'group/sub/deeper/app' })
    assert.deepEqual(parseRemote('git@gitlab.example.com:group/sub/app.git'), { host: 'gitlab.example.com', path: 'group/sub/app' })
    // An ssh port is not where the API is served, so it is not part of the host.
    assert.deepEqual(parseRemote('ssh://git@gitlab.example.com:2222/group/app.git'), { host: 'gitlab.example.com', path: 'group/app' })
    assert.deepEqual(parseRemote('ssh://git@GitLab.Example.com/group/sub/app.git/'), { host: 'gitlab.example.com', path: 'group/sub/app' })
    assert.equal(parseRemote('git@gitlab.example.com:app.git'), null, 'a project path has a namespace')
    assert.equal(parseRemote('/srv/git/app.git'), null)
    assert.equal(parseRemote('not a remote'), null)
  })

  test('a GitLab key carries the host and never looks like a GitHub key', () => {
    assert.deepEqual(gitlabRef(HOST, PATH), { kind: 'gitlab', host: HOST, owner: 'group/sub', name: 'app' })
    assert.equal(repoKey(REPO), 'gitlab.example.com/group/sub/app')
    assert.equal(repoKey(gitlabRef('gitlab.com', 'acme/app')), 'gitlab.com/acme/app')
    assert.equal(repoKey({ owner: 'acme', name: 'app' }), 'acme/app', 'GitHub keys are unchanged')
  })

  test('github.com is GitHub; another host is GitLab by the project setting or a glab sign-in', async () => {
    const asked: string[] = []
    const signedIn = async (host: string) => (asked.push(host), host === HOST)
    assert.deepEqual(await detectForge('git@github.com:acme/app.git', null, signedIn), { ref: { owner: 'acme', name: 'app' } })
    assert.deepEqual(await detectForge(`git@${HOST}:${PATH}.git`, null, signedIn), { ref: REPO })
    assert.deepEqual(asked, [HOST], 'GitHub never asks glab')
    assert.deepEqual(await detectForge('git@github.com:acme/app.git', { kind: 'gitlab' }, signedIn), { ref: { owner: 'acme', name: 'app' } }, 'github.com is no GitLab')
    // An ssh alias hides the real host: the setting names it, and glab is not asked.
    asked.length = 0
    assert.deepEqual(await detectForge('git@work:group/app.git', { kind: 'gitlab', host: 'gitlab.corp.example' }, signedIn), { ref: gitlabRef('gitlab.corp.example', 'group/app') })
    assert.deepEqual(await detectForge('https://gitlab.com/group/app.git', { kind: 'gitlab' }, signedIn), { ref: gitlabRef('gitlab.com', 'group/app') })
    assert.deepEqual(asked, [])
    const neither = await detectForge('git@code.example.org:team/app.git', null, signedIn)
    assert.ok('problem' in neither && neither.problem.includes('neither GitHub nor a GitLab host glab is signed in to'))
    assert.ok('problem' in neither && neither.problem.includes('glab auth login --hostname code.example.org'))
    const wrong = await detectForge(`git@${HOST}:${PATH}.git`, { kind: 'github' }, signedIn)
    assert.ok('problem' in wrong && wrong.problem.includes('only on github.com'))
  })

  test('the resolver asks glab once per host, and reads the forge from the project settings', async () => {
    const calls: string[][] = []
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args])
      if (file === 'glab') return { code: args.includes(HOST) ? 0 : 1, stdout: 'not kept', stderr: '' }
      if (args.includes('--git-common-dir')) return { code: 0, stdout: `${args[1].startsWith('/alias') ? '/alias' : '/r'}/.git\n`, stderr: '' }
      if (args.includes('remote.origin.url')) return { code: 0, stdout: args[1].startsWith('/alias') ? 'git@work:team/app.git\n' : `git@${HOST}:${PATH}.git\n`, stderr: '' }
      return { code: 1, stdout: '', stderr: '' }
    }
    const files: Record<string, string> = { '/alias/.orca/matriarch.off.json': JSON.stringify({ forge: { kind: 'gitlab', host: 'gitlab.corp.example' } }) }
    const resolve = createRepoResolver(exec, async (p) => files[p] ?? null)
    assert.deepEqual(await resolve('/r'), { ref: REPO, key: KEY, root: '/r' })
    assert.deepEqual((await resolve('/r/wt/login'))?.key, KEY)
    assert.deepEqual(calls.filter((c) => c[0] === 'glab'), [['glab', 'auth', 'status', '--hostname', HOST]])
    assert.equal((await resolve('/alias'))?.key, 'gitlab.corp.example/team/app', 'a project turned off keeps its forge setting')
    assert.equal(await resolve.problem('/r'), null)
  })

  test('the forge setting is checked like every other', () => {
    assert.deepEqual(validateConfig({ forge: { kind: 'gitlab', host: 'GitLab.Example.com:8443' } }).config.forge, { kind: 'gitlab', host: 'gitlab.example.com:8443' })
    assert.equal(validateConfig({}).config.forge, undefined, 'absent unless set')
    assert.ok(validateConfig({ forge: { kind: 'bitbucket' } }).errors[0].startsWith('forge.kind'))
    assert.ok(validateConfig({ forge: { kind: 'gitlab', host: 'https://gitlab.example.com/x' } }).errors[0].startsWith('forge.host'))
    assert.ok(validateConfig({ forge: { kind: 'github', host: 'github.example.com' } }).errors[0].includes('only on github.com'))
    assert.deepEqual(forgeSettingOf({ forge: { kind: 'gitlab' } }), { kind: 'gitlab' })
    assert.equal(forgeSettingOf({ forge: { kind: 'nope' } }), null)
  })
})

describe('reading GitLab merge requests', () => {
  test('mergeability maps onto the states the planner reads', () => {
    const m = (s: string, conflicts = false) => Object.values(mergeabilityOf(s, conflicts)).join(' ')
    assert.equal(m('mergeable'), 'MERGEABLE CLEAN')
    assert.equal(m('CONFLICT', true), 'CONFLICTING DIRTY', 'GraphQL spells it in upper case')
    assert.equal(m('need_rebase'), 'MERGEABLE BEHIND')
    assert.equal(m('checking'), 'UNKNOWN UNKNOWN')
    assert.equal(m('unchecked'), 'UNKNOWN UNKNOWN')
    assert.equal(m('draft_status'), 'MERGEABLE DRAFT')
    for (const s of ['not_approved', 'discussions_not_resolved', 'blocked_status', 'requested_changes', 'external_status_checks']) assert.equal(m(s), 'MERGEABLE BLOCKED', s)
    assert.equal(m('ci_still_running'), 'MERGEABLE UNKNOWN', 'its pipeline decides; the planner follows the jobs')
  })

  test('jobs are checks: an allowed failure is a warning, a manual job nobody must run is skipped', () => {
    assert.equal(jobState('FAILED', false), 'failure')
    assert.equal(jobState('FAILED', true), 'neutral')
    assert.equal(jobState('MANUAL', true), 'skipped')
    assert.equal(jobState('MANUAL', false), 'pending')
    assert.equal(jobState('CANCELED', false), 'cancelled')
    assert.equal(jobState('WAITING_FOR_RESOURCE', false), 'pending')
    assert.deepEqual(['SUCCESS', 'FAILED', 'RUNNING', 'CANCELED', null].map(pipelineRollup), ['SUCCESS', 'FAILURE', 'PENDING', 'CANCELLED', null])
  })

  test('a merge request reads into the same snapshot as a PR', () => {
    const p = normalizeMr(detailData().project.mergeRequest, KEY, HOST, 'me', 5)!
    assert.equal(p.forge, 'gitlab')
    assert.deepEqual([p.repo, p.number, p.headRef, p.baseRef, p.headSha, p.state, p.draft], [KEY, 12, 'feature/login', 'main', SHA, 'OPEN', false])
    assert.equal(p.url, `https://${HOST}/${PATH}/-/merge_requests/12`)
    assert.deepEqual(p.checks.map((c) => [c.name, c.state, c.jobId]), [
      ['test coverage report', 'success', 18010270200],
      ['dependency-scanning', 'failure', 16152393446],
      ['gitlab-advanced-sast', 'neutral', 16152393447],
      ['deploy review app', 'skipped', 16152393448],
      ['downstream', 'success', null]
    ])
    assert.equal(p.ci, 'failing')
    assert.equal(p.checks[1].url, `https://${HOST}/forks/me/app/-/jobs/16152393446`)
    assert.deepEqual([p.mergeable, p.mergeState, p.reviewDecision], ['MERGEABLE', 'BLOCKED', 'CHANGES_REQUESTED'])
    assert.deepEqual(p.files, ['network/gitlab.go', 'go.sum'])
    assert.equal(p.filesTruncated, false)
    // Resolvable threads only; the viewer's own and Matriarch's are ours; a reviewer's request is feedback.
    assert.equal(p.threads.length, 6)
    const diff = p.threads[0]
    assert.deepEqual([diff.path, diff.line, diff.author, diff.bot, diff.resolved, diff.ours], ['network/gitlab.go', 1256, 'lachie', false, false, false])
    assert.deepEqual(actionableThreads(p).map((t) => t.id), ['gid://gitlab/Discussion/5382929f9ff6ff6bcb54571efd4b1b2112da926d', 'review:lachie'])
  })

  test('cut-short lists say so, and the pipeline status decides when its jobs were cut', () => {
    const raw = detailData({
      diffStatsSummary: { fileCount: 3 },
      discussions: { pageInfo: { hasNextPage: true }, nodes: [] },
      headPipeline: { status: 'FAILED', jobs: { pageInfo: { hasNextPage: true }, nodes: [{ id: 'gid://gitlab/Ci::Build/1', name: 'a', status: 'SUCCESS', allowFailure: false, webPath: '/g/p/-/jobs/1' }] } }
    }).project.mergeRequest
    const p = normalizeMr(raw, KEY, HOST, 'me', 0)!
    assert.deepEqual([p.filesTruncated, p.threadsTruncated, p.checksTruncated, p.ci], [true, true, true, 'failing'])
  })

  test('the list: one GraphQL read on the right host, the default branch read by its name', async () => {
    const g = fakeGlab((args) => (args.includes('graphql') ? { stdout: included(listData()) } : { code: 1 }))
    const lab = createGitLab(g.exec, () => 7)
    const list = await lab.listOpen(REPO)
    assert.equal(g.calls.length, 2, 'the first read learns the default branch, then reads its pipeline')
    assert.deepEqual(g.calls[0].args.slice(0, 5), ['api', '--hostname', HOST, 'graphql', '-i'])
    assert.deepEqual([field(g.calls[0].args, 'path'), field(g.calls[0].args, 'ref'), field(g.calls[1].args, 'ref')], [PATH, 'HEAD', 'main'])
    assert.equal(list.viewer, 'me')
    assert.deepEqual(list.prs.map((p) => [p.number, p.headRef, p.baseRef, p.author, p.rollup]), [
      [12, 'feature/login', 'main', 'me', 'FAILURE'],
      [13, 'renovate/procfs', 'main', 'gitlab-dependency-update-bot', null]
    ])
    assert.deepEqual(list.base, { name: 'main', sha: BASE_SHA, rollup: 'FAILURE' })
    assert.deepEqual(list.rate, { cost: 1, remaining: 1990, resetAt: new Date(1794586440 * 1000).toISOString() })
    assert.ok(list.detailMaxAgeMs && list.detailMaxAgeMs <= 5 * 60_000)
    await lab.listOpen(REPO)
    assert.equal(g.calls.length, 3, 'then one read per tick')
  })

  test('a default branch whose head has no pipeline yet is not red; a host without rate headers has no rate', async () => {
    const g = fakeGlab(() => ({ stdout: included(listData({ pipelineSha: 'f'.repeat(40) }), false) }))
    const list = await createGitLab(g.exec).listOpen(REPO)
    assert.equal(list.base?.rollup, null)
    assert.equal(list.rate, null)
    const empty = await createGitLab(fakeGlab(() => ({ stdout: included(listData({ rootRef: null })) })).exec).listOpen(REPO)
    assert.equal(empty.base, null, 'no commits yet')
  })

  test('a project glab cannot see says where it looked', async () => {
    const g = fakeGlab(() => ({ stdout: included({ currentUser: { username: 'me' }, project: null }) }))
    await assert.rejects(createGitLab(g.exec).listOpen(REPO), (e: unknown) => e instanceof GitLabError && e.message.includes(`${HOST} has no project ${PATH}`))
    const down = fakeGlab(() => ({ code: 1, stdout: '', stderr: 'glab: 429 Too Many Requests' }))
    await assert.rejects(createGitLab(down.exec).listOpen(REPO), (e: unknown) => e instanceof GitLabError && e.rateLimited)
  })

  test('detail is one GraphQL read; unknown mergeability asks GitLab over REST to work it out', async () => {
    const unchecked = detailData({ detailedMergeStatus: 'UNCHECKED' })
    const g = fakeGlab((args) =>
      args.includes('graphql') ? { stdout: included(unchecked) } : { stdout: JSON.stringify({ iid: 12, detailed_merge_status: 'mergeable', has_conflicts: false }) }
    )
    const { pr: p, rate } = await createGitLab(g.exec, () => 9).detail(REPO, 12)
    assert.equal(field(g.calls[0].args, 'iid'), '12')
    assert.deepEqual(g.calls[1].args, ['api', '--hostname', HOST, 'projects/group%2Fsub%2Fapp/merge_requests/12'])
    assert.deepEqual([p?.mergeable, p?.mergeState, p?.fetchedAt, rate?.remaining], ['MERGEABLE', 'CLEAN', 9, 1990])
    const known = fakeGlab(() => ({ stdout: included(detailData()) }))
    await createGitLab(known.exec).detail(REPO, 12)
    assert.equal(known.calls.length, 1, 'known mergeability needs no second read')
  })

  test('glab -i output splits into headers and body, CRLF or not', () => {
    assert.deepEqual(splitInclude('HTTP/1.1 200 OK\nRateLimit-Remaining: 5\n\n{"a":1}'), { status: 200, headers: { 'ratelimit-remaining': '5' }, body: '{"a":1}' })
    assert.deepEqual(splitInclude('{"data":{}}'), { status: null, headers: {}, body: '{"data":{}}' })
  })
})

describe('acting on GitLab', () => {
  const lab = (reply: (args: readonly string[]) => object = () => ({ stdout: '{"ok":true,"result":{}}' })) => {
    const g = fakeGlab(reply)
    return { g, ex: createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {} }) }
  }
  const snap = normalizeMr(detailData().project.mergeRequest, KEY, HOST, 'me', 0)!
  const ctx = { repo: REPO, pr: snap, config: config(), root: '/r' }

  test('a merge is pinned to the reviewed commit, with squash and branch removal from the config', async () => {
    const { g, ex } = lab()
    assert.deepEqual(await ex.execute({ kind: 'merge', sha: SHA, method: 'squash' }, ctx), { ok: true })
    assert.deepEqual(g.calls[0].args, [
      'api', '--hostname', HOST, '-X', 'PUT', 'projects/group%2Fsub%2Fapp/merge_requests/12/merge',
      '-f', `sha=${SHA}`, '-F', 'squash=true', '-F', 'should_remove_source_branch=true'
    ])
    assert.equal(g.calls[0].file, 'glab')
    const keep = config((c) => (c.merge.deleteBranch = false))
    await ex.execute({ kind: 'merge', sha: SHA, method: 'merge' }, { ...ctx, config: keep })
    assert.deepEqual(g.calls[1].args.slice(-4), ['-F', 'squash=false', '-F', 'should_remove_source_branch=false'])
  })

  test('gitlab.com is named too, so glab never guesses the host from the working folder', async () => {
    const { g, ex } = lab()
    await ex.execute({ kind: 'update-branch', sha: SHA, method: 'rebase' }, { ...ctx, repo: gitlabRef('gitlab.com', 'acme/app') })
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', 'gitlab.com', '-X', 'PUT', 'projects/acme%2Fapp/merge_requests/12/rebase'])
  })

  test('GitLab cannot merge the base into a branch: the worker that owns it is asked instead', async () => {
    const { g, ex } = lab()
    assert.deepEqual(await ex.execute({ kind: 'update-branch', sha: SHA, method: 'merge' }, { ...ctx, owner: 'dispatch:d1' }), { ok: true })
    assert.ok(!g.calls.some((c) => c.file === 'glab'))
    const send = g.calls[0].args
    assert.equal(send[send.indexOf('--to') + 1], 'dispatch:d1')
    assert.match(send[send.indexOf('--body') + 1], /merge origin\/main into feature\/login/)
    const none = await ex.execute({ kind: 'update-branch', sha: SHA, method: 'merge' }, ctx)
    assert.equal(none.ok, false)
    assert.match(none.error ?? '', /GitLab cannot merge the base/)
  })

  test("a review is one note carrying Matriarch's marker, with the blocking findings folded in", async () => {
    const note = reviewNote({ body: '<!-- matriarch:review round=1 sha=x -->\n### Matriarch AI review', comments: [{ path: 'a.go', line: 3, body: '<!-- matriarch:finding -->\n**[major] Leak**\n\nfd not closed' }] })
    assert.ok(note.startsWith('<!-- matriarch:review'))
    assert.ok(note.includes('- `a.go:3` **[major] Leak**'))
    assert.equal(note.match(/<!-- matriarch/g)?.length, 1)
    const crew = { get: async () => ({ outcome: { verdict: 'changes', blocking: [], findings: [], summary: 'Changes needed.' } }) }
    const g = fakeGlab(() => ({}))
    const ex = createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {}, crew: crew as never })
    assert.deepEqual(await ex.execute({ kind: 'publish-review', sha: SHA, round: 1 }, ctx), { ok: true })
    const args = g.calls[0].args
    assert.deepEqual(args.slice(0, 6), ['api', '--hostname', HOST, '-X', 'POST', 'projects/group%2Fsub%2Fapp/merge_requests/12/notes'])
    assert.ok(field(args, 'body')?.startsWith('<!-- matriarch:review round=1'))
  })

  test("a failed job's log is read where the job ran, and tidied like the job page shows it", async () => {
    const esc = String.fromCharCode(27)
    const trace = `${esc}[0Ksection_start:1700000000:step_script\r${esc}[0K${esc}[36;1mExecuting "step_script"${esc}[0;m\nDownloading 10%\rDownloading 100%\n2026-11-13T10:00:00.123456Z 00O FAIL: TestLogin\n${esc}[0Ksection_end:1700000001:step_script\r${esc}[0K\n`
    const g = fakeGlab((args) => (args.at(-1)?.endsWith('/trace') ? { stdout: trace } : { stdout: '{"ok":true,"result":{}}' }))
    const ex = createExecutor({ exec: g.exec, orca: createOrcaCli(g.exec), notify: async () => {} })
    const failing = snap.checks.filter((c) => c.state === 'failure')
    assert.deepEqual(await ex.execute({ kind: 'send-ci-failure', to: 'dispatch:d1', sha: SHA, round: 1, checks: failing, signature: 'x' }, ctx), { ok: true })
    assert.deepEqual(g.calls[0].args, ['api', '--hostname', HOST, 'projects/forks%2Fme%2Fapp/jobs/16152393446/trace'])
    assert.equal(jobProject(`https://${HOST}/group/sub/app/-/jobs/1`), 'group/sub/app')
    assert.equal(traceTail(trace), 'Executing "step_script"\nDownloading 100%\nFAIL: TestLogin')
    const send = g.calls[1].args
    assert.match(send[send.indexOf('--body') + 1], /FAIL: TestLogin/)
  })
})

describe('an engine tick over a GitLab project', () => {
  const T0 = 1_800_000_000_000
  function harness(snaps: PrSnapshot[], over: { failList?: boolean } = {}) {
    const store = new Map<string, unknown>()
    const executed: { action: Action; repo: unknown; owner: unknown }[] = []
    const asked: string[] = []
    const gitlab: ForgeReader = {
      async listOpen(repo) {
        asked.push(repoKey(repo))
        if (over.failList) throw new Error('glab api graphql failed: 401 Unauthorized')
        return {
          viewer: 'me',
          rate: { cost: 1, remaining: 1990, resetAt: 'soon' },
          base: { name: 'main', sha: BASE_SHA, rollup: 'SUCCESS' },
          detailMaxAgeMs: 5 * 60_000,
          prs: snaps.map((p) => ({ number: p.number, headRef: p.headRef, headSha: p.headSha, baseRef: p.baseRef, author: p.author, updatedAt: p.updatedAt, rollup: 'SUCCESS' }))
        }
      },
      detail: async (_repo, n) => ({ pr: snaps.find((p) => p.number === n) ?? null, rate: null })
    }
    const github: ForgeReader = {
      listOpen: async (repo) => (asked.push(repoKey(repo)), { viewer: 'me', prs: [], rate: { cost: 1, remaining: 4900, resetAt: 'r' } }),
      detail: async () => ({ pr: null, rate: null })
    }
    const executor: Executor = { execute: async (action, ctx) => (executed.push({ action, repo: ctx.repo, owner: ctx.owner }), { ok: true }) }
    const workspaces: Workspace[] = [
      { id: 'ws-login', kind: 'worktree', name: 'login', path: '/lab/wt/login', branch: 'refs/heads/feature/login', hostId: 'local' },
      { id: 'ws-hub', kind: 'worktree', name: 'hub', path: '/hub/wt/x', branch: 'x', hostId: 'local' }
    ]
    const deps: EngineDeps = {
      now: () => T0,
      log: () => {},
      workspaces: async () => workspaces,
      repoOf: async (path) => (path.startsWith('/lab') ? { ref: REPO, key: KEY, root: '/lab' } : { ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/hub' }),
      readConfig: async () => validateConfig({ review: { enabled: false }, merge: { mode: 'auto', updateBranch: 'merge' } }),
      github,
      gitlab,
      workers: async () => [{ dispatchId: 'd-login', worktreeId: 'ws-login', taskId: 't1', runId: 'r1', agent: 'codex', model: null, state: 'idle' }],
      activity: () => null,
      supervisor: async () => null,
      store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      executor
    }
    return { deps, store, executed, asked }
  }
  const ready = (over: Partial<PrSnapshot> = {}) =>
    pr({ forge: 'gitlab', repo: KEY, url: `https://${HOST}/${PATH}/-/merge_requests/12`, ...over })

  test('each project is read from its own forge and stored under its own key', async () => {
    const h = harness([ready()])
    h.store.set(ledgerKey(KEY, 12), { heads: { [SHA]: 0 } })
    const board = await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.asked.sort(), ['acme/app', KEY])
    const lab = board.repos.find((r) => r.repo === KEY)!
    assert.equal(lab.forge, 'gitlab')
    assert.equal(board.repos.find((r) => r.repo === 'acme/app')?.forge, undefined, 'a GitHub project looks as it did')
    assert.equal(board.rate?.remaining, 4900, "GitHub's budget is the one shown")
    // Ready, CI green, review off, auto merge: merged through the project's own forge.
    assert.deepEqual(h.executed.map((e) => [e.action.kind, (e.repo as { kind?: string }).kind]), [['merge', 'gitlab']])
    assert.ok(h.store.get(ledgerKey(KEY, 12)))
    assert.ok(h.store.get(`tracked:${KEY}`))
  })

  test('a branch behind its base asks the owning worker to merge it in, and says so', async () => {
    const h = harness([ready({ mergeState: 'BEHIND' })])
    h.store.set(ledgerKey(KEY, 12), { heads: { [SHA]: 0 } })
    const dry = await tick(h.deps, { autopilot: false })
    assert.deepEqual(dry.tracks.find((t) => t.key === 'ws-login')?.next, ['ask the worker to merge its base in (GitLab cannot)'])
    await tick(h.deps, { autopilot: true })
    assert.deepEqual(h.executed.map((e) => [e.action.kind, e.owner]), [['update-branch', 'dispatch:d-login']])
  })

  test("GitLab's errors and outages are named as GitLab's", async () => {
    const h = harness([ready()], { failList: true })
    const board = await tick(h.deps, { autopilot: false })
    const lab = board.repos.find((r) => r.repo === KEY)!
    assert.ok(lab.errors[0].startsWith('GitLab: glab api graphql failed'))
    assert.match(board.tracks.find((t) => t.key === 'ws-login')?.reason ?? '', /^GitLab is unavailable/)
    const only = harness([ready()])
    only.deps.github = { listOpen: async () => { throw new Error('no GitHub here') }, detail: async () => ({ pr: null, rate: null }) }
    const mixed = await tick(only.deps, { autopilot: false })
    assert.equal(mixed.rate?.forge, 'GitLab', "with no GitHub budget, GitLab's is shown and named")
  })
})

describe('agent-facing commands come from the forge', () => {
  test("the supervisor brief gives a GitLab project's workers glab, and a GitHub project's gh", () => {
    const auto = validateConfig({ merge: { mode: 'auto' } }).config
    const lab = supervisorBrief({ repo: KEY, root: '/lab', objective: 'x', tag: 't', base: 'main', config: auto, forge: 'gitlab', host: HOST })
    assert.ok(lab.includes('glab mr create --target-branch main --fill --yes'))
    assert.ok(lab.includes('glab mr update <number> --ready'))
    assert.ok(lab.includes('glab mr view <n> -F json'))
    assert.ok(lab.includes(`This project is on GitLab (${HOST}): a PR here is a merge request`))
    assert.ok(lab.includes('in the merge request description'))
    assert.ok(!lab.includes('gh pr'), 'no gh commands for GitLab')
    const hub = supervisorBrief({ repo: 'acme/app', root: '/r', objective: 'x', tag: 't', base: 'main', config: auto })
    assert.ok(hub.includes('gh pr create --base main --fill') && hub.includes('gh pr view <n> --json state') && !hub.includes('glab'))
  })

  test('a quiet draft is marked ready with the forge CLI', () => {
    const quiet = (forge?: 'gitlab') =>
      plan(input({ pr: pr({ draft: true, ...(forge ? { forge } : {}) }), owner: owner({ activity: 'done' }), supervisor: 'run:r1', now: DRAFT_NUDGE_MS, ledger: { ...input().ledger, heads: { [SHA]: 0 } } }))
    const lab = quiet('gitlab').actions[0]
    assert.ok(lab.kind === 'escalate' && lab.reason.includes('mark it ready (glab mr update 12 --ready)'))
    const hub = quiet().actions[0]
    assert.ok(hub.kind === 'escalate' && hub.reason.includes('mark it ready (gh pr ready 12)'))
  })

  test("the planner's and the worker's words name GitLab on a merge request", () => {
    const blocked = plan(input({ pr: pr({ forge: 'gitlab', mergeState: 'BLOCKED' }), ledger: { ...input().ledger, reviews: { [SHA]: { round: 1, status: 'done', startedAt: 1, verdict: 'pass', published: true } } } }))
    assert.equal(blocked.reason, forgeTerms('gitlab').blocked)
    const m = commentsMessage(pr({ forge: 'gitlab' }), [thread('gid://gitlab/Discussion/1')], 1, 3)
    assert.ok(m.body.includes('discussionToggleResolve'))
    assert.ok(commentsMessage(pr(), [thread('T1')], 1, 3).body.includes('GraphQL resolveReviewThread'))
  })
})
