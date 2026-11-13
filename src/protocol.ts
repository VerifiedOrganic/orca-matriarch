// The worker ⇄ view contract, shared by src/worker.ts and src/view/*. Also the stored shapes
// of a track's history.
import type { MatriarchConfig } from './config.ts'
import type { CiState } from './github.ts'
import type { Activity, Lane } from './plan.ts'

export type { Activity, CiState, Lane }

/** A span of time a worktree spent in one lane. `to` is null while it is still there. */
export interface Segment {
  lane: Lane
  from: number
  to: number | null
  reason: string
}

export type MarkKind =
  | 'push'
  | 'ci-sent'
  | 'rebase-sent'
  | 'comments-sent'
  | 'review-start'
  | 'review-done'
  | 'update-branch'
  | 'escalate-supervisor'
  | 'escalate-human'
  | 'merge'
  | 'notify'

/** A point event on a track's timeline. */
export interface Mark {
  at: number
  kind: MarkKind
  label: string
}

export interface ReviewerView {
  name: string
  agent: string
  model: string | null
  status: 'running' | 'done' | 'failed'
  verdict?: 'approve' | 'request_changes'
  findings?: number
  error?: string
  /** Waiting on a person (an agent prompt in its terminal). */
  blocked?: string
  /** The terminal to open to answer it. */
  terminal?: string
  /** How it was started: read-only, and by what, or not locked down. */
  lock?: string
}

/** Something only a person can settle, with where to go. */
export interface Attention {
  key: string
  /** The project (`owner/name`) it belongs to. */
  repo?: string
  message: string
  /** Terminal handle to open (`orca terminal switch`). */
  terminal?: string
  /** Workspace to show when there is no terminal. */
  workspaceId?: string
}

/** A review finding as the board shows it (merged across reviewers, most severe first). */
export interface FindingView {
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  file: string | null
  line: number | null
  title: string
  detail: string
  suggestion: string
  reviewers: string[]
}

/** One worktree (and its PR, once it has one): a row on the timeline and a card on the board. */
export interface TrackView {
  key: string
  repo: string
  /** The project's own checkout while the supervisor works there. */
  role?: 'supervisor'
  workspace: { id: string; name: string; branch: string | null }
  pr: {
    number: number
    title: string
    url: string
    sha: string
    base: string
    ci: CiState
    failing: string[]
    openThreads: number
  } | null
  owner: { agent: string | null; model: string | null; activity: Activity; supervised: boolean } | null
  lane: Lane
  reason: string
  /** What Matriarch will do next (or would do, in dry run). */
  next: string[]
  review: { round: number; status: string; verdict?: string; summary?: string; reviewers: ReviewerView[]; findings?: FindingView[] } | null
  rounds: { ci: number; conflicts: number; comments: number; reviews: number }
  segments: Segment[]
  marks: Mark[]
}

export interface RepoView {
  repo: string
  root: string
  mergeMode: 'manual' | 'auto'
  /** The supervisor agent for this repo and its orchestration Run, once found. */
  supervisor: {
    agent: string
    model: string | null
    run: string | null
    /** Started, its Run not found yet. */
    pending: boolean
    /** The supervisor's session, to open from the panel. */
    terminal: string | null
    /** Supervised workers in its Run. */
    workers: number
  }
  errors: string[]
  warnings: string[]
  /** GitHub has no commits for it yet: nothing to branch from or open PRs against. */
  empty?: boolean
}

/** An agent the settings form offers for a role. */
export interface AgentOption {
  id: string
  label: string
  /** Its CLI was found on this machine. */
  installed: boolean
  /** Matriarch can start it read-only as a reviewer. */
  lockable: boolean
  /** Orca can choose its model at launch; otherwise it runs its own default. */
  takesModel: boolean
  /** The models it offers (from Orca's own discovery when it has one); any other id can be typed. */
  models: { id: string; label: string; efforts: string[] }[]
  /** Effort levels when the model's own are not known. */
  efforts: string[]
  /** The model and effort picked for it in Orca, else its default model. */
  defaultModel: string | null
  defaultEffort: string | null
}

