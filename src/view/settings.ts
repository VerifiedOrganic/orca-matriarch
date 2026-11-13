// A project's settings as a form: who supervises, builds and reviews (agent, model, effort),
// and the main review and merge policies. It edits a draft; Save sends it to the worker, which
// checks it and writes the project's .orca/matriarch.json.
import type { MatriarchConfig, ReviewerSpec, RoleSpec, Severity } from '../config.ts'
import type { AgentOption } from '../protocol.ts'
import { checkbox, el, field, select, textInput, type Child } from './dom.ts'
import { modelPicker } from './model-picker.ts'

export interface SettingsState {
  repo: string
  draft: MatriarchConfig
  /** Worker tiers as rows, so a tier can be renamed while typing. */
  tiers: { name: string; role: RoleSpec }[]
  agents: AgentOption[]
  errors: string[]
  warnings: string[]
  saved: boolean
  confirmOff: boolean
}

export interface SettingsActions {
  busy: boolean
  /** Re-draws after a change that alters the form's shape. */
  redraw(): void
  save(): void
  cancel(): void
  turnOff(): void
}

export function settingsState(repo: string, config: MatriarchConfig, agents: AgentOption[], errors: string[], warnings: string[]): SettingsState {
  const draft = structuredClone(config)
  return { repo, draft, tiers: Object.entries(draft.workers.tiers).map(([name, role]) => ({ name, role })), agents, errors, warnings, saved: false, confirmOff: false }
}

/** The draft as a config to save, or the problems that stop it. */
export function draftConfig(s: SettingsState): { config: MatriarchConfig; problems: string[] } {
  const problems: string[] = []
  const tiers: Record<string, RoleSpec> = {}
  for (const t of s.tiers) {
    const name = t.name.trim()
    if (!name) problems.push('Every worker tier needs a name.')
    else if (tiers[name]) problems.push(`Two worker tiers are called "${name}".`)
    else tiers[name] = t.role
  }
  return { config: { ...s.draft, workers: { ...s.draft.workers, tiers } }, problems }
}

const option = (s: SettingsState, id: string): AgentOption | undefined => s.agents.find((a) => a.id === id)

/** The agent dropdown: the agents enabled in the person's Orca profile and installed here. */
function agentSelect(s: SettingsState, current: string, onchange: (v: string) => void): HTMLElement {
  const usable = s.agents.filter((a) => a.installed)
  const node = el('select', { title: 'Agent: the ones enabled in your Orca settings and installed', onchange: (e) => onchange((e.target as HTMLSelectElement).value) },
    ...usable.map((a) => el('option', { value: a.id, selected: a.id === current }, a.label)),
    // An agent the settings use that is off or missing here stays visible, so saving keeps it.
    usable.some((a) => a.id === current) ? null : el('option', { value: current, selected: true }, `${option(s, current)?.label ?? current} (not available here)`))
  ;(node as HTMLSelectElement).value = current
  return node
}

/** The effort levels for this agent and model: the model's own, when Orca knows them. */
function effortsFor(agent: AgentOption | undefined, model: string | undefined): string[] {
  const known = agent?.models.find((m) => m.id === model)
  return known && known.efforts.length ? known.efforts : (agent?.efforts ?? [])
}

/** Agent, model and effort for one role; the model picker searches the agent's models. */
function roleControls(s: SettingsState, role: RoleSpec, act: SettingsActions): HTMLElement {
  const agent = option(s, role.agent)
  const efforts = effortsFor(agent, role.model)
  // OpenCode calls its levels thinking (variants of the model); the others call it effort.
  const word = role.agent.startsWith('opencode') ? 'thinking' : 'effort'
  const picker = agent && !agent.takesModel
    ? null
    : modelPicker(role, agent, role.model, (model) => {
        if (model) role.model = model
        else {
          delete role.model
          delete role.effort
        }
        // A model with other effort levels drops an effort it does not take.
        if (role.effort && !effortsFor(agent, role.model).includes(role.effort)) delete role.effort
        act.redraw()
      }, act.redraw)
  return el(
    'div',
    { class: 'role' },
    agentSelect(s, role.agent, (v) => {
      role.agent = v
      const next = option(s, v)
      // A model or effort of the old agent means nothing to the new one: take the new one's own
      // default (what is picked for it in Orca), or leave it to the agent.
      if (!next?.models.some((m) => m.id === role.model)) {
        if (next?.takesModel && next.defaultModel) role.model = next.defaultModel
        else delete role.model
        if (next?.defaultEffort && role.model && effortsFor(next, role.model).includes(next.defaultEffort)) role.effort = next.defaultEffort
        else delete role.effort
      }
      if (role.effort && !effortsFor(next, role.model).includes(role.effort)) delete role.effort
      if (next && !next.takesModel) {
        delete role.model
        delete role.effort
      }
      act.redraw()
    }),
    picker
      ? picker.button
      : el('span', { class: 'muted hint picker-none', title: "Orca can't choose a model for this agent; set it in the agent's own config" }, 'its own default model'),
    efforts.length || role.effort
      ? select(role.effort ?? '', [['', `default ${word}`], ...(efforts.includes(role.effort ?? '') || !role.effort ? efforts : [role.effort!, ...efforts]).map((e): [string, string] => [e, `${e} ${word}`])], (v) => {
          if (v) role.effort = v
          else delete role.effort
        }, { title: role.model ? 'Reasoning effort: the levels this model takes' : 'Pick a model first: Orca passes effort only with a model', disabled: !role.model })
      : el('span'),
    picker?.panel ?? null
  )
}

