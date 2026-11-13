// The supervisor: an Orca agent on its own provider and model that plans the objective, splits
// it into tasks and starts workers with the tiers the repo configured. Matriarch gives it a brief,
// then finds the orchestration Run it creates (by a tag in the objective) so escalations reach it.
import { modelFlags, type MatriarchConfig, type RoleSpec } from './config.ts'

/** `[matriarch:<repo>:<nonce>]`: lets Matriarch find the supervisor's Run among all Runs. */
export const supervisorTag = (repo: string, nonce: string): string => `[matriarch:${repo}:${nonce}]`
/** What every supervisor tag of a project starts with. */
export const supervisorTagPrefix = (repo: string): string => `[matriarch:${repo}:`

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The worker-start command for a role, into a worktree created first: Orca refuses
 * `--worktree new-child` together with `--model` for some agents (OpenCode: "model selection
 * requires an existing worktree"), so every worker starts in one made beforehand.
 */
export function workerStart(role: RoleSpec): string {
  const flags = modelFlags(role)
  const model = flags.length ? ` ${flags.map((f) => (f.startsWith('--') ? f : q(f))).join(' ')}` : ''
  return `orca orchestration worker-start --task <taskId> --worktree path:<worktree path> --agent ${q(role.agent)}${model} --json`
}

export interface BriefInput {
  repo: string
  /** The project's main checkout, where worktrees are made from. */
  root?: string
  objective: string
  tag: string
  base: string
  config: MatriarchConfig
}

/** `orca agent launch` arguments for the supervisor: a native chat by default, briefed and focused. */
export function supervisorLaunchArgs(role: RoleSpec, root: string, brief: string, surface: 'chat' | 'terminal' = 'chat'): string[] {
  const args = ['agent', 'launch', '--agent', role.agent, '--worktree', `path:${root}`, '--surface', surface, '--focus', '--prompt', brief]
  args.push(...modelFlags(role))
  return args
}

export function supervisorBrief({ repo, root, objective, tag, base, config }: BriefInput): string {
  const tiers = Object.entries(config.workers.tiers)
  const contract = [
    'When the work is done: run the project checks, commit on your branch, push it, and open a PR',
    `against ${base} with gh pr create --base ${base} --fill. Put "Matriarch-Task: <taskId>" in the PR body.`,
    'Then send worker_done with the PR URL in --body. Do not merge, and do not review your own PR.'
  ].join(' ')
  const goal = objective.trim()
  return [
    `You are the supervisor for ${repo}, working with Matriarch.${goal ? ` The user's objective: ${goal}` : ''}`,
    '',
    'You coordinate; you do not write product code yourself. This chat is how the user talks to you.',
    goal
      ? '0. Restate the objective in a line, then go on.'
      : '0. Start by asking the user what the pod should build. Wait for their answer before doing anything else.',
    'Before starting any worker, show the user your plan (the tasks, which files each touches, the tier for each) and wait for them to agree. Workers push branches and open real PRs.',
    '1. Load Orca\'s orchestration guide once: run `orca skills get orchestration` and follow it.',
    `2. Once the user agrees, create the Run. The objective must start with this tag so Matriarch can find it: orca orchestration run-create --objective ${q(`${tag} <the agreed objective in one line>`)} --json`,
    '3. Read the code, write a short plan, and split the work into tasks that touch different files, so',
    '   workers do not conflict. Create each task with a self-contained spec (orca orchestration task-create',
    '   --spec ... --task-title ... [--deps ...] --json). End every spec with this contract:',
    `   "${contract}"`,
    '4. Start each worker in its own worktree. First create the worktree, named for the task:',
    `   orca worktree create --repo ${q(`path:${root ?? '<main checkout>'}`)} --name <short-task-name> --json`,
    '   Then start the worker in it, with exactly these settings. Pick the tier by task size; the default when unsure:',
    `   - default: ${workerStart(config.workers.default)}`,
    ...tiers.map(([name, role]) => `   - ${name}: ${workerStart(role)}`),
    '   Always pass the --effort shown. If Orca refuses it ("does not support effort"), start that one worker without',
    '   --effort and say so, but pass it again on every later start: Orca\'s model list catches up with the agent\'s.',
    '   Never change the agent or the model.',
    '   Worktrees that never become a PR (a gate, an audit, a spike) are yours to clean up: once you have recorded',
    '   the result and no worker runs there, remove it (orca worktree rm --worktree path:<path> --json). Matriarch',
    '   removes each PR\'s worktree itself once the PR merges.',
    '5. Matriarch runs the PR lifecycle: CI failures, review comments and conflicts go back to the',
    '   worker that owns the branch, and its review crew reviews every PR. Do not review or merge PRs yourself.',
    '   It takes up a PR only once it is ready: keep one as a draft only while it waits on something, and mark it',
    '   ready (gh pr ready <number>) as soon as its work is done.',
    config.merge.mode === 'auto'
      ? '   Matriarch merges each PR itself once its review passes. Never ask the user to merge: wait for the PR to show MERGED (gh pr view <n> --json state) before starting work that depends on it.'
      : '   The user merges each PR once Matriarch marks it ready. Say in this chat which PR is ready and what waits on it, and keep other independent tasks moving meanwhile.',
    '6. When Matriarch sends you an escalation, decide the next step yourself: give the worker new instructions',
    '   (orca orchestration send --to dispatch:<id>), start a fixer on a stronger tier, or re-plan.',
    '7. After starting the workers, end your turn. Orca wakes you with their reports and with escalations.',
    '8. Once the user has agreed the plan, run it to the end without them: they may be away. Answer workers\'',
    '   questions yourself, decide escalations yourself, and never stop to wait for the user. When something truly',
    '   needs them (a credential, a product decision you cannot make from the docs), make the safest reversible',
    '   choice, note it for them in this chat, and keep every other task moving.'
  ].join('\n')
}

/** The Run whose objective starts with the tag, from `orca orchestration run-list --json`. */
export function findTaggedRun(result: unknown, tag: string): string | null {
  const r = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  const runs = Array.isArray(r.runs) ? r.runs : Array.isArray(result) ? result : []
  for (const run of runs) {
    const o = typeof run === 'object' && run !== null ? (run as Record<string, unknown>) : {}
    if (typeof o.id === 'string' && typeof o.objective === 'string' && o.objective.includes(tag)) return o.id
  }
  return null
}
