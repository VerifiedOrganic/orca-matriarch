// Matriarch's engine host. The status bar item keeps this worker running while the plugin is
// enabled, so it polls on its own. Everything durable lives in orca.storage.
import { access, mkdir, readFile, rename, writeFile, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { JsonValue } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import { AGENT_CATALOG, agentOptions, MODEL_LISTERS, parseModelList, type LiveModel } from './agents.ts'
import { readModelCatalog, readOrcaProfile } from './orca-profile.ts'
import { CONFIG_OFF_PATH, CONFIG_PATH, defaultConfig, forgeSettingOf, parseConfig, validateConfig, type ForgeSetting, type MatriarchConfig } from './config.ts'
import { createCrew, launchedTerminal, type Crew } from './crew.ts'
import { branchName, tick, type ActivityInfo, type EngineDeps, type RepoInfo, type Workspace } from './engine.ts'
import { nodeExec, type Exec } from './exec.ts'
import { createExecutor } from './executor.ts'
import { forgeTerms, gitlabRef, parseRemote, repoKey, type ForgeReader, type RepoRef } from './forge.ts'
import { createGitHub, parseGitHubRemote, type GitHub, type PrSnapshot } from './github.ts'
import { createGitLab } from './gitlab.ts'
import { ledgerKey, loadLedger, record, roundsUsed } from './ledger.ts'
import { createdTerminal, createOrcaCli, listWorkers, OrcaRefusal, OrcaUnavailable, sendMessage, type OrcaCli } from './orca-cli.ts'
import { selectReviewers, type Activity, type Lane } from './plan.ts'
import { findTaggedRun, supervisorBrief, supervisorLaunchArgs, supervisorTag, workerSettingsMessage } from './supervisor.ts'
import { emptyBoard, type Board, type ProjectInfo } from './protocol.ts'

export interface WorkerOptions {
  /** Orca's data folder, for the person's profile and model catalog; Orca's default when unset. */
  orcaDataDir?: string
  exec?: Exec
  github?: GitHub
  gitlab?: ForgeReader
  orcaCli?: OrcaCli
  now?: () => number
  /** Start polling on activate (tests turn it off and call board.refresh). */
  autoStart?: boolean
  crew?: Crew
}

// The read-only guard lives in guard.ts; re-exported for the tests and callers that used it here.
export { reviewGuard } from './guard.ts'
import { reviewGuard } from './guard.ts'
import { createLockdown } from './lockdown.ts'

const DISK_FULL = 'The disk is full:'
/** The Orca release Matriarch is built and tested against (package.json's config.orcaVersion). */
export const TESTED_ORCA = '1.4.257'
export const PLUGIN_VERSION = '0.1.0'

let stop: (() => void) | null = null

/** Runs async jobs one after another, in call order; a failing job does not block the next. */
export function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
}

/** Activity older than this is not trusted after a restart: the agent may have moved on. */
export const ACTIVITY_TRUST_MS = 30 * 60_000

/** Per agent pane state, folded into one activity per workspace. */
export class ActivityTracker {
  private panes = new Map<string, { workspaceId: string; state: Activity; at: number; restored?: boolean }>()

  /** True when something changed (so it is worth saving). */
  note(paneKey: string, workspaceId: string | null, state: Activity, at: number): boolean {
    if (!workspaceId) return false
    const prev = this.panes.get(paneKey)
    if (prev && prev.state === state && prev.workspaceId === workspaceId && !prev.restored) return false
    this.panes.set(paneKey, { workspaceId, state, at })
    // Panes nobody has heard from in a day are gone.
    for (const [k, p] of this.panes) if (at - p.at > 24 * 3600_000) this.panes.delete(k)
    return true
  }

  serialize(): Record<string, { workspaceId: string; state: Activity; at: number }> {
    return Object.fromEntries(this.panes)
  }

  /** Fills in what an earlier run saw, keeping anything heard since and dropping stale entries. */
  restore(saved: unknown, now: number, trustMs = ACTIVITY_TRUST_MS): void {
    if (typeof saved !== 'object' || saved === null) return
    for (const [paneKey, v] of Object.entries(saved as Record<string, { workspaceId?: unknown; state?: unknown; at?: unknown }>)) {
      if (this.panes.has(paneKey) || typeof v?.workspaceId !== 'string' || typeof v.at !== 'number') continue
      if (now - v.at > trustMs) continue
      if (!['working', 'waiting', 'blocked', 'done', 'unknown'].includes(String(v.state))) continue
      this.panes.set(paneKey, { workspaceId: v.workspaceId, state: v.state as Activity, at: v.at, restored: true })
    }
  }