function reviewerRow(s: SettingsState, r: ReviewerSpec, index: number, act: SettingsActions): HTMLElement {
  const lockable = option(s, r.agent)?.lockable ?? false
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'item-top' },
      textInput(r.name, (v) => (r.name = v.trim().toLowerCase()), { class: 'name-input', placeholder: 'name', title: 'Lowercase letters, digits and dashes' }),
      checkbox(r.blocking, 'Must approve', (on) => (r.blocking = on), { title: 'With the default pass policy, the PR passes only when every must-approve reviewer approves' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', title: 'Remove this reviewer', onclick: () => { s.draft.reviewers.splice(index, 1); act.redraw() } }, 'Remove')),
    roleControls(s, r, act),
    textInput(r.focus ?? '', (v) => {
      if (v.trim()) r.focus = v
      else delete r.focus
    }, { placeholder: 'What it looks for, e.g. bugs and missing tests', title: 'Added to its brief' }),
    lockable
      ? el('span', { class: 'muted hint' }, '🔒 Starts read-only')
      : checkbox(r.readOnly === false, 'Run it without the read-only lockdown (Matriarch can lock down only Claude and Codex)', (on) => {
          if (on) r.readOnly = false
          else delete r.readOnly
        }, { class: 'check warn-text' })
  )
}

function tierRow(s: SettingsState, t: { name: string; role: RoleSpec }, index: number, act: SettingsActions): HTMLElement {
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'item-top' },
      textInput(t.name, (v) => (t.name = v.trim()), { class: 'name-input', placeholder: 'tier name, e.g. light', title: 'The supervisor picks a tier per task by this name' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', onclick: () => { s.tiers.splice(index, 1); act.redraw() } }, 'Remove')),
    roleControls(s, t.role, act)
  )
}

/** A new role on the first installed agent from `prefer`, with its first suggested model. */
function newRole(s: SettingsState, prefer: string[]): RoleSpec {
  const pick = prefer.map((id) => option(s, id)).find((a) => a?.installed) ?? s.agents.find((a) => a.installed) ?? s.agents[0]
  const model = pick?.takesModel ? (pick.defaultModel ?? pick.models[0]?.id) : undefined
  return model ? { agent: pick!.id, model } : { agent: pick?.id ?? 'claude' }
}

const SEVERITY_LABEL: Record<Severity, string> = { blocker: 'blockers only', major: 'major and worse', minor: 'minor and worse', nit: 'anything, even nits' }

const FIX_LABEL = { ci: 'CI failures', comments: 'Review comments', conflicts: 'Conflicts' } as const

/** Where the project lives: found from its origin unless set here, with a host for GitLab. */
function forgeControls(d: MatriarchConfig, act: SettingsActions): HTMLElement {
  return el('div', {},
    field('Where it lives', select(d.forge?.kind ?? '', [['', 'found from its origin'], ['github', 'GitHub (github.com)'], ['gitlab', 'GitLab']], (v) => {
      if (v === 'github' || v === 'gitlab') d.forge = { kind: v }
      else delete d.forge
      act.redraw()
    }), 'github.com is GitHub. Another host is GitLab once glab is signed in to it (glab auth login --hostname <host>). Pick GitLab here for a host behind an ssh alias.'),
    d.forge?.kind === 'gitlab'
      ? field('GitLab host', textInput(d.forge.host ?? '', (v) => (d.forge = v.trim() ? { kind: 'gitlab', host: v.trim() } : { kind: 'gitlab' }), { placeholder: "the origin's host, e.g. gitlab.example.com" }), 'Its web address without https://. Left empty, the origin\'s host.')
      : null)
}