/** A project Orca knows, and whether Matriarch can use it. */
export interface ProjectInfo {
  root: string
  name: string
  /** `owner/name` on GitHub, when its origin is there. */
  repo: string | null
  enabled: boolean
  /** Why it cannot be used yet, or what to fix first. */
  problem: string | null
}

export interface Board {
  /** False until the first poll after the worker starts: the board is not empty, it is unknown. */
  ready: boolean
  at: number
  autopilot: boolean
  /** Start of the history window the tracks carry (ms). */
  since: number
  repos: RepoView[]
  tracks: TrackView[]
  /** What needs a person now, most urgent first; the panel and status bar open it. */
  attention: Attention[]
  errors: string[]
  rate: { remaining: number; resetAt: string } | null
  /** This tick's GitHub reads: repositories GitHub said were unchanged (free) and ones read in full. */
  github?: { unchanged: number; read: number }
}

export function emptyBoard(now: number, autopilot = false): Board {
  return { ready: false, at: now, autopilot, since: now - 24 * 3600_000, repos: [], tracks: [], attention: [], errors: [], rate: null }
}

declare module 'orca' {
  interface PluginRequests {
    /** The latest board, with tracks' history since `since` (default: the last 24 hours). */
    'board.get': { input?: { since?: number }; output: Board }
    /** Polls GitHub and Orca now, then answers the new board. */
    'board.refresh': { output: Board }
    /** Turns autopilot on (act) or off (dry run: show what would happen). */
    'autopilot.set': { input: { on: boolean }; output: Board }
    /** Shows a track's workspace in Orca. */
    'track.open': { input: { key: string }; output: { opened: boolean } }
    /** Brings a terminal to the front, such as a reviewer waiting on a prompt. */
    'terminal.focus': { input: { handle: string }; output: { opened: boolean } }
    /** Opens the repo's supervisor as a briefed chat; the objective is optional, the chat asks for it. */
    'supervisor.start': { input: { repo: string; objective?: string }; output: { started: boolean; message: string } }
    /** Brings the supervisor's chat (or its workspace) to the front. */
    'supervisor.open': { input: { repo: string }; output: { opened: boolean } }
    /** Runs an AI review round on a PR now, in dry run too. Delivery still follows autopilot. */
    'review.start': { input: { repo: string; number: number }; output: { started: boolean; message: string } }
    /** The project of the workspace focused in Orca, when it can be told. */
    'project.focused': {
      output: {
        repo: string | null
        root: string | null
        /** Matriarch is on there. */
        enabled: boolean
        /** The focused workspace's name, as Orca gives it. */
        name: string | null
        /** The projects it could be, when Orca's details fit more than one. */
        candidates: string[]
      }
    }
    /** Starts one stuck reviewer of a running round again (after a usage limit or a prompt). */
    'review.restartReviewer': { input: { repo: string; number: number; reviewer: string }; output: { restarted: boolean; message: string } }
    /** Every project Orca knows, with whether Matriarch is on there. */
    'projects.list': { output: { projects: ProjectInfo[] } }
    /** Turns Matriarch on for a project: writes its settings (defaults, or the ones it had). */
    'project.enable': { input: { root: string }; output: { ok: boolean; message: string; repo: string | null } }
    /** Turns Matriarch off for a project; its settings are kept for next time. */
    'project.disable': { input: { repo: string }; output: { ok: boolean; message: string } }
    /** A project's settings for the form, with the agents to choose from. */
    'config.get': { input: { repo: string }; output: { config: MatriarchConfig; errors: string[]; warnings: string[]; agents: AgentOption[] } }
    /** Checks and saves a project's settings; nothing is written when there are errors. */
    'config.save': { input: { repo: string; config: MatriarchConfig }; output: { saved: boolean; errors: string[]; warnings: string[] } }
  }
  interface PluginPanelEvents {
    /** Posted after every tick and every autopilot change. */
    'board.changed': Board
  }
}