  /**
   * One activity for a workspace. A state restored after a restart is trusted only for a while:
   * its agent may have finished while the plugin was down, and that "done" was never heard.
   */
  forWorkspace(workspaceId: string, now = Date.now(), path?: string): ActivityInfo | null {
    // Agent events name a worktree `<repoId>::<path>`; Orca's workspace list may name it by identity.
    const ours = (id: string) => id === workspaceId || (path !== undefined && id.endsWith(`::${path}`))
    const mine = [...this.panes.values()].filter((p) => ours(p.workspaceId) && !(p.restored && now - p.at > ACTIVITY_TRUST_MS))
    if (mine.length === 0) return null
    const pick = (s: Activity) => mine.filter((p) => p.state === s).sort((a, b) => a.at - b.at)[0]
    const chosen = pick('working') ?? pick('waiting') ?? pick('blocked') ?? mine.sort((a, b) => b.at - a.at)[0]
    return { activity: chosen.state, since: chosen.at, agent: null }
  }
}

const SUMMARY: { lanes: Lane[]; label: string }[] = [
  { lanes: ['needs-you'], label: 'need you' },
  { lanes: ['fixing-ci', 'fixing-conflict', 'fixing-review'], label: 'fixing' },
  { lanes: ['ai-review'], label: 'in review' },
  { lanes: ['working', 'building', 'awaiting-ci'], label: 'running' },
  { lanes: ['ready', 'merging'], label: 'ready' }
]

export function statusText(board: Board): { text: string; tooltip: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' } {
  const count = (lanes: Lane[]) => board.tracks.filter((t) => lanes.includes(t.lane)).length
  const parts = SUMMARY.map((s) => ({ ...s, n: count(s.lanes) })).filter((s) => s.n > 0)
  const needYou = count(['needs-you'])
  const fixing = count(['fixing-ci', 'fixing-conflict', 'fixing-review'])
  const text = parts.length === 0 ? 'Matriarch' : `Matriarch ${parts.map((p) => `${p.n} ${p.label}`).join(' · ')}`
  const mode = board.autopilot ? 'Autopilot on' : 'Dry run: watching, not acting'
  const attention = board.attention ?? []
  const tooltip = [
    ...(attention.length ? [`Needs you: ${attention[0].message}`, 'Click to open it.'] : []),
    mode,
    ...board.repos.map((r) => `${r.repo} (${r.mergeMode} merge)`),
    ...board.errors
  ].join('\n')
  const tone = needYou > 0 || attention.length > 0 ? 'danger' : fixing > 0 ? 'warning' : count(['ready']) > 0 ? 'success' : board.autopilot ? 'accent' : 'neutral'
  return { text: board.autopilot ? text : `${text} (dry run)`, tooltip, tone }
}

/** Why a project cannot be followed when its origin names no forge at all. */
export const NO_FORGE = 'Its origin is not on GitHub or GitLab, so Matriarch cannot follow its pull requests.'

/**
 * The forge a remote is on. github.com is GitHub. Another host is GitLab when the project's own
 * settings say so (also naming the host, for an ssh alias), or when glab is signed in to it.
 * Otherwise the reason, with what to run.
 */
export async function detectForge(
  url: string,
  setting: ForgeSetting | null,
  signedIn: (host: string) => Promise<boolean>
): Promise<{ ref: RepoRef } | { problem: string }> {
  // github.com is never a GitLab, unless the setting names the GitLab host that mirrors it.
  const github = parseGitHubRemote(url)
  if (github && !(setting?.kind === 'gitlab' && setting.host)) return { ref: github }
  const remote = parseRemote(url)
  if (!remote) return { problem: NO_FORGE }
  if (setting?.kind === 'gitlab') return { ref: gitlabRef(setting.host ?? remote.host, remote.path) }
  if (setting?.kind === 'github') return { problem: `Its settings say GitHub, but its origin is on ${remote.host}; Matriarch reads GitHub only on github.com.` }
  if (await signedIn(remote.host)) return { ref: gitlabRef(remote.host, remote.path) }
  return {
    problem: `Its origin is on ${remote.host}, which is neither GitHub nor a GitLab host glab is signed in to. If it is a GitLab, run glab auth login --hostname ${remote.host}, then look again.`
  }
}

/** Finds the project behind a workspace and the forge it is on; `problem` says why there is none. */
export interface RepoResolver {
  (path: string): Promise<RepoInfo | null>
  problem(path: string): Promise<string | null>
}

