// The one place that speaks the `orca` CLI. Every call adds --json and reads Orca's envelope:
// `{"ok":true,"result":…}` or `{"ok":false,"error":{"code":…}}`. A runtime that cannot be reached
// is OrcaUnavailable (wait and retry); anything Orca refused is OrcaRefusal with its code.
import type { Exec } from './exec.ts'

export class OrcaUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcaUnavailable'
  }
}

export class OrcaRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OrcaRefusal'
  }
}

const UNAVAILABLE = new Set(['runtime_unavailable', 'runtime_timeout', 'runtime_not_running'])

export interface OrcaCli {
  run(args: readonly string[], options?: { input?: string; timeoutMs?: number }): Promise<unknown>
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function createOrcaCli(exec: Exec, bin = 'orca'): OrcaCli {
  return {
    async run(args, options = {}) {
      const res = await exec(bin, [...args, '--json'], { input: options.input, timeoutMs: options.timeoutMs ?? 60_000 })
      if (res.code === 127) throw new OrcaUnavailable(`${bin} not found on the PATH Orca gives plugins`)
      let parsed: Obj
      try {
        parsed = obj(JSON.parse(res.stdout))
      } catch {
        throw new OrcaUnavailable(`${bin} ${args[0] ?? ''} gave no JSON (exit ${res.code}): ${res.stderr.slice(0, 300)}`)
      }
      if (parsed.ok === true) return parsed.result
      const error = obj(parsed.error)
      const code = str(error.code) ?? 'unknown'
      const message = str(error.message) ?? `orca ${args.slice(0, 2).join(' ')} failed`
      if (UNAVAILABLE.has(code)) throw new OrcaUnavailable(message)
      throw new OrcaRefusal(code, message)
    }
  }
}

/** One supervised worker, as `orca orchestration worker-list` reports it. */
export interface WorkerRow {
  dispatchId: string
  worktreeId: string | null
  taskId: string | null
  runId: string | null
  agent: string | null
  model: string | null
  state: string | null
  /** False once its agent has exited (a failed or finished attempt); unknown counts as live. */
  live?: boolean
}

/**
 * Reads `worker-list --full` (Orca 1.4.257: `runId`, `resource.worktreeId`, `workerState`,
 * `projection.provider` and `projection.liveness`), and the concise view as a fallback
 * (`workspace` for the worktree, `agent` as "agent/model", `liveness`). Verified live.
 */
export function parseWorkerList(result: unknown): WorkerRow[] {
  const r = obj(result)
  const list = Array.isArray(result) ? result : Array.isArray(r.workers) ? r.workers : Array.isArray(r.rows) ? r.rows : []
  const rows: WorkerRow[] = []
  for (const item of list) {
    const w = obj(item)
    const launch = obj(w.launch)
    const effective = obj(launch.effective)
    const requested = obj(launch.requested)
    const projection = obj(w.projection)
    const provider = obj(projection.provider)
    const dispatchId = str(w.dispatchId) ?? str(projection.dispatchId) ?? str(obj(w.dispatch).id) ?? str(w.id)
    if (!dispatchId) continue
    // The concise view folds agent and model into one "agent/model" string.
    const combined = str(w.agent)
    const cut = combined?.indexOf('/') ?? -1
    const liveness = str(obj(projection.liveness).verdict) ?? str(w.liveness)
    rows.push({
      dispatchId,
      worktreeId: str(obj(w.resource).worktreeId) ?? str(obj(projection.workspace).id) ?? str(w.worktreeId) ?? str(obj(w.worktree).id) ?? str(w.workspace),
      taskId: str(w.taskId) ?? str(obj(w.task).id),
      runId: str(w.runId) ?? str(projection.runId) ?? str(obj(w.run).id),
      agent: str(provider.id) ?? str(effective.agent) ?? str(launch.agent) ?? (combined && cut > 0 ? combined.slice(0, cut) : combined),
      model: str(provider.model) ?? str(w.model) ?? str(effective.model) ?? str(requested.model) ?? (combined && cut > 0 ? combined.slice(cut + 1) : null),
      state: str(w.workerState) ?? str(w.state) ?? str(w.status),
      live: liveness === null ? true : liveness === 'live'
    })
  }
  return rows
}

/** Every supervised worker, following worker-list's pages (100 rows each) up to 1000. */
export async function listWorkers(cli: OrcaCli): Promise<WorkerRow[]> {
  const rows: WorkerRow[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    // --full: the default view leaves out the Run and the worktree each worker owns.
    const result = await cli.run(['orchestration', 'worker-list', '--full', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])])
    rows.push(...parseWorkerList(result))
    const r = obj(result)
    cursor = str(obj(r.page).nextCursor) ?? str(r.nextCursor)
    if (!cursor) break
  }
  return rows
}

/** Delivers a message to a worker (`dispatch:<id>`) or a supervisor's Run (`run:<id>`). */
export async function sendMessage(
  cli: OrcaCli,
  message: { to: string; subject: string; body: string; type?: 'status' | 'escalation'; from?: string | null }
): Promise<void> {
  const args = ['orchestration', 'send', '--to', message.to, '--subject', message.subject, '--body', message.body]
  if (message.type) args.push('--type', message.type)
  // Orca names the sender by its terminal; a plugin has none, so it sends from its own mailbox.
  if (message.from) args.push('--from', message.from)
  await cli.run(args)
}

/** The terminal handle in an `orca terminal create` receipt. */
export function createdTerminal(result: unknown): string | null {
  const r = obj(result)
  return str(obj(r.terminal).handle) ?? str(r.handle) ?? str(r.terminalId)
}
