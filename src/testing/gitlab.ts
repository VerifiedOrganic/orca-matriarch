// GitLab answers for tests, in the shapes gitlab.com's GraphQL API gave on 2026-11-13 (merge
// requests of gitlab-org/gitlab-runner), moved to a self-hosted host and a nested project path.
// A fake `glab` answers them, so no test reaches a network.
import type { Exec, ExecResult } from '../exec.ts'
import { gitlabRef } from '../forge.ts'
import { SHA } from './fixtures.ts'

export const HOST = 'gitlab.example.com'
export const PATH = 'group/sub/app'
export const REPO = gitlabRef(HOST, PATH)
export const KEY = `${HOST}/${PATH}`
export const BASE_SHA = '4e1a9110ad7fbe4a30fcf8c35c616b09c5e09220'

export function listData(over: { pipelineSha?: string; rootRef?: string | null; viewer?: string | null } = {}) {
  return {
    currentUser: over.viewer === null ? null : { username: over.viewer ?? 'me' },
    project: {
      repository: over.rootRef === null ? { rootRef: null, tree: null } : { rootRef: over.rootRef ?? 'main', tree: { lastCommit: { sha: BASE_SHA } } },
      pipelines: { nodes: [{ status: 'FAILED', sha: over.pipelineSha ?? BASE_SHA }] },
      mergeRequests: {
        pageInfo: { hasNextPage: false, endCursor: 'eyJ1cGRhdGVkX2F0IjoiMjAyNi0xMS0xMyAxNToxNTo0OS44MTU4MzUwMDAgKzAwMDAiLCJpZCI6IjU2NzU3MTAyNSJ9' },
        nodes: [
          { iid: '12', sourceBranch: 'feature/login', targetBranch: 'main', diffHeadSha: SHA, updatedAt: '2026-11-13T15:15:51Z', author: { username: 'me' }, headPipeline: { status: 'FAILED' } },
          { iid: '13', sourceBranch: 'renovate/procfs', targetBranch: 'main', diffHeadSha: 'cc23aac49e405bdcb7fff39ac4df3be056808485', updatedAt: '2026-11-13T15:15:49Z', author: { username: 'gitlab-dependency-update-bot' }, headPipeline: null }
        ]
      }
    }
  }
}

/** Merge request !12: a failed pipeline, review threads of every kind, two changed files. */
export function detailData(over: Record<string, unknown> = {}) {
  return {
    currentUser: { username: 'me' },
    project: {
      mergeRequest: {
        iid: '12',
        webUrl: `https://${HOST}/${PATH}/-/merge_requests/12`,
        title: 'Add login',
        description: 'Matriarch-Task: t1',
        state: 'opened',
        draft: false,
        sourceBranch: 'feature/login',
        targetBranch: 'main',
        diffHeadSha: SHA,
        updatedAt: '2026-11-13T15:15:51Z',
        detailedMergeStatus: 'NOT_APPROVED',
        conflicts: false,
        approved: false,
        author: { username: 'me' },
        approvedBy: { nodes: [] },
        reviewers: {
          nodes: [
            { username: 'lachie', bot: false, mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } },
            { username: 'avon', bot: false, mergeRequestInteraction: { reviewState: 'UNREVIEWED' } }
          ]
        },
        headPipeline: {
          status: 'FAILED',
          jobs: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: 'gid://gitlab/Ci::Build/18010270200', name: 'test coverage report', status: 'SUCCESS', allowFailure: false, webPath: `/${PATH}/-/jobs/18010270200` },
              { id: 'gid://gitlab/Ci::Build/16152393446', name: 'dependency-scanning', status: 'FAILED', allowFailure: false, webPath: '/forks/me/app/-/jobs/16152393446' },
              { id: 'gid://gitlab/Ci::Build/16152393447', name: 'gitlab-advanced-sast', status: 'FAILED', allowFailure: true, webPath: `/${PATH}/-/jobs/16152393447` },
              { id: 'gid://gitlab/Ci::Build/16152393448', name: 'deploy review app', status: 'MANUAL', allowFailure: true, webPath: `/${PATH}/-/jobs/16152393448` },
              { id: 'gid://gitlab/Ci::Bridge/16152393449', name: 'downstream', status: 'SUCCESS', allowFailure: false, webPath: `/${PATH}/-/pipelines/1` }
            ]
          }
        },
        discussions: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: 'gid://gitlab/Discussion/5382929f9ff6ff6bcb54571efd4b1b2112da926d', resolvable: true, resolved: false,
              notes: { nodes: [{ body: '**suggestion:** Compare the whole `Content-Range`', url: `https://${HOST}/${PATH}/-/merge_requests/12#note_4229088296`, author: { username: 'lachie', bot: false }, position: { newPath: 'network/gitlab.go', newLine: 1256, oldPath: 'network/gitlab.go', oldLine: 1248 } }] }
            },
            {
              id: 'gid://gitlab/Discussion/d97291cd6825596ef20d6cf86d80ada98ccb2e94', resolvable: true, resolved: true,
              notes: { nodes: [{ body: 'fixed', url: null, author: { username: 'avon', bot: false }, position: { newPath: 'a.go', newLine: 48, oldPath: 'a.go', oldLine: null } }] }
            },
            {
              id: 'gid://gitlab/Discussion/ba5fe6f72e6bdc26c8a43f2144d5cf29d7cb7c9a', resolvable: true, resolved: false,
              notes: { nodes: [{ body: 'Note to self: split this later', url: null, author: { username: 'me', bot: false }, position: null }] }
            },
            {
              id: 'gid://gitlab/Discussion/aa11', resolvable: true, resolved: false,
              notes: { nodes: [{ body: '<!-- matriarch:finding -->\n**[major] x**', url: null, author: { username: 'someone', bot: false }, position: { newPath: 'b.go', newLine: 3, oldPath: null, oldLine: null } }] }
            },
            {
              id: 'gid://gitlab/Discussion/bb22', resolvable: true, resolved: false,
              notes: { nodes: [{ body: 'Coverage summary', url: null, author: { username: 'coverage-bot', bot: true }, position: null }] }
            },
            {
              id: 'gid://gitlab/Discussion/124903b47f56f4e47edcd279c1a5895a339bd04c', resolvable: false, resolved: false,
              notes: { nodes: [{ body: 'assigned to @jmrp', url: null, author: { username: 'gitlab-bot', bot: false }, position: null }] }
            }
          ]
        },
        diffStatsSummary: { fileCount: 2 },
        diffStats: [{ path: 'network/gitlab.go' }, { path: 'go.sum' }],
        ...over
      }
    }
  }
}

/** `glab api -i` output: the status line and headers (as gitlab.com sends them), then the body. */
export function included(data: unknown, rate = true): string {
  const headers = rate ? 'Ratelimit-Limit: 2000\r\nRatelimit-Name: throttle_authenticated_api\r\nRatelimit-Remaining: 1990\r\nRatelimit-Reset: 1794586440\r\n' : ''
  return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify({ data })}`
}

/** A fake `glab`: answers each call with `reply` and records it. */
export function fakeGlab(reply: (args: readonly string[]) => Partial<ExecResult>) {
  const calls: { file: string; args: readonly string[]; input?: string }[] = []
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, input: options?.input })
    return { code: 0, stdout: '', stderr: '', ...reply(args) }
  }
  return { exec, calls }
}

/** The value of a `-f name=value` field in glab arguments. */
export const field = (args: readonly string[], name: string): string | undefined => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