export function createRepoResolver(exec: Exec, readText: (path: string) => Promise<string | null> = (p) => readFile(p, 'utf8').catch(() => null)): RepoResolver {
  const cache = new Map<string, Promise<{ info: RepoInfo | null; problem: string | null }>>()
  const hosts = new Map<string, Promise<boolean>>()
  const git = async (cwd: string, args: string[]) => {
    const res = await exec('git', ['-C', cwd, ...args], { timeoutMs: 15_000 })
    return res.code === 0 ? res.stdout.trim() : null
  }
  // Only glab's exit code is read: it signs in and keeps the token, and nothing it prints is kept.
  const signedIn = (host: string): Promise<boolean> => {
    let known = hosts.get(host)
    if (!known) {
      known = exec('glab', ['auth', 'status', '--hostname', host], { timeoutMs: 15_000 }).then((r) => r.code === 0, () => false)
      hosts.set(host, known)
    }
    return known
  }
  /** The forge the project's own settings name, on or kept aside while it is off. */
  const settingAt = async (root: string): Promise<ForgeSetting | null> => {
    for (const file of [CONFIG_PATH, CONFIG_OFF_PATH]) {
      const text = await readText(join(root, file))
      if (text === null) continue
      try {
        return forgeSettingOf(JSON.parse(text))
      } catch {
        return null
      }
    }
    return null
  }
  const lookup = (path: string) => {
    let hit = cache.get(path)
    if (!hit) {
      hit = (async () => {
        const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const url = await git(path, ['config', '--get', 'remote.origin.url'])
        if (!common || !url) return { info: null, problem: NO_FORGE }
        // A worktree's common dir is the main checkout's .git; a bare repository has no checkout.
        const root = basename(common) === '.git' ? dirname(common) : path
        const found = await detectForge(url, await settingAt(root), signedIn)
        return 'ref' in found ? { info: { ref: found.ref, key: repoKey(found.ref), root }, problem: null } : { info: null, problem: found.problem }
      })()
      cache.set(path, hit)
    }
    return hit
  }
  return Object.assign((path: string) => lookup(path).then((r) => r.info), { problem: (path: string) => lookup(path).then((r) => r.problem) })
}