/** Paths typed as a comma- or line-separated list. */
const globList = (v: string): string[] => v.split(/[,\n]/).map((g) => g.trim()).filter(Boolean)

export function settingsForm(s: SettingsState, act: SettingsActions): HTMLElement {
  const d = s.draft
  const section = (title: string, ...children: Child[]) => el('section', {}, el('h4', {}, title), ...children)
  const num = (value: number, set: (n: number) => void, min: number, max: number) =>
    textInput(String(value), (v) => set(Number(v)), { type: 'number', min, max, class: 'num' })
  const fixRow = (key: keyof typeof FIX_LABEL) =>
    el('div', { class: 'fix-row' },
      checkbox(d.fix[key].enabled, FIX_LABEL[key], (on) => (d.fix[key].enabled = on)),
      el('span', { class: 'muted' }, 'up to'),
      num(d.fix[key].maxRounds, (n) => (d.fix[key].maxRounds = n), 1, 10),
      el('span', { class: 'muted' }, 'rounds'))
  return el(
    'div',
    { class: 'settings' },
    section('Supervisor',
      el('p', { class: 'muted hint' }, 'Plans the work in its chat, starts workers, and gets escalations.'),
      roleControls(s, d.supervisor, act)),
    section('Workers',
      el('p', { class: 'muted hint' }, 'Each task runs in its own worktree on this agent, unless the supervisor picks a tier.'),
      roleControls(s, d.workers.default, act),
      ...s.tiers.map((t, i) => tierRow(s, t, i, act)),
      el('button', { class: 'ghost', onclick: () => { s.tiers.push({ name: '', role: newRole(s, ['claude', 'codex']) }); act.redraw() } }, '+ Add a worker tier')),
    section('Review crew',
      el('p', { class: 'muted hint' }, 'Every reviewer checks each PR in a throwaway worktree; their verdicts are combined.'),
      ...d.reviewers.map((r, i) => reviewerRow(s, r, i, act)),
      el('button', { class: 'ghost', onclick: () => {
        const taken = new Set(d.reviewers.map((r) => r.name))
        let n = d.reviewers.length + 1
        while (taken.has(`reviewer-${n}`)) n++
        d.reviewers.push({ name: `reviewer-${n}`, blocking: true, ...newRole(s, ['claude', 'codex']) })
        act.redraw()
      } }, '+ Add a reviewer'),
      checkbox(d.review.enabled, 'Review every PR with the crew', (on) => (d.review.enabled = on)),
      field('Start a review', select(d.review.trigger, [['ci-green', 'after CI passes'], ['pr-open', 'as soon as the PR opens']], (v) => (d.review.trigger = v as typeof d.review.trigger))),
      field('A PR passes when', select(d.review.pass, [
        ['all-blocking-approve', 'every must-approve reviewer approves'],
        ['majority', 'most reviewers approve'],
        ['no-blockers', 'no finding is at the blocking level']
      ], (v) => (d.review.pass = v as typeof d.review.pass))),
      field('Findings that block', select(d.review.blockAt, (Object.keys(SEVERITY_LABEL) as Severity[]).map((k): [string, string] => [k, SEVERITY_LABEL[k]]), (v) => (d.review.blockAt = v as Severity))),
      field('Review rounds per PR', textInput(String(d.review.maxRounds), (v) => (d.review.maxRounds = Number(v)), { type: 'number', min: 1, max: 10, class: 'num' }), 'Then it escalates instead of asking again.'),
      field('Reviews at once', num(d.limits.maxConcurrentReviews, (n) => (d.limits.maxConcurrentReviews = n), 1, 20), 'In this project; more wait their turn.'),
      field('Later rounds', select(d.review.followUp, [['focused', 'check the fixes and what changed (cheaper)'], ['full', 'review the whole PR again']], (v) => (d.review.followUp = v as typeof d.review.followUp))),
      checkbox(d.review.fallback !== null, "When a reviewer's account runs out, switch it to another model", (on) => {
        d.review.fallback = on ? newRole(s, ['claude', 'codex']) : null
        act.redraw()
      }),
      d.review.fallback ? roleControls(s, d.review.fallback, act) : null,
      checkbox(d.review.differentProviderThanAuthor, 'Skip reviewers on the same agent that wrote the PR', (on) => (d.review.differentProviderThanAuthor = on)),
      field('Where reviews go', select(d.review.publish, [['orca-only', 'stay in Orca'], ['github', 'also posted on the PR (a comment review on GitHub, a note on GitLab)']], (v) => (d.review.publish = v as typeof d.review.publish)))),
    section('Fixes',
      el('p', { class: 'muted hint' }, 'Sent to the worker that owns the branch, or to the supervisor once that worker has finished. After the last round, it escalates.'),
      fixRow('ci'), fixRow('comments'), fixRow('conflicts')),
    section('Escalation',
      checkbox(d.escalation.supervisorFirst, 'Send problems to the supervisor before you', (on) => (d.escalation.supervisorFirst = on)),
      field('Tell you after', el('span', { class: 'inline' }, num(d.escalation.humanAfterMinutes, (n) => (d.escalation.humanAfterMinutes = n), 1, 24 * 60), el('span', { class: 'muted' }, ' minutes')), 'If the supervisor has not settled it by then.')),
    section('Merging',
      field('Who merges', select(d.merge.mode, [['manual', 'you: Matriarch marks PRs ready'], ['auto', 'Matriarch, once CI and review pass']], (v) => (d.merge.mode = v as typeof d.merge.mode))),
      field('Merge method', select(d.merge.method, [['squash', 'squash'], ['merge', 'merge commit'], ['rebase', 'rebase']], (v) => (d.merge.method = v as typeof d.merge.method)), "On GitLab: squash or not; the project's own merge method in GitLab decides the rest."),
      field('When a PR falls behind', select(d.merge.updateBranch, [['rebase', 'rebase it onto the base'], ['merge', 'merge the base into it'], ['off', 'leave it']], (v) => (d.merge.updateBranch = v as typeof d.merge.updateBranch)), 'GitLab cannot merge the base in for Matriarch: the worker is asked to.'),
      field("When the base branch's CI is red", select(d.merge.onBaseRed, [
        ['pause', 'pause merges and ask for a fix'],
        ...(d.merge.onBaseRed === 'fix-forward' ? [['fix-forward', 'pause merges and ask for a fix forward'] as [string, string]] : []),
        ['revert', 'pause merges and ask to revert what broke it']
      ], (v) => (d.merge.onBaseRed = v as typeof d.merge.onBaseRed))),
      field('Paths that always need you to merge', textInput(d.merge.requireHuman.join(', '), (v) => (d.merge.requireHuman = globList(v)), { placeholder: 'e.g. migrations/**, .github/**' }), 'A PR that touches one waits for you, even when Matriarch merges.'),
      checkbox(d.merge.deleteBranch, 'Delete the branch on GitHub or GitLab once merged', (on) => (d.merge.deleteBranch = on)),
      checkbox(d.merge.removeWorktree, "Remove a PR's worktree once it merged (only when nothing runs there and nothing is uncommitted)", (on) => (d.merge.removeWorktree = on)),
      checkbox(d.merge.removeFinishedWorktrees, "Remove a worktree the supervisor's workers finished in that never became a PR, such as a review gate, an hour later (only when nothing in it is uncommitted or unpushed)", (on) => (d.merge.removeFinishedWorktrees = on))),
    section('Forge', forgeControls(d, act)),
    s.errors.length ? el('div', { class: 'callout' }, el('b', {}, 'Fix these to save'), el('ul', {}, ...s.errors.map((e) => el('li', {}, e)))) : null,
    s.warnings.length ? el('div', { class: 'callout warn' }, el('b', {}, 'Notes'), el('ul', {}, ...s.warnings.map((w) => el('li', {}, w)))) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'primary', disabled: act.busy, onclick: () => act.save() }, act.busy ? 'Saving…' : 'Save'),
      el('button', { class: 'ghost', onclick: () => act.cancel() }, s.saved ? 'Close' : 'Cancel'),
      s.saved ? el('span', { class: 'saved' }, 'Saved. Takes effect on the next check.') : null,
      el('span', { class: 'spacer' }),
      s.confirmOff
        ? el('button', { class: 'danger', onclick: () => act.turnOff() }, 'Confirm: turn off here')
        : el('button', { class: 'ghost', title: 'Stops Matriarch for this project; its settings are kept for next time', onclick: () => { s.confirmOff = true; act.redraw() } }, 'Turn Matriarch off here'))
  )
}
