// The agents the settings form offers for each role. Orca's plugin API does not list the agents
// it can launch, so this is Matriarch's own list, taken from Orca 1.4.257: every agent Orca starts
// in a terminal, the command it runs (to see whether it is installed), and whether Orca can pass
// it a model (`--model`) and an effort. Agents Orca has discovered models for are added even when
// they are not on this list. Models themselves come only from Orca and the agents' own CLIs, never
// from a list here that would go stale; any model id can still be typed.
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { LOCKABLE_AGENTS } from './lockdown.ts'
import type { AgentModels, OrcaProfile } from './orca-profile.ts'
import type { AgentOption } from './protocol.ts'

interface CatalogEntry {
  id: string
  label: string
  /** The CLI Orca starts for it (`detectCmd` in Orca). */
  command: string
  /** Orca can choose its model at launch. */
  takesModel?: boolean
  /** Effort levels to offer when Orca has not discovered the model's own. */
  efforts?: string[]
}

const LEVELS = ['low', 'medium', 'high']

export const AGENT_CATALOG: readonly CatalogEntry[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', takesModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', label: 'Codex', command: 'codex', takesModel: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', takesModel: true },
  { id: 'opencode2', label: 'OpenCode 2', command: 'opencode2' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', takesModel: true },
  { id: 'cursor', label: 'Cursor', command: 'cursor-agent', takesModel: true },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', takesModel: true, efforts: LEVELS },
  { id: 'grok', label: 'Grok', command: 'grok', takesModel: true, efforts: LEVELS },
  { id: 'muse', label: 'Muse', command: 'muse', takesModel: true, efforts: LEVELS },
  { id: 'codebuddy', label: 'CodeBuddy', command: 'codebuddy', takesModel: true, efforts: LEVELS },
  { id: 'omp', label: 'Oh My Pi', command: 'omp', takesModel: true, efforts: LEVELS },
  { id: 'copilot', label: 'GitHub Copilot', command: 'copilot' },
  { id: 'amp', label: 'Amp', command: 'amp' },
  { id: 'aider', label: 'Aider', command: 'aider' },
  { id: 'goose', label: 'Goose', command: 'goose' },
  { id: 'droid', label: 'Droid', command: 'droid' },
  { id: 'cline', label: 'Cline', command: 'cline' },
  { id: 'kilo', label: 'Kilo Code', command: 'kilo' },
  { id: 'kiro', label: 'Kiro', command: 'kiro-cli' },
  { id: 'crush', label: 'Crush', command: 'crush' },
  { id: 'aug', label: 'Augment', command: 'auggie' },
  { id: 'qwen-code', label: 'Qwen Code', command: 'qwen' },
  { id: 'mistral-vibe', label: 'Mistral Vibe', command: 'vibe' },
  { id: 'kimi', label: 'Kimi', command: 'kimi' },
  { id: 'continue', label: 'Continue', command: 'cn' },
  { id: 'rovo', label: 'Rovo Dev', command: 'acli' },
  { id: 'qoder', label: 'Qoder', command: 'qodercli' },
  { id: 'qoder-cn', label: 'Qoder (China)', command: 'qoderclicn' },
  { id: 'openclaude', label: 'OpenClaude', command: 'openclaude' },
  { id: 'trae', label: 'Trae', command: 'traecli' },
  { id: 'pi', label: 'Pi', command: 'pi' },
  { id: 'devin', label: 'Devin', command: 'devin' },
  { id: 'codebuff', label: 'Codebuff', command: 'codebuff' },
  { id: 'freebuff', label: 'Freebuff', command: 'freebuff' },
  { id: 'command-code', label: 'Command Code', command: 'command-code' },
  { id: 'hermes', label: 'Hermes', command: 'hermes' },
  { id: 'openclaw', label: 'OpenClaw', command: 'openclaw' },
  { id: 'autohand', label: 'Autohand', command: 'autohand' },
  { id: 'ante', label: 'Ante', command: 'ante' },
  { id: 'mimo-code', label: 'MiMo Code', command: 'mimo' },
  { id: 'prime-agent', label: 'Prime Agent', command: 'prime-agent' },
  { id: 'jcode', label: 'jcode', command: 'jcode' },
  { id: 'zcode', label: 'ZCode', command: 'zcode' },
  { id: 'dsh', label: 'dsh', command: 'dsh-tui' }
]

/** A model an agent's own CLI listed just now. */
export interface LiveModel {
  id: string
  label: string
  /** Thinking levels (OpenCode's variants); empty when not known. */
  efforts: string[]
}

/**
 * Agents whose own CLI lists the models available to the person right now, with every provider
 * they are signed in to, tried in order: OpenCode's API gives names and thinking levels, its
 * `models` command only ids. Asked when the settings open: Orca's discovered list can be days old.
 */
export const MODEL_LISTERS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  opencode: [['api', 'model.list'], ['models']],
  opencode2: [['api', 'model.list'], ['models']]
}