export function createWorker(options: WorkerOptions = {}) {
  return function activate(orca: OrcaWorkerApi): void {
    const exec = options.exec ?? nodeExec
    // Asked once: which Orca this is, to say when it is not the one Matriarch was tested with.
    let orcaVersionAsked: Promise<string | null> | null = null
    const orcaVersionOnce = (): Promise<string | null> =>
      (orcaVersionAsked ??= exec('orca', ['--version'], { timeoutMs: 10_000 }).then(
        (r) => (r.code === 0 ? (r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null),
        () => null
      ))
    const now = options.now ?? Date.now
    const cli = options.orcaCli ?? createOrcaCli(exec)
    // One client per forge reads and acts, so GitHub's change probes are shared by both.
    const githubForge = createGitHub(exec, now)
    const gitlabForge = createGitLab(exec, now)
    const github = options.github ?? githubForge
    const gitlab = options.gitlab ?? gitlabForge
    const activity = new ActivityTracker()
    const lockdown = createLockdown(now, { get: (k) => orca.storage.get(k), set: (k, v) => orca.storage.set(k, v) })
    const crew =
      options.crew ??
      createCrew({
        orca: cli,
        exec,
        now,
        lockdown,
        log: (m) => orca.log(m),
        store: orca.storage,
        readFile: async (path) => {
          try {
            return await readFile(path, 'utf8')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          }
        },
        // A reviewer stuck on a prompt: tell the person, and mark the worktree in Orca's own sidebar.
        alert: async (run, r) => {
          const message = `The ${r.name} reviewer (${r.agent}) on #${run.number} needs you: ${r.blocked}`
          await orca.host.call('notifications.show', { title: `Matriarch: ${run.repo} #${run.number} needs you`, body: message }).catch(() => {})
          if (run.worktree) await cli.run(['worktree', 'set', '--worktree', `path:${run.worktree.path}`, '--unread', '--comment', `Matriarch: ${message}`]).catch(() => {})
          void runTick()
        },
        workspaceIdFor: async (path) => {
          // A new worktree can take a moment to show up in Orca's list.
          for (let i = 0; i < 5; i++) {
            const { workspaces } = await orca.host.call('workspace.list')
            const hit = (workspaces as Workspace[]).find((w) => w.path === path)
            if (hit) return hit.id
            await new Promise((r) => setTimeout(r, 400))
          }
          return null
        }
      })
    void crew.load()
    orca.hooks.on('agent.tool.before', (event) => reviewGuard(event, crew.guard()) ?? undefined)
    // Reviewers start in their agent's own read-only mode; every other launch passes untouched.
    orca.hooks.on('agent.launch.before', (event, next) => {
      const result = lockdown.onLaunch(event, crew.guard())
      if (!result) return undefined
      if ('deny' in result) {
        orca.log(`refused ${event.agent} in review worktree ${event.workspaceId}: ${result.deny}`)
        return { deny: result.deny }
      }
      orca.log(`started ${event.agent} read-only (${result.mode}) in ${event.workspaceId}`)
      return next({ ...event, command: result.command })
    })
    let repoOf = createRepoResolver(exec)
    let board = emptyBoard(now())
    let timer: ReturnType<typeof setTimeout> | null = null
    let running: Promise<void> | null = null
    let again = false
    let stopped = false
    let failures = 0
    // One writer at a time: a tick and a panel action never read-modify-write storage together.
    const exclusive = serial()

    // Survive restarts: save what agents are doing (debounced) and read it back on start.
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const saveActivity = () => {
      if (saveTimer) return
      saveTimer = setTimeout(() => {
        saveTimer = null
        void orca.storage.set('activity', activity.serialize() as unknown as JsonValue).catch(() => {})
      }, 2_000)
    }
    void orca.storage.get('activity').then((saved) => activity.restore(saved, now()), () => {})

    orca.events.on('agent.status.changed', (e) => {
      if (activity.note(e.paneKey, e.workspaceId, e.state, e.receivedAt)) saveActivity()
      // A worker that just finished a turn may have pushed: look soon, not at the next poll.
      if (e.state !== 'working') schedule(3_000)
    })
    const resetRepos = () => {
      repoOf = createRepoResolver(exec)
      schedule(2_000)
    }
    orca.events.on('workspace.created', resetRepos)
    orca.events.on('workspace.removed', resetRepos)

    /**
     * Matriarch's mailbox in a project: a terminal of its own in the main checkout, which Orca
     * accepts as the sender of orchestration mail. It runs `cat > /dev/null`, so anything Orca
     * types into it (a reply) is swallowed, never run by a shell. Reused while it lives.
     */
    const mailboxes = new Map<string, Promise<string | null>>()
    const mailboxFor = (repo: string, root: string): Promise<string | null> => {
      const known = mailboxes.get(repo)
      if (known) return known
      const made = (async () => {
        const saved = await orca.storage.get(`mailbox:${repo}`)
        if (typeof saved === 'string' && (await cli.run(['terminal', 'show', '--terminal', saved]).then(() => true, () => false))) return saved
        const handle = createdTerminal(
          await cli.run(['terminal', 'create', '--worktree', `path:${root}`, '--title', 'Matriarch mailbox', '--command', 'cat > /dev/null']).catch(() => null)
        )
        if (handle) await orca.storage.set(`mailbox:${repo}`, handle)
        return handle
      })()
      mailboxes.set(repo, made)
      // A failed or closed mailbox is looked up again next time.
      void made.then((h) => { if (!h) mailboxes.delete(repo) })
      return made
    }

    const deps: EngineDeps = {
      now,
      log: (m) => orca.log(m),
      workspaces: async () => (await orca.host.call('workspace.list')).workspaces as Workspace[],
      repoOf: (path) => repoOf(path),
      readConfig: async (root) => {
        try {
          return parseConfig(await readFile(join(root, CONFIG_PATH), 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      github,
      gitlab,
      // Failures surface to the engine, which then sends nothing to workers rather than guess.
      workers: () => listWorkers(cli),
      activity: (id, path) => activity.forWorkspace(id, now(), path),
      supervisor: async (repo) => {
        const v = await orca.storage.get(`supervisor:${repo}`)
        return typeof v === 'string' && v ? v : null
      },
      findRun: async (tag) => findTaggedRun(await cli.run(['orchestration', 'run-list', '--limit', '50']), tag),
      runExists: async (id) => {
        const r = (await cli.run(['orchestration', 'run-list', '--limit', '100'])) as { runs?: { id?: string }[] }
        return (r.runs ?? []).some((x) => x.id === id)
      },
      terminalGone: async (handle) => {
        // A chat is not a terminal: Orca calls a live chat's handle stale too, so a chat is never
        // judged gone here. An abandoned one stops counting after 6 hours, or with New chat.
        if (handle.startsWith('structured-agent-session')) return false
        try {
          await cli.run(['terminal', 'show', '--terminal', handle])
          return false
        } catch (error) {
          // Only Orca saying so counts: an unreachable runtime proves nothing.
          return error instanceof OrcaRefusal && ['terminal_handle_stale', 'terminal_not_found'].includes(error.code)
        }
      },
      store: orca.storage,
      crew,
      freeSpace: async (path) => {
        const s = await statfs(path)
        return Number(s.bavail) * Number(s.bsize)
      },
      removeWorktree: async (path) => {
        // Only a clean worktree goes: anything uncommitted, even an untracked file, keeps it.
        const status = await exec('git', ['-C', path, 'status', '--porcelain'], { timeoutMs: 15_000 })
        if (status.code !== 0) return { removed: false, reason: 'git status failed there' }
        if (status.stdout.trim()) return { removed: false, reason: 'it has uncommitted changes' }
        await cli.run(['worktree', 'rm', '--worktree', `path:${path}`, '--delete-branch'])
        return { removed: true }
      },
      executor: createExecutor({
        exec,
        orca: cli,
        crew,
        forges: { github: githubForge, gitlab: gitlabForge },
        mailbox: (ctx) => mailboxFor(ctx.pr.repo, ctx.root),
        notify: async (title, body) => {
          await orca.host.call('notifications.show', { title, body })
        }
      })
    }

    async function pollSeconds(): Promise<number> {
      const v = await orca.settings.get('pollSeconds')
      return typeof v === 'number' && v >= 15 ? v : 45
    }

    async function runTick(): Promise<void> {
      if (running) {
        again = true
        return running
      }
      running = (async () => {
        try {
          const isOn = async () => (await orca.settings.get('autopilot')) === true
          // Read the switch only once the lock is ours, and again before every action: a pause
          // takes effect at once, not after a tick that started before it.
          const next = await exclusive(async () => tick(deps, { autopilot: await isOn(), stillOn: isOn }))
          // Orca accepts only plain JSON from a worker: drop undefined fields once, here.
          board = JSON.parse(JSON.stringify(next)) as Board
          // Back off while Orca or a forge keeps failing (rate limits included), not only when the board is empty.
          const trouble = (board.errors.length > 0 && board.tracks.length === 0) || board.repos.some((r) => r.errors.some((e) => /^(GitHub|GitLab):/.test(e)))
          failures = trouble ? failures + 1 : 0
          postBoard(board)
          const s = statusText(board)
          await orca.host.call('statusBar.update', { id: 'summary', text: s.text, tooltip: s.tooltip, tone: s.tone }).catch(() => {})
        } catch (error) {
          failures++
          orca.log(`tick failed: ${(error as Error).stack ?? String(error)}`)
          // A full disk fails the save, so no new board comes: say what is wrong on the old one.
          // The next good check replaces it.
          if ((error as NodeJS.ErrnoException).code === 'ENOSPC' || /ENOSPC/.test(String(error))) {
            board = { ...board, errors: [...board.errors.filter((e) => !e.startsWith(DISK_FULL)), `${DISK_FULL} Matriarch cannot save its state and agents' builds fail. Free some space; it carries on by itself.`] }
            postBoard(board)
            await orca.host.call('statusBar.update', { id: 'summary', text: 'Matriarch: disk full', tooltip: DISK_FULL, tone: 'danger' }).catch(() => {})
          }
        } finally {
          running = null
        }
      })()
      await running
      if (again) {
        again = false
        await runTick()
      }
    }

    // A post over 256 KiB is refused: trim history and findings detail until it fits.
    function postBoard(b: Board): void {
      let payload = b
      if (JSON.stringify(payload).length > 240_000) {
        payload = {
          ...b,
          tracks: b.tracks.map((t) => ({
            ...t,
            segments: t.segments.slice(-60),
            marks: t.marks.slice(-40),
            review: t.review ? { ...t.review, findings: t.review.findings?.slice(0, 20).map((f) => ({ ...f, detail: f.detail.slice(0, 200), suggestion: '' })) } : null
          }))
        }
      }
      try {
        orca.panels.post('board.changed', payload)
      } catch (error) {
        orca.log(`board post refused: ${(error as Error).message}`)
      }
    }

    function schedule(ms?: number): void {
      if (stopped) return
      if (timer) clearTimeout(timer)
      void (async () => {
        const base = ms ?? (await pollSeconds()) * 1000
        // Back off while ticks keep failing (Orca, GitHub or GitLab unreachable), up to 10 minutes.
        const delay = ms ?? Math.min(base * 2 ** Math.min(failures, 4), 600_000)
        timer = setTimeout(async () => {
          await runTick()
          schedule()
        }, delay)
      })()
    }

    orca.panels.handle('board.get', () => board)
    orca.panels.handle('board.refresh', async () => {
      await runTick()
      return board
    })
    orca.panels.handle('autopilot.set', async ({ on }) => {
      await orca.settings.set('autopilot', on)
      await runTick()
      return board
    })
    orca.panels.handle('terminal.focus', async ({ handle }) => {
      try {
        await cli.run(['terminal', 'switch', '--terminal', handle])
        return { opened: true }
      } catch (error) {
        orca.log(`terminal switch ${handle}: ${(error as Error).message}`)
        return { opened: false }
      }
    })
    orca.panels.handle('track.open', async ({ key }) => {
      await orca.host.call('workspace.open', { workspaceId: key })
      return { opened: true }
    })

    // Opens the supervisor as a native Orca chat, briefed: the person describes the work there.
    orca.panels.handle('supervisor.start', async ({ repo, objective }) => {
      const repoView = board.repos.find((r) => r.repo === repo)
      if (!repoView) return { started: false, message: `${repo} has not opted in (no ${CONFIG_PATH})` }
      if (repoView.empty) return { started: false, message: `This project has no commits on ${forgeTerms(repoView.forge).name} yet. Push a first commit to main, then start the supervisor.` }
      const cfg = await deps.readConfig(repoView.root)
      if (!cfg) return { started: false, message: `${CONFIG_PATH} is missing` }
      // The base branch PRs target: origin's HEAD, else main.
      const head = await exec('git', ['-C', repoView.root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 10_000 })
      const base = head.code === 0 && head.stdout.trim().startsWith('origin/') ? head.stdout.trim().slice('origin/'.length) : 'main'
      const tag = supervisorTag(repo, now().toString(36))
      const sup = cfg.config.supervisor
      const ref = (await repoOf(repoView.root).catch(() => null))?.ref
      const brief = supervisorBrief({ repo, root: repoView.root, objective: objective ?? '', tag, base, config: cfg.config, forge: repoView.forge, host: ref?.host })
      let receipt: unknown
      try {
        receipt = await cli.run(supervisorLaunchArgs(sup, repoView.root, brief, 'chat'))
      } catch (error) {
        // An agent Orca cannot open as a chat still runs as a terminal session.
        try {
          receipt = await cli.run(supervisorLaunchArgs(sup, repoView.root, brief, 'terminal'))
        } catch {
          return { started: false, message: `Could not start the supervisor: ${(error as Error).message}` }
        }
      }
      const terminal = launchedTerminal(receipt)
      await exclusive(async () => {
        await orca.storage.delete(`supervisor:${repo}`)
        if (terminal) await orca.storage.set(`supervisor:terminal:${repo}`, terminal)
        else await orca.storage.delete(`supervisor:terminal:${repo}`)
        await orca.storage.set(`supervisor:pending:${repo}`, { tag, at: now() })
      })
      void runTick()
      return { started: true, message: `Supervisor chat opened (${sup.agent}${sup.model ? ` ${sup.model}` : ''}). Tell it what to build there.` }
    })

    // Brings the supervisor's chat back: its tab when known, else its workspace.
    orca.panels.handle('supervisor.open', async ({ repo }) => {
      const handle = await orca.storage.get(`supervisor:terminal:${repo}`)
      if (typeof handle === 'string' && (await cli.run(['terminal', 'switch', '--terminal', handle]).then(() => true, () => false))) return { opened: true }
      const root = board.repos.find((r) => r.repo === repo)?.root
      const { workspaces } = await orca.host.call('workspace.list')
      const ws = (workspaces as Workspace[]).find((w) => w.path === root)
      if (!ws) return { opened: false }
      await orca.host.call('workspace.open', { workspaceId: ws.id })
      return { opened: true }
    })

    // A review round on demand, in dry run too: the crew runs and the board shows its verdict;
    // sending findings to a worker or posting on the PR still waits for autopilot.
    orca.panels.handle('review.start', async ({ repo, number }) => {
      const repoView = board.repos.find((r) => r.repo === repo)
      if (!repoView) return { started: false, message: `${repo} has not opted in (no ${CONFIG_PATH})` }
      const cached = (await orca.storage.get(`snap:${repo}#${number}`)) as { snap?: PrSnapshot } | null
      const pr = cached?.snap
      if (!pr) return { started: false, message: `#${number} has not been read yet; refresh first` }
      const cfg = await deps.readConfig(repoView.root)
      if (!cfg || cfg.config.reviewers.length === 0) return { started: false, message: 'no reviewers configured' }
      const track = board.tracks.find((t) => t.repo === repo && t.pr?.number === number)
      const { reviewers } = selectReviewers(cfg.config, track?.owner?.agent ?? null)
      const key = ledgerKey(repo, number)
      const before = loadLedger(await orca.storage.get(key))
      const rec = before.reviews[pr.headSha]
      if (rec?.status === 'running') return { started: false, message: `review round ${rec.round} is already running` }
      const round = rec ? rec.round : roundsUsed(before, 'reviews') + 1
      // Starting takes a while (fetch, worktree, launches); hold the lock only for the ledger write.
      // A tick in between cannot start a second round: crew.start answers the running one.
      const run = await crew.start({ pr, root: repoView.root, config: cfg.config, round, reviewers })
      if (run.status === 'failed') return { started: false, message: `review crew: ${run.error ?? 'failed'}` }
      await exclusive(async () => {
        const ledger = record(loadLedger(await orca.storage.get(key)), { kind: 'start-review', sha: pr.headSha, round, reviewers }, now())
        await orca.storage.set(key, ledger as unknown as JsonValue)
      })
      void runTick()
      return { started: true, message: `review round ${round} started: ${run.reviewers.map((r) => `${r.name} (${r.agent}${r.model ? ` ${r.model}` : ''})`).join(', ')}` }
    })

    // Projects: turned on and set up from the panel. The settings live in the project's
    // .orca/matriarch.json, which the panel writes; nobody has to edit it by hand.
    const exists = (p: string) => access(p).then(() => true, () => false)
    const writeConfig = async (root: string, config: MatriarchConfig) => {
      await mkdir(join(root, '.orca'), { recursive: true })
      await writeFile(join(root, CONFIG_PATH), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    }
    const rootOf = (repo: string) => board.repos.find((r) => r.repo === repo)?.root ?? null
    const readText = (path: string) => readFile(path, 'utf8').catch(() => null)
    const profile = () => readOrcaProfile(exec, readText, options.orcaDataDir)

    /**
     * The project of the workspace focused in Orca. Orca tells a plugin only the focused
     * workspace's name, branch and terminals, so it is matched by name and branch, and two
     * checkouts that match alike (both "main") are told apart by their terminals.
     */
    orca.panels.handle('project.focused', async () => {
      const ctx = await orca.host.call('workspace.readContext').catch(() => null)
      const none = { repo: null, root: null, enabled: false, name: null, candidates: [] as string[] }
      if (!ctx) return none
      const { workspaces } = await orca.host.call('workspace.list')
      const local = (workspaces as Workspace[]).filter((w) => !w.hostId || w.hostId === 'local')
      let matches = local.filter((w) => w.name === ctx.displayName && branchName(w.branch) === branchName(ctx.branch))
      // Orca's own record of the focused workspace settles it. It is saved a moment after the
      // focus moves, so a record that fits none of the matches is read again shortly.
      for (let attempt = 0; matches.length > 1 && attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400))
        const active = (await profile())?.activeWorktreeId
        const hit = active ? matches.find((w) => w.id === active || active.endsWith(`::${w.path}`)) : undefined
        if (hit) matches = [hit]
        else if (!active) break
      }
      if (matches.length > 1) {
        const want = new Set(ctx.terminals.map((t) => t.id))
        const scored = await Promise.all(matches.map(async (w) => {
          const listed = (await cli.run(['terminal', 'list', '--worktree', `path:${w.path}`]).catch(() => ({}))) as { terminals?: { handle?: string; id?: string }[] }
          const ids = (listed.terminals ?? []).flatMap((t) => [t.handle, t.id]).filter((x): x is string => typeof x === 'string')
          return { w, count: (listed.terminals ?? []).length, shared: ids.filter((id) => want.has(id)).length }
        }))
        const sharing = scored.filter((x) => x.shared > 0)
        matches = sharing.length > 0 ? sharing.map((x) => x.w) : want.size === 0 ? scored.filter((x) => x.count === 0).map((x) => x.w) : matches
      }
      if (matches.length > 1) {
        // Still alike: the agents in the focused workspace name it through their sessions.
        const { agents } = await orca.host.call('agents.list').catch(() => ({ agents: [] }))
        const paths = new Set<string>()
        for (const a of agents) {
          if (!a.terminalId) continue
          const shown = (await cli.run(['terminal', 'show', '--terminal', a.terminalId]).catch(() => null)) as Record<string, unknown> | null
          const text = JSON.stringify(shown ?? {})
          for (const w of matches) if (text.includes(`"${w.path}"`) || text.includes(`::${w.path}"`)) paths.add(w.path)
        }
        if (paths.size === 1) matches = matches.filter((w) => paths.has(w.path))
      }
      const found = new Map<string, string>()
      for (const info of await Promise.all(matches.map((w) => repoOf(w.path).catch(() => null)))) if (info) found.set(info.key, info.root)
      if (found.size !== 1) return { ...none, name: ctx.displayName, candidates: [...found.keys()].sort() }
      const [[repo, root]] = [...found]
      // On means its settings file is there; the board can still be empty right after a reload.
      return { repo, root, enabled: await exists(join(root, CONFIG_PATH)), name: ctx.displayName, candidates: [repo] }
    })

    orca.panels.handle('projects.list', async () => {
      // Each look starts afresh, so a GitLab host glab was signed in to since then shows up.
      repoOf = createRepoResolver(exec)
      const listed = (await cli.run(['repo', 'list'])) as { repos?: { path?: unknown; displayName?: unknown }[] }
      const projects: ProjectInfo[] = []
      for (const r of listed.repos ?? []) {
        if (typeof r.path !== 'string' || !(await exists(r.path))) continue // not on this machine
        const info = await repoOf(r.path).catch(() => null)
        const root = info?.root ?? r.path
        let problem: string | null = null
        if (!info) problem = (await repoOf.problem(r.path).catch(() => null)) ?? NO_FORGE
        else if ((await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 10_000 })).code !== 0) {
          problem = 'It has no commits yet. Commit and push a first version to main before starting a supervisor.'
        }
        projects.push({ root, name: typeof r.displayName === 'string' && r.displayName ? r.displayName : basename(root), repo: info?.key ?? null, enabled: await exists(join(root, CONFIG_PATH)), problem })
      }
      return { projects }
    })

    orca.panels.handle('project.enable', async ({ root }) => {
      const info = await repoOf(root).catch(() => null)
      if (!info) return { ok: false, message: (await repoOf.problem(root).catch(() => null)) ?? NO_FORGE, repo: null }
      const on = join(info.root, CONFIG_PATH)
      const off = join(info.root, CONFIG_OFF_PATH)
      if (!(await exists(on))) {
        // Turned off before: its settings come back as they were.
        if (await exists(off)) await rename(off, on)
        else await writeConfig(info.root, defaultConfig())
      }
      await runTick()
      return { ok: true, message: `Matriarch is on for ${info.key}.`, repo: info.key }
    })

    orca.panels.handle('project.disable', async ({ repo }) => {
      const root = rootOf(repo)
      if (!root) return { ok: false, message: `${repo} is not on.` }
      await rename(join(root, CONFIG_PATH), join(root, CONFIG_OFF_PATH))
      await runTick()
      return { ok: true, message: `Matriarch is off for ${repo}; its settings are kept for when you turn it on again.` }
    })

    orca.panels.handle('config.get', async ({ repo }) => {
      const root = rootOf(repo)
      const cfg = root ? await deps.readConfig(root) : null
      const config = cfg?.config ?? defaultConfig()
      const inUse = [config.supervisor.agent, config.workers.default.agent, ...Object.values(config.workers.tiers).map((t) => t.agent), ...config.reviewers.map((r) => r.agent)]
      const [person, models] = await Promise.all([profile(), readModelCatalog(exec, options.orcaDataDir)])
      // Agents that can list their models now are asked: every provider the person signed in to.
      const live: Record<string, LiveModel[]> = {}
      await Promise.all(Object.entries(MODEL_LISTERS).map(async ([id, tries]) => {
        if (person?.disabledAgents.includes(id)) return
        const command = person?.commandOverrides[id]?.trim().split(/\s+/)[0] || AGENT_CATALOG.find((a) => a.id === id)?.command
        if (!command) return
        for (const args of tries) {
          const res = await exec(command, [...args], { timeoutMs: 15_000 }).catch(() => null)
          const models = res?.code === 0 ? parseModelList(res.stdout) : []
          if (models.length) {
            live[id] = models
            return
          }
        }
      }))
      // Matriarch reads two of Orca's own files (see orca-profile.ts); say when that stops working.
      const notes: string[] = []
      if (!person) notes.push('Matriarch could not read your Orca profile, so this list may include agents you turned off in Orca.')
      if (!models) notes.push("Matriarch could not read the models Orca discovered: type a model id, or leave the agent's default.")
      const orcaVersion = await orcaVersionOnce()
      if (orcaVersion && orcaVersion !== TESTED_ORCA) notes.push(`Matriarch ${PLUGIN_VERSION} was tested with Orca ${TESTED_ORCA}, and this is Orca ${orcaVersion}. If something here looks wrong, check for a Matriarch update.`)
      const reply = { config, errors: cfg?.errors ?? [`${repo} is not on`], warnings: [...(cfg?.warnings ?? []), ...notes], agents: await agentOptions(inUse, { profile: person, models, live }) }
      return JSON.parse(JSON.stringify(reply)) as typeof reply
    })

    orca.panels.handle('config.save', async ({ repo, config }) => {
      const root = rootOf(repo)
      if (!root) return { saved: false, errors: [`${repo} is not on.`], warnings: [] }
      const checked = validateConfig(config)
      if (checked.errors.length > 0) return { saved: false, errors: checked.errors, warnings: checked.warnings }
      const before = await deps.readConfig(root).catch(() => null)
      await writeConfig(root, checked.config)
      // A running supervisor got its worker commands in its brief, when its chat began: tell it the
      // new ones, so the next worker it starts runs on the new agent, model and thinking level.
      const run = board.repos.find((r) => r.repo === repo)?.supervisor.run
      if (run && JSON.stringify(before?.config.workers ?? null) !== JSON.stringify(checked.config.workers)) {
        const m = workerSettingsMessage(checked.config)
        await sendMessage(cli, { to: run, subject: m.subject, body: m.body, from: await mailboxFor(repo, root) })
          .catch((error: Error) => orca.log(`${repo}: could not tell the supervisor about the new worker settings: ${error.message}`))
      }
      // The forge setting decides which forge the project is read from: look it up again.
      repoOf = createRepoResolver(exec)
      await runTick()
      return { saved: true, errors: [], warnings: checked.warnings }
    })

    orca.panels.handle('review.restartReviewer', async ({ repo, number, reviewer }) => {
      const repoView = board.repos.find((r) => r.repo === repo)
      if (!repoView) return { restarted: false, message: `${repo} is not on` }
      const pr = ((await orca.storage.get(`snap:${repo}#${number}`)) as { snap?: PrSnapshot } | null)?.snap
      const cfg = await deps.readConfig(repoView.root)
      if (!pr || !cfg) return { restarted: false, message: `#${number} has not been read yet; refresh first` }
      const res = await crew.restart({ pr, config: cfg.config, name: reviewer })
      void runTick()
      return res
    })

    orca.commands.register('toggleAutopilot', async () => {
      const on = (await orca.settings.get('autopilot')) !== true
      await orca.settings.set('autopilot', on)
      void runTick()
      return on ? 'Matriarch autopilot is on: it will act on PRs.' : 'Matriarch is in dry run: it watches and shows what it would do.'
    })
    orca.commands.register('refresh', async () => {
      await runTick()
      return `Matriarch: ${board.tracks.length} worktree(s) in ${board.repos.length} repo(s)`
    })
    // The status bar item: straight to what needs you, else the board.
    orca.commands.register('showBoard', async () => {
      const first = board.attention.find((a) => a.terminal || a.workspaceId)
      if (first?.terminal) {
        const done = await cli.run(['terminal', 'switch', '--terminal', first.terminal]).then(() => true, () => false)
        if (done) return `Matriarch: ${first.message}`
      }
      if (first?.workspaceId) {
        await orca.host.call('workspace.open', { workspaceId: first.workspaceId }).catch(() => {})
        return `Matriarch: ${first.message}`
      }
      await orca.host.call('commands.run', { action: 'sidebar.right.toggle' })
    })

    stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (saveTimer) clearTimeout(saveTimer)
    }
    if (options.autoStart !== false) schedule(1_500)
  }
}

export default createWorker()

export function deactivate(): void {
  stop?.()
  stop = null
}
