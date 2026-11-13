// Builders for tests: a PR snapshot, an owner and a config with only the fields a test changes.
import { defaultConfig, type MatriarchConfig } from '../config.ts'
import type { CheckInfo, PrSnapshot, ThreadInfo } from '../github.ts'
import { emptyLedger, type PrLedger } from '../ledger.ts'
import type { Owner, PlanInput } from '../plan.ts'

export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

export function check(name: string, state: CheckInfo['state'], jobId: number | null = 1): CheckInfo {
  return { name, state, url: `https://github.com/acme/app/actions/runs/1/job/${jobId}`, jobId }
}

export function thread(id: string, over: Partial<ThreadInfo> = {}): ThreadInfo {
  return { id, resolved: false, outdated: false, path: 'src/a.ts', line: 3, author: 'alice', bot: false, body: 'please fix', url: null, ours: false, ...over }
}

export function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    repo: 'acme/app',
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'Add login',
    body: '',
    author: 'me',
    headRef: 'feature/login',
    headSha: SHA,
    baseRef: 'main',
    draft: false,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    reviewDecision: null,
    ci: 'passing',
    checks: [check('test', 'success')],
    checksTruncated: false,
    threads: [],
    threadsTruncated: false,
    files: ['src/a.ts'],
    filesTruncated: false,
    updatedAt: '2026-11-10T10:00:00Z',
    fetchedAt: 0,
    ...over
  }
}

export function owner(over: Partial<Owner> = {}): Owner {
  return { address: 'dispatch:d1', activity: 'done', since: 1, agent: 'codex', model: 'gpt-6-astra', workspaceId: 'ws1', ...over }
}

/** A project as someone set it up in Settings: the defaults, with models chosen for each role. */
export function config(mutate: (c: MatriarchConfig) => void = () => {}): MatriarchConfig {
  const c = defaultConfig()
  c.supervisor = { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }
  c.workers.default = { agent: 'codex', model: 'gpt-6-astra', effort: 'high' }
  c.reviewers = c.reviewers.map((r) => ({ ...r, model: r.agent === 'claude' ? 'claude-opus-5-5' : 'gpt-6-astra' }))
  mutate(c)
  return c
}

export function input(over: Partial<PlanInput> = {}, ledger: PrLedger = emptyLedger()): PlanInput {
  return {
    pr: pr(),
    owner: owner(),
    ledger,
    config: config(),
    supervisor: null,
    mergeSlotFree: true,
    reviewSlotFree: true,
    now: 1_000_000,
    ...over
  }
}
