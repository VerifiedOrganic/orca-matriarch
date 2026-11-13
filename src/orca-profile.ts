// What Matriarch needs from the person's Orca profile that the plugin API does not give: the
// agents they turned off in Orca's settings, the commands they point agents at, and the
// workspace focused right now. Read only, three fields, from the active profile's state
// (`profiles/<id>/profile-state.db`, the same store Orca's settings screen writes). Nothing else
// in it is read. Any failure answers null, and callers fall back to what they can tell alone.
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from './exec.ts'

export interface OrcaProfile {
  /** Agents switched off in Orca's settings (`disabledTuiAgents`). */
  disabledAgents: string[]
  /** Agent id → the command Orca runs for it instead of its own (`agentCmdOverrides`). */
  commandOverrides: Record<string, string>
  /** The workspace focused in Orca (`<repoId>::<path>`), as Orca last saved it. */
  activeWorktreeId: string | null
}

/** Orca's data folder: what Orca tells its agents, else its default on each platform. */
export function orcaDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'orca')
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'orca')
}

const QUERY = `select
  (select json_extract(payload, '$.disabledTuiAgents') from profile_state_documents where domain = 'settings') as disabled,
  (select json_extract(payload, '$.agentCmdOverrides') from profile_state_documents where domain = 'settings') as overrides,
  (select json_extract(payload, '$.activeWorktreeId') from profile_state_documents where domain = 'workspaceSession') as active`

type Obj = Record<string, unknown>
const parse = (text: unknown): unknown => {
  if (typeof text !== 'string') return text ?? null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Turns the query's row into a profile; tolerant of missing fields. */
export function profileFromRow(row: Obj): OrcaProfile {
  const disabled = parse(row.disabled)
  const overrides = parse(row.overrides)
  const active = row.active
  return {
    disabledAgents: Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string') : [],
    commandOverrides:
      overrides && typeof overrides === 'object' && !Array.isArray(overrides)
        ? Object.fromEntries(Object.entries(overrides as Obj).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''))
        : {},
    activeWorktreeId: typeof active === 'string' && active ? active : null
  }
}

export async function readOrcaProfile(exec: Exec, readText: (path: string) => Promise<string | null>, dataDir = orcaDataDir()): Promise<OrcaProfile | null> {
  try {
    const index = JSON.parse((await readText(join(dataDir, 'orca-profile-index.json'))) ?? 'null') as { activeProfileId?: unknown } | null
    const id = typeof index?.activeProfileId === 'string' && /^[\w.-]+$/.test(index.activeProfileId) ? index.activeProfileId : null
    if (!id) return null
    const db = join(dataDir, 'profiles', id, 'profile-state.db').replace(/[%?#]/g, encodeURIComponent)
    // Read only: Orca keeps writing it, and nothing here may get in its way.
    const res = await exec('sqlite3', ['-json', `file:${db}?mode=ro`, QUERY], { timeoutMs: 5_000 })
    if (res.code !== 0) return null
    const rows = JSON.parse(res.stdout || '[]') as Obj[]
    return rows[0] ? profileFromRow(rows[0]) : null
  } catch {
    return null
  }
}

/** A model an agent offers, as Orca discovered it by asking the agent. */
export interface CatalogModel {
  id: string
  label: string
  /** The effort levels this model takes. */
  efforts: string[]
  isDefault: boolean
}

export interface AgentModels {
  models: CatalogModel[]
  /** The model and effort the person picked for this agent in Orca, if any. */
  configured: { model: string | null; effort: string | null } | null
}

/** One row of Orca's model catalog into the models it lists. */
export function modelsFromRow(value: unknown): { agent: string; models: AgentModels } | null {
  const v = value && typeof value === 'object' ? (value as Obj) : {}
  if (typeof v.agent !== 'string') return null
  const discovered = v.discovered && typeof v.discovered === 'object' ? (v.discovered as Obj) : {}
  const list = Array.isArray(discovered.models) ? discovered.models : []
  const models: CatalogModel[] = []
  for (const item of list) {
    const m = item && typeof item === 'object' ? (item as Obj) : {}
    if (typeof m.id !== 'string' || !m.id) continue
    const efforts = (Array.isArray(m.efforts) ? m.efforts : [])
      .map((e) => (typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as Obj).value === 'string' ? ((e as Obj).value as string) : null))
      .filter((e): e is string => e !== null && e !== 'none')
    models.push({ id: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id, efforts, isDefault: m.isDefault === true })
  }
  const c = v.configured && typeof v.configured === 'object' ? (v.configured as Obj) : null
  return {
    agent: v.agent,
    models: { models, configured: c ? { model: typeof c.modelId === 'string' ? c.modelId : null, effort: typeof c.effort === 'string' ? c.effort : null } : null }
  }
}

/**
 * The models Orca has discovered for each agent (`agent-model-catalog.db`, which Orca fills by
 * asking each installed agent), the most recent discovery per agent. Null when unreadable.
 */
export async function readModelCatalog(exec: Exec, dataDir = orcaDataDir()): Promise<Record<string, AgentModels> | null> {
  try {
    const db = join(dataDir, 'agent-model-catalog.db').replace(/[%?#]/g, encodeURIComponent)
    const res = await exec('sqlite3', ['-json', `file:${db}?mode=ro`, 'select value from rows order by seq'], { timeoutMs: 5_000 })
    if (res.code !== 0) return null
    const out: Record<string, AgentModels> = {}
    for (const row of JSON.parse(res.stdout || '[]') as Obj[]) {
      const parsed = modelsFromRow(parse(row.value))
      // Rows come oldest first: a later discovery of the same agent replaces an earlier one.
      if (parsed && parsed.models.models.length > 0) out[parsed.agent] = parsed.models
    }
    return out
  } catch {
    return null
  }
}
