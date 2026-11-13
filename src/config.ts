// The repository's `.orca/matriarch.json`: roles, review crew and loop policies. Its presence
// opts a repository in. Parsing never throws: a bad value falls back to its default and is
// reported, so one typo cannot switch the whole crew off.

import { MODEL_AGENTS } from './agents.ts'
import type { ForgeKind } from './forge.ts'
import { LOCKABLE_AGENTS } from './lockdown.ts'

export const CONFIG_PATH = '.orca/matriarch.json'
/** Where a project's settings wait while Matriarch is turned off there. */
export const CONFIG_OFF_PATH = '.orca/matriarch.off.json'

/** Agents whose model Orca can choose at launch (`--model`, Orca 1.4.257); see agents.ts. */
export const MODEL_FLAG_AGENTS: readonly string[] = MODEL_AGENTS

/**
 * The `orca agent launch` / `worker-start` flags for a role's model and effort. Orca turns the
 * effort into each agent's own form; for OpenCode that is the model's variant, sent beside the
 * model. (`model#variant` works on OpenCode's command line but its API, which Orca's workers
 * use, rejects it: "model not found".) A `#variant` typed into the model moves to the effort.
 */
export function modelFlags(role: RoleSpec): string[] {
  if (!role.model) return []
  const [model, variant] = role.model.split('#', 2)
  const effort = role.effort ?? (variant || undefined)
  return ['--model', model, ...(effort ? ['--effort', effort] : [])]
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'
export const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor', 'nit']

export interface RoleSpec {
  /** An Orca agent id: claude, codex, cursor, antigravity, grok, muse, opencode, ... */
  agent: string
  model?: string
  effort?: string
}

export interface ReviewerSpec extends RoleSpec {
  name: string
  /** What this reviewer looks for; added to its brief. */
  focus?: string
  /** A blocking reviewer must approve under the `all-blocking-approve` policy. */
  blocking: boolean
  /**
   * Reviewers start read-only (claude and codex, locked down by their own agent). Only for another
   * agent, which Matriarch cannot lock down, `false` lets it run with the person's usual permissions.
   */
  readOnly?: boolean
}

/**
 * Where the project lives, when its origin alone does not say: GitLab on a host glab is not
 * signed in to yet, or behind an ssh alias that hides the real host. Matriarch detects it
 * otherwise (github.com is GitHub; another host is GitLab when glab is signed in to it).
 */
export interface ForgeSetting {
  kind: ForgeKind
  /** The forge's web host, such as gitlab.example.com; the origin's host when left out. */
  host?: string
}

export interface FixPolicy {
  enabled: boolean
  maxRounds: number
}

export interface MatriarchConfig {
  version: 1
  /** Set only to override what the origin says; see ForgeSetting. */
  forge?: ForgeSetting
  supervisor: RoleSpec
  workers: { default: RoleSpec; tiers: Record<string, RoleSpec> }
  reviewers: ReviewerSpec[]
  arbiter: RoleSpec | null
  review: {
    enabled: boolean
    trigger: 'ci-green' | 'pr-open'
    pass: 'all-blocking-approve' | 'majority' | 'no-blockers'
    blockAt: Severity
    differentProviderThanAuthor: boolean
    maxRounds: number
    publish: 'github' | 'orca-only'
    /**
     * Rounds after the first: `focused` checks what changed since the last review and whether its
     * findings were fixed (cheaper); `full` reviews the whole PR again.
     */
    followUp: 'focused' | 'full'
    /** When a reviewer's account hits its usage limit, it is started again on this instead. */
    fallback: RoleSpec | null
  }
  fix: { ci: FixPolicy; comments: FixPolicy; conflicts: FixPolicy }
  merge: {
    mode: 'manual' | 'auto'
    method: 'squash' | 'merge' | 'rebase'
    requireHuman: string[]
    updateBranch: 'rebase' | 'merge' | 'off'
    onBaseRed: 'pause' | 'fix-forward' | 'revert'
    deleteBranch: boolean
    /** Removes a merged PR's worktree once no worker runs there and it has nothing uncommitted. */
    removeWorktree: boolean
    /**
     * Removes a worktree the supervisor's workers used that never became a PR (a gate, an audit, a
     * spike), an hour after its last worker finished, when nothing in it is uncommitted or unpushed.
     */
    removeFinishedWorktrees: boolean
  }
  escalation: { supervisorFirst: boolean; humanAfterMinutes: number }
  limits: { maxConcurrentReviews: number }
}

export function defaultConfig(): MatriarchConfig {
  return {
    version: 1,
    // No models here: they would go stale. Each agent runs its default (the one picked in Orca,
    // if any) until a model is chosen in Settings, from the list the agent itself offers.
    supervisor: { agent: 'claude' },
    workers: {
      default: { agent: 'codex' },
      tiers: {}
    },
    reviewers: [
      { name: 'correctness', agent: 'claude', focus: 'bugs, edge cases, missing tests', blocking: true },
      { name: 'security', agent: 'codex', focus: 'authz, injection, secrets, unsafe input', blocking: true }
    ],
    arbiter: null,
    review: {
      enabled: true,
      trigger: 'ci-green',
      pass: 'all-blocking-approve',
      blockAt: 'major',
      differentProviderThanAuthor: true,
      maxRounds: 3,
      publish: 'github',
      followUp: 'focused',
      fallback: null
    },
    fix: {
      ci: { enabled: true, maxRounds: 3 },
      comments: { enabled: true, maxRounds: 3 },
      conflicts: { enabled: true, maxRounds: 2 }
    },
    merge: {
      mode: 'manual',
      method: 'squash',
      requireHuman: [],
      updateBranch: 'rebase',
      onBaseRed: 'pause',
      deleteBranch: true,
      removeWorktree: true,
      removeFinishedWorktrees: true
    },
    escalation: { supervisorFirst: true, humanAfterMinutes: 30 },
    limits: { maxConcurrentReviews: 2 }
  }
}

export interface ConfigResult {
  config: MatriarchConfig
  errors: string[]
  warnings: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

class Reader {
  errors: string[] = []
  warnings: string[] = []

  unknownKeys(value: Obj, known: readonly string[], path: string): void {
    for (const key of Object.keys(value)) {
      if (key === '$schema') continue
      if (!known.includes(key)) this.warnings.push(`${path}.${key}: unknown key, ignored`)
    }
  }

  section(parent: Obj, key: string, path: string): Obj | undefined {
    const v = parent[key]
    if (v === undefined) return undefined
    if (!isObj(v)) {
      this.errors.push(`${path}.${key}: expected an object`)
      return undefined
    }
    return v
  }

  bool(o: Obj | undefined, key: string, fallback: boolean, path: string): boolean {
    const v = o?.[key]
    if (v === undefined) return fallback
    if (typeof v !== 'boolean') {
      this.errors.push(`${path}.${key}: expected true or false`)
      return fallback
    }
    return v
  }

  int(o: Obj | undefined, key: string, fallback: number, path: string, min: number, max: number): number {
    const v = o?.[key]
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.errors.push(`${path}.${key}: expected a whole number from ${min} to ${max}`)
      return fallback
    }
    return v
  }

  oneOf<T extends string>(o: Obj | undefined, key: string, allowed: readonly T[], fallback: T, path: string): T {
    const v = o?.[key]
    if (v === undefined) return fallback
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.errors.push(`${path}.${key}: expected one of ${allowed.join(', ')}`)
      return fallback
    }
    return v as T
  }

  strings(o: Obj | undefined, key: string, fallback: string[], path: string): string[] {
    const v = o?.[key]
    if (v === undefined) return fallback
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.length === 0)) {
      this.errors.push(`${path}.${key}: expected a list of non-empty strings`)
      return fallback
    }
    return [...(v as string[])]
  }

  /** The optional forge setting: github or gitlab, and for GitLab a bare host name. */
  forge(v: unknown): ForgeSetting | undefined {
    if (v === undefined || v === null) return undefined
    if (!isObj(v)) {
      this.errors.push('forge: expected an object with a kind, github or gitlab')
      return undefined
    }
    this.unknownKeys(v, ['kind', 'host'], 'forge')
    if (v.kind !== 'github' && v.kind !== 'gitlab') {
      this.errors.push('forge.kind: expected one of github, gitlab')
      return undefined
    }
    const setting: ForgeSetting = { kind: v.kind }
    if (v.host !== undefined) {
      const host = typeof v.host === 'string' ? v.host.trim().toLowerCase() : ''
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host)) {
        this.errors.push('forge.host: expected a host name such as gitlab.example.com, without https:// or a path')
        return undefined
      }
      setting.host = host
    }
    if (setting.kind === 'github' && setting.host && setting.host !== 'github.com') {
      this.errors.push('forge.host: Matriarch reads GitHub only on github.com')
      return undefined
    }
    return setting
  }

  role(v: unknown, path: string, fallback: RoleSpec | null): RoleSpec | null {
    if (v === undefined) return fallback
    if (v === null) return null
    if (!isObj(v)) {
      this.errors.push(`${path}: expected an object with an agent`)
      return fallback
    }
    this.unknownKeys(v, ['agent', 'model', 'effort'], path)
    return this.roleFields(v, path, fallback)
  }

  roleFields(v: Obj, path: string, fallback: RoleSpec | null): RoleSpec | null {
    const agent = v.agent
    if (typeof agent !== 'string' || agent.trim() === '') {
      this.errors.push(`${path}.agent: required, an Orca agent id such as claude or codex`)
      return fallback
    }
    const spec: RoleSpec = { agent: agent.trim() }
    for (const field of ['model', 'effort'] as const) {
      const f = v[field]
      if (f === undefined) continue
      if (typeof f !== 'string' || f.trim() === '') {
        this.errors.push(`${path}.${field}: expected a non-empty string`)
        continue
      }
      spec[field] = f.trim()
    }
    if (spec.effort && !spec.model) {
      this.errors.push(`${path}.effort: needs a model (Orca only passes --effort with --model)`)
      delete spec.effort
    }
    if (spec.model && !MODEL_FLAG_AGENTS.includes(spec.agent)) {
      this.warnings.push(
        `${path}.model: Orca cannot pass --model to ${spec.agent}; it will run its default model`
      )
    }
    return spec
  }
}