/** Models from a lister's output: OpenCode's `model.list` JSON, or `provider/model` ids by line. */
export function parseModelList(stdout: string): LiveModel[] {
  const text = stdout.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const d = JSON.parse(text) as unknown
      const items = Array.isArray(d) ? d : Array.isArray((d as { data?: unknown }).data) ? ((d as { data: unknown[] }).data) : []
      const out: LiveModel[] = []
      for (const item of items) {
        const m = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        const provider = typeof m.providerID === 'string' ? m.providerID : null
        const model = typeof m.modelID === 'string' ? m.modelID : typeof m.id === 'string' ? m.id : null
        if (!provider || !model || m.enabled === false) continue
        const variants = Array.isArray(m.variants) ? m.variants : []
        out.push({
          id: `${provider}/${model}`,
          label: typeof m.name === 'string' && m.name ? m.name : model,
          efforts: variants.map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : null)).filter((v): v is string => typeof v === 'string' && v !== '')
        })
      }
      return [...new Map(out.map((m) => [m.id, m])).values()]
    } catch {
      return []
    }
  }
  const ids = [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)))]
  return ids.map((id) => ({ id, label: id.slice(id.indexOf('/') + 1), efforts: [] }))
}

/** Agents Orca can launch with a chosen model (`--model`). */
export const MODEL_AGENTS: readonly string[] = AGENT_CATALOG.filter((a) => a.takesModel).map((a) => a.id)

/** Whether `command` is an executable on this PATH. */
export async function onPath(command: string, path = process.env.PATH ?? ''): Promise<boolean> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, command), constants.X_OK)
      return true
    } catch {
      // not in this folder
    }
  }
  return false
}

export interface AgentSources {
  /** Finds a command on the PATH. */
  found?: (command: string) => Promise<boolean>
  /** The person's Orca profile: agents they turned off, and commands they point agents at. */
  profile?: OrcaProfile | null
  /** The models Orca discovered per agent. */
  models?: Record<string, AgentModels> | null
  /** Models an agent's own CLI listed just now (see MODEL_LISTERS); these win. */
  live?: Record<string, LiveModel[]>
}

/**
 * The agents to offer, as Orca's own agent picker does: those not turned off in the person's
 * Orca profile whose command is installed (their own command, when they set one), and any other
 * agent Orca discovered models for. An agent a project's settings already use is kept, so saving
 * never drops it, and marked unavailable. Models and their efforts come from what the agent lists
 * now, else what Orca discovered; with neither, the list is empty and a model id can be typed.
 */
export async function agentOptions(inUse: readonly string[] = [], sources: AgentSources = {}): Promise<AgentOption[]> {
  const found = sources.found ?? onPath
  const disabled = new Set(sources.profile?.disabledAgents ?? [])
  const option = async (a: CatalogEntry): Promise<AgentOption> => {
    const override = sources.profile?.commandOverrides[a.id]?.trim().split(/\s+/)[0]
    const discovered = sources.models?.[a.id]
    let models = (discovered?.models ?? []).map((m) => ({ id: m.id, label: m.label, efforts: m.efforts }))
    const live = sources.live?.[a.id]
    if (live?.length) {
      // What the agent lists now is what is available; Orca's copy fills in what it lacks.
      const known = new Map(models.map((m) => [m.id, m]))
      models = live.map((m) => {
        const old = known.get(m.id)
        return { id: m.id, label: m.label !== m.id.slice(m.id.indexOf('/') + 1) || !old ? m.label : old.label, efforts: m.efforts.length ? m.efforts : (old?.efforts ?? []) }
      })
    }
    // Orca found this agent's models by running it, so it is installed even off Matriarch's list.
    const known = AGENT_CATALOG.some((c) => c.id === a.id)
    return {
      id: a.id,
      label: a.label,
      installed: !disabled.has(a.id) && ((!known && Boolean(discovered?.models.length)) || (await found(override || a.command).catch(() => false))),
      lockable: LOCKABLE_AGENTS.includes(a.id),
      takesModel: a.takesModel === true,
      models,
      efforts: a.efforts ?? [],
      defaultModel: discovered?.configured?.model ?? discovered?.models.find((m) => m.isDefault)?.id ?? null,
      defaultEffort: discovered?.configured?.effort ?? null
    }
  }
  const used = new Set(inUse)
  const extraIds = new Set([...used, ...Object.keys(sources.models ?? {})].filter((id) => !AGENT_CATALOG.some((a) => a.id === id)))
  const extra = [...extraIds].map((id): CatalogEntry => ({ id, label: id, command: id, takesModel: Boolean(sources.models?.[id]?.models.length) }))
  const all = await Promise.all([...AGENT_CATALOG, ...extra].map(option))
  return all.filter((a) => a.installed || used.has(a.id))
}