/** A project file's forge setting, when it has a valid one; the rest of the file is not checked here. */
export function forgeSettingOf(raw: unknown): ForgeSetting | null {
  const r = new Reader()
  const setting = isObj(raw) ? r.forge(raw.forge) : undefined
  return setting && r.errors.length === 0 ? setting : null
}

export function parseConfig(text: string): ConfigResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { config: defaultConfig(), errors: [`${CONFIG_PATH}: not valid JSON (${(error as Error).message})`], warnings: [] }
  }
  return validateConfig(raw)
}

export function validateConfig(raw: unknown): ConfigResult {
  const d = defaultConfig()
  const r = new Reader()
  if (!isObj(raw)) {
    return { config: d, errors: [`${CONFIG_PATH}: expected a JSON object`], warnings: [] }
  }
  r.unknownKeys(raw, ['version', 'forge', 'supervisor', 'workers', 'reviewers', 'arbiter', 'review', 'fix', 'merge', 'escalation', 'limits'], 'config')
  if (raw.version !== undefined && raw.version !== 1) r.errors.push('config.version: only version 1 is supported')
  const forge = r.forge(raw.forge)

  const supervisor = r.role(raw.supervisor, 'supervisor', d.supervisor) ?? d.supervisor

  const workersRaw = r.section(raw, 'workers', 'config')
  if (workersRaw) r.unknownKeys(workersRaw, ['default', 'tiers'], 'workers')
  const workerDefault = r.role(workersRaw?.default, 'workers.default', d.workers.default) ?? d.workers.default
  const tiers: Record<string, RoleSpec> = {}
  const tiersRaw = workersRaw ? r.section(workersRaw, 'tiers', 'workers') : undefined
  for (const [name, spec] of Object.entries(tiersRaw ?? {})) {
    const role = r.role(spec, `workers.tiers.${name}`, null)
    if (role) tiers[name] = role
  }

  let reviewers = d.reviewers
  if (raw.reviewers !== undefined) {
    if (!Array.isArray(raw.reviewers)) {
      r.errors.push('reviewers: expected a list')
    } else {
      reviewers = []
      const seen = new Set<string>()
      raw.reviewers.forEach((item, i) => {
        const path = `reviewers[${i}]`
        if (!isObj(item)) {
          r.errors.push(`${path}: expected an object`)
          return
        }
        r.unknownKeys(item, ['name', 'agent', 'model', 'effort', 'focus', 'blocking', 'readOnly'], path)
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
          r.errors.push(`${path}.name: required, lowercase letters, digits and dashes`)
          return
        }
        if (seen.has(name)) {
          r.errors.push(`${path}.name: "${name}" is used twice`)
          return
        }
        const role = r.roleFields(item, path, null)
        if (!role) return
        seen.add(name)
        const reviewer: ReviewerSpec = { ...role, name, blocking: r.bool(item, 'blocking', true, path) }
        if (item.focus !== undefined) {
          if (typeof item.focus === 'string' && item.focus.trim()) reviewer.focus = item.focus.trim()
          else r.errors.push(`${path}.focus: expected a non-empty string`)
        }
        const readOnly = r.bool(item, 'readOnly', true, path)
        const lockable = LOCKABLE_AGENTS.includes(reviewer.agent)
        if (!readOnly && lockable) {
          r.warnings.push(`${path}.readOnly: ignored; ${reviewer.agent} reviewers always start read-only`)
        } else if (!readOnly) {
          reviewer.readOnly = false
          r.warnings.push(`${path}: "${name}" runs ${reviewer.agent} with your usual permissions for it (readOnly: false), in a throwaway worktree`)
        } else if (!lockable) {
          r.warnings.push(
            `${path}: Matriarch can start only claude and codex reviewers read-only, so "${name}" (${reviewer.agent}) is not started. Set "readOnly": false on it to run it with your usual permissions.`
          )
        }
        reviewers.push(reviewer)
      })
    }
  }

  const arbiter = r.role(raw.arbiter, 'arbiter', d.arbiter)

  const rv = r.section(raw, 'review', 'config')
  if (rv) r.unknownKeys(rv, Object.keys(d.review), 'review')
  const review: MatriarchConfig['review'] = {
    enabled: r.bool(rv, 'enabled', d.review.enabled, 'review'),
    trigger: r.oneOf(rv, 'trigger', ['ci-green', 'pr-open'] as const, d.review.trigger, 'review'),
    pass: r.oneOf(rv, 'pass', ['all-blocking-approve', 'majority', 'no-blockers'] as const, d.review.pass, 'review'),
    blockAt: r.oneOf(rv, 'blockAt', SEVERITIES, d.review.blockAt, 'review'),
    differentProviderThanAuthor: r.bool(rv, 'differentProviderThanAuthor', d.review.differentProviderThanAuthor, 'review'),
    maxRounds: r.int(rv, 'maxRounds', d.review.maxRounds, 'review', 1, 10),
    publish: r.oneOf(rv, 'publish', ['github', 'orca-only'] as const, d.review.publish, 'review'),
    followUp: r.oneOf(rv, 'followUp', ['focused', 'full'] as const, d.review.followUp, 'review'),
    fallback: rv?.fallback === undefined || rv?.fallback === null ? null : r.role(rv.fallback, 'review.fallback', null)
  }
  if (review.enabled && reviewers.length === 0) r.warnings.push('review.enabled: no reviewers configured, so no AI review will run')
  if (review.fallback && !LOCKABLE_AGENTS.includes(review.fallback.agent)) {
    r.warnings.push(`review.fallback: Matriarch can start only claude and codex reviewers read-only, so the fallback (${review.fallback.agent}) is not used`)
    review.fallback = null
  }

  const fx = r.section(raw, 'fix', 'config')
  if (fx) r.unknownKeys(fx, ['ci', 'comments', 'conflicts'], 'fix')
  const fixPolicy = (key: 'ci' | 'comments' | 'conflicts'): FixPolicy => {
    const o = fx ? r.section(fx, key, 'fix') : undefined
    if (o) r.unknownKeys(o, ['enabled', 'maxRounds'], `fix.${key}`)
    return {
      enabled: r.bool(o, 'enabled', d.fix[key].enabled, `fix.${key}`),
      maxRounds: r.int(o, 'maxRounds', d.fix[key].maxRounds, `fix.${key}`, 1, 10)
    }
  }
  const fix = { ci: fixPolicy('ci'), comments: fixPolicy('comments'), conflicts: fixPolicy('conflicts') }

  const mg = r.section(raw, 'merge', 'config')
  if (mg) r.unknownKeys(mg, Object.keys(d.merge), 'merge')
  const merge: MatriarchConfig['merge'] = {
    mode: r.oneOf(mg, 'mode', ['manual', 'auto'] as const, d.merge.mode, 'merge'),
    method: r.oneOf(mg, 'method', ['squash', 'merge', 'rebase'] as const, d.merge.method, 'merge'),
    requireHuman: r.strings(mg, 'requireHuman', d.merge.requireHuman, 'merge'),
    updateBranch: r.oneOf(mg, 'updateBranch', ['rebase', 'merge', 'off'] as const, d.merge.updateBranch, 'merge'),
    onBaseRed: r.oneOf(mg, 'onBaseRed', ['pause', 'fix-forward', 'revert'] as const, d.merge.onBaseRed, 'merge'),
    deleteBranch: r.bool(mg, 'deleteBranch', d.merge.deleteBranch, 'merge'),
    removeWorktree: r.bool(mg, 'removeWorktree', d.merge.removeWorktree, 'merge'),
    removeFinishedWorktrees: r.bool(mg, 'removeFinishedWorktrees', d.merge.removeFinishedWorktrees, 'merge')
  }

  const es = r.section(raw, 'escalation', 'config')
  if (es) r.unknownKeys(es, ['supervisorFirst', 'humanAfterMinutes'], 'escalation')
  const escalation = {
    supervisorFirst: r.bool(es, 'supervisorFirst', d.escalation.supervisorFirst, 'escalation'),
    humanAfterMinutes: r.int(es, 'humanAfterMinutes', d.escalation.humanAfterMinutes, 'escalation', 1, 24 * 60)
  }

  const lm = r.section(raw, 'limits', 'config')
  if (lm) r.unknownKeys(lm, ['maxConcurrentReviews'], 'limits')
  const limits = { maxConcurrentReviews: r.int(lm, 'maxConcurrentReviews', d.limits.maxConcurrentReviews, 'limits', 1, 20) }

  // Accepted so configs stay valid as these land, but say plainly that they do nothing yet.
  if (arbiter) r.warnings.push('arbiter: not used yet; verdicts are combined by review.pass alone')
  if (merge.onBaseRed === 'revert') {
    r.warnings.push('merge.onBaseRed: "revert" is not built yet; Matriarch pauses merging and asks the supervisor to find and revert the change')
  }

  return {
    config: { version: 1, ...(forge ? { forge } : {}), supervisor, workers: { default: workerDefault, tiers }, reviewers, arbiter, review, fix, merge, escalation, limits },
    errors: r.errors,
    warnings: r.warnings
  }
}
