// A project's settings as a form. Who does the work comes first: the supervisor, the workers and
// the reviewers, each a card with its agent, model and effort on one line. The rules follow in
// groups that stay closed until clicked, each saying its current values in one line. It edits a
// draft; Save sends it to the worker, which checks it and writes the project's .orca/matriarch.json.
import type { MatriarchConfig, ReviewerSpec, RoleSpec, Severity } from '../config.ts'
import type { AgentOption } from '../protocol.ts'
import { checkbox, el, select, textInput, toggle, type Child } from './dom.ts'
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
  /** The rule groups the person opened; the others show a one-line summary. */
  open: Record<string, boolean>
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
  return {
    repo, draft, tiers: Object.entries(draft.workers.tiers).map(([name, role]) => ({ name, role })), agents, errors, warnings,
    saved: false, confirmOff: false, open: {}
  }
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
  const node = el('select', { class: 'agent', title: 'Agent: the ones enabled in your Orca settings and installed', onchange: (e) => onchange((e.target as HTMLSelectElement).value) },
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

/** Agent, model and effort for one role, on one line; the model picker searches the agent's models. */
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
      : el('span', { class: 'muted picker-none', title: "Orca can't choose a model for this agent; set it in the agent's own config" }, 'its own default model'),
    efforts.length || role.effort
      ? select(role.effort ?? '', [['', `default ${word}`], ...(efforts.includes(role.effort ?? '') || !role.effort ? efforts : [role.effort!, ...efforts]).map((e): [string, string] => [e, `${e} ${word}`])], (v) => {
          if (v) role.effort = v
          else delete role.effort
        }, { class: 'effort', title: role.model ? `Reasoning ${word}: the levels this model takes` : `Pick a model first: Orca passes ${word} only with a model`, disabled: !role.model })
      : el('span', { class: 'effort' }),
    picker?.panel ?? null
  )
}

let ids = 0
/** The control's id, given one if it has none, for a label to point at. */
const idOf = (node: HTMLElement): string => (node.id ||= `m-set-${++ids}`)

/**
 * One setting as a row: its name with a hint under it, and the control on the right. A `stack` row
 * puts a wide control (a long dropdown, a text box) under the name while the panel is narrow.
 */
function row(label: string, hint: string | null, control: HTMLElement, opts: { stack?: boolean; before?: Child[]; after?: Child[]; class?: string } = {}): HTMLElement {
  return el('div', { class: `set${opts.stack ? ' stack' : ''}${opts.class ? ` ${opts.class}` : ''}` },
    el('div', { class: 'set-text' },
      el('label', { class: 'set-label', for: idOf(control) }, label),
      hint ? el('span', { class: 'set-hint' }, hint) : null),
    el('div', { class: 'set-control' }, ...(opts.before ?? []), control, ...(opts.after ?? [])))
}

/** A dropdown setting; one with long choices or a long hint goes under its name while the panel is narrow. */
function choice<T extends string>(label: string, hint: string | null, value: T, options: readonly (readonly [T, string])[], set: (v: T) => void): HTMLElement {
  return row(label, hint, select(value, options, (v) => set(v as T)), { stack: options.some(([, text]) => text.length > 24) || (hint?.length ?? 0) > 100 })
}

/** A whole number in a small box, with its unit after it. */
function number(value: number, set: (n: number) => void, min: number, max: number): HTMLElement {
  return textInput(String(value), (v) => set(Number(v)), { type: 'number', min, max, class: 'num' })
}

const unit = (text: string): HTMLElement => el('span', { class: 'unit' }, text)

const removeButton = (title: string, remove: () => void): HTMLElement =>
  el('button', { class: 'ghost remove', type: 'button', title, onclick: remove }, 'Remove')

const addButton = (text: string, add: () => void): HTMLElement => el('button', { class: 'add-row', type: 'button', onclick: add }, text)

/** A role card: its name, what it does, then its controls. */
function card(title: string, hint: string, badges: Child[], ...children: Child[]): HTMLElement {
  return el('section', { class: 'rcard' },
    el('div', { class: 'rcard-head' }, el('h4', {}, title), ...badges),
    el('p', { class: 'set-hint' }, hint),
    ...children)
}

function reviewerItem(s: SettingsState, r: ReviewerSpec, index: number, act: SettingsActions): HTMLElement {
  const lockable = option(s, r.agent)?.lockable ?? false
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'item-head' },
      textInput(r.name, (v) => (r.name = v.trim().toLowerCase()), { class: 'name-input', placeholder: 'name', 'aria-label': 'Reviewer name', title: 'Its name: lowercase letters, digits and dashes' }),
      checkbox(r.blocking, 'Must approve', (on) => (r.blocking = on), { title: 'With the default pass rule, the PR passes only when every must-approve reviewer approves' }),
      removeButton('Remove this reviewer', () => { s.draft.reviewers.splice(index, 1); act.redraw() })),
    roleControls(s, r, act),
    textInput(r.focus ?? '', (v) => {
      if (v.trim()) r.focus = v
      else delete r.focus
    }, { class: 'focus-input', placeholder: 'What it looks for, e.g. bugs and missing tests', 'aria-label': 'What it looks for', title: 'Added to its brief' }),
    lockable
      ? el('span', { class: 'item-note' }, '🔒 Starts read-only')
      : el('div', { class: 'item-note' },
          checkbox(r.readOnly === false, 'Run it without the read-only lockdown', (on) => {
            if (on) r.readOnly = false
            else delete r.readOnly
          }, { class: 'check warn-text' }),
          el('span', { class: 'set-hint' }, 'Matriarch can lock down only Claude and Codex. Without this, it does not start this reviewer.'))
  )
}

function tierItem(s: SettingsState, t: { name: string; role: RoleSpec }, index: number, act: SettingsActions): HTMLElement {
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'item-head' },
      el('span', { class: 'item-kind' }, 'Tier'),
      textInput(t.name, (v) => (t.name = v.trim()), { class: 'name-input', placeholder: 'name, e.g. light', 'aria-label': 'Tier name', title: 'The supervisor picks a tier per task by this name' }),
      removeButton('Remove this tier', () => { s.tiers.splice(index, 1); act.redraw() })),
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
const FIX_SHORT = { ci: 'CI', comments: 'comments', conflicts: 'conflicts' } as const

const TRIGGER_SHORT = { 'ci-green': 'After CI passes', 'pr-open': 'When the PR opens' } as const
const PASS_SHORT = { 'all-blocking-approve': 'every must-approve reviewer', majority: 'most reviewers', 'no-blockers': 'no blocking findings' } as const
const METHOD_SHORT = { squash: 'squash', merge: 'merge commit', rebase: 'rebase' } as const
const BEHIND_SHORT = { rebase: 'rebase when behind', merge: 'merge the base when behind', off: 'leave PRs behind' } as const

/** Paths typed as a comma- or line-separated list. */
const globList = (v: string): string[] => v.split(/[,\n]/).map((g) => g.trim()).filter(Boolean)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function settingsForm(s: SettingsState, act: SettingsActions): HTMLElement {
  const d = s.draft
  // What shows a value outside the control that sets it (the summaries) follows every edit, without
  // re-drawing the form under the person's cursor.
  const live: (() => void)[] = []

  /** A rule group: closed, its header says the current values; open, it shows the settings. */
  const group = (key: string, title: string, summary: () => string, ...children: Child[]) => {
    const line = el('span', { class: 'group-sum' })
    live.push(() => (line.textContent = summary()))
    return el('details', { class: 'group', open: s.open[key] === true, ontoggle: (e) => (s.open[key] = (e.currentTarget as HTMLDetailsElement).open) },
      el('summary', {}, el('span', { class: 'group-title' }, title), line),
      el('div', { class: 'group-body' }, ...children))
  }
  const intro = (text: string) => el('p', { class: 'set-hint group-intro' }, text)
  /** Settings that matter only while the switch in the row before them is on. */
  const dependent = (...children: Child[]) => el('div', { class: 'dep' }, ...children)

  const fixRow = (key: keyof typeof FIX_LABEL) =>
    row(FIX_LABEL[key], null, toggle(d.fix[key].enabled, (on) => (d.fix[key].enabled = on)), {
      class: 'fix',
      before: [unit('up to'), number(d.fix[key].maxRounds, (n) => (d.fix[key].maxRounds = n), 1, 10), unit('rounds')]
    })

  // Who does the work.
  const offPill = el('span', { class: 'pill pill-off', title: 'Turn reviews on under Rules → Review' }, 'reviews off')
  live.push(() => (offPill.hidden = d.review.enabled))
  const supervisor = card('Supervisor', 'Plans the work in its chat, starts workers, and gets escalations.', [],
    roleControls(s, d.supervisor, act))
  const workers = card('Workers', 'Each task runs in its own worktree on this agent, unless the supervisor picks a tier.', [],
    roleControls(s, d.workers.default, act),
    ...s.tiers.map((t, i) => tierItem(s, t, i, act)),
    addButton('+ Add a worker tier', () => { s.tiers.push({ name: '', role: newRole(s, ['claude', 'codex']) }); act.redraw() }))
  const reviewers = card('Reviewers', 'Each one checks every PR in a throwaway worktree; their verdicts are combined.',
    [el('span', { class: 'count' }, String(d.reviewers.length)), offPill],
    d.reviewers.length ? el('div', { class: 'crew' }, ...d.reviewers.map((r, i) => reviewerItem(s, r, i, act))) : null,
    addButton('+ Add a reviewer', () => {
      const taken = new Set(d.reviewers.map((r) => r.name))
      let n = d.reviewers.length + 1
      while (taken.has(`reviewer-${n}`)) n++
      d.reviewers.push({ name: `reviewer-${n}`, blocking: true, ...newRole(s, ['claude', 'codex']) })
      act.redraw()
    }),
    el('div', { class: 'item fallback' },
      row('Usage-limit fallback', "When a reviewer's account runs out, it starts again on this instead.", toggle(d.review.fallback !== null, (on) => {
        d.review.fallback = on ? newRole(s, ['claude', 'codex']) : null
        act.redraw()
      })),
      d.review.fallback ? roleControls(s, d.review.fallback, act) : null))
  reviewers.classList.add('wide')

  // The rules.
  const review = group('review', 'Review', () => !d.review.enabled
    ? 'Off: PRs are not reviewed'
    : [TRIGGER_SHORT[d.review.trigger], PASS_SHORT[d.review.pass], plural(d.review.maxRounds, 'round'), d.review.publish === 'github' ? 'posted on the PR' : null].filter(Boolean).join(' · '),
    row('Review every PR', 'With the reviewers above.', toggle(d.review.enabled, (on) => (d.review.enabled = on))),
    dependent(
      choice('Start a review', null, d.review.trigger, [['ci-green', 'after CI passes'], ['pr-open', 'as soon as the PR opens']], (v) => (d.review.trigger = v)),
      choice('A PR passes when', null, d.review.pass, [
        ['all-blocking-approve', 'every must-approve reviewer approves'],
        ['majority', 'most reviewers approve'],
        ['no-blockers', 'no finding is at the blocking level']
      ], (v) => (d.review.pass = v)),
      choice('Findings that block', null, d.review.blockAt, (Object.keys(SEVERITY_LABEL) as Severity[]).map((k): [Severity, string] => [k, SEVERITY_LABEL[k]]), (v) => (d.review.blockAt = v)),
      row('Review rounds per PR', 'Then it escalates instead of asking again.', number(d.review.maxRounds, (n) => (d.review.maxRounds = n), 1, 10)),
      choice('Later rounds', null, d.review.followUp, [['focused', 'check the fixes and what changed (cheaper)'], ['full', 'review the whole PR again']], (v) => (d.review.followUp = v)),
      row('Reviews at once', 'In this project; more wait their turn.', number(d.limits.maxConcurrentReviews, (n) => (d.limits.maxConcurrentReviews = n), 1, 20)),
      row("Skip the author's agent", 'Reviewers on the same agent that wrote the PR sit it out.', toggle(d.review.differentProviderThanAuthor, (on) => (d.review.differentProviderThanAuthor = on))),
      choice('Where reviews go', null, d.review.publish, [['orca-only', 'stay in Orca'], ['github', 'also posted on the PR (a comment review on GitHub, a note on GitLab)']], (v) => (d.review.publish = v))))

  const fixes = group('fixes', 'Fixes and escalation', () => {
    const keys = Object.keys(FIX_LABEL) as (keyof typeof FIX_LABEL)[]
    const on = keys.filter((k) => d.fix[k].enabled).map((k) => `${FIX_SHORT[k]} ${d.fix[k].maxRounds}`)
    const off = keys.filter((k) => !d.fix[k].enabled).map((k) => FIX_SHORT[k])
    return [
      on.length ? `Rounds: ${on.join(', ')}` : 'No automatic fixes',
      on.length && off.length ? `${off.join(' and ')} off` : null,
      d.escalation.supervisorFirst ? `tells you after ${d.escalation.humanAfterMinutes} min` : 'problems go straight to you'
    ].filter(Boolean).join(' · ')
  },
    intro('Fixes go to the worker that owns the branch, or to the supervisor once that worker has finished. After the last round, it escalates.'),
    fixRow('ci'), fixRow('comments'), fixRow('conflicts'),
    el('div', { class: 'group-sub' }, 'Escalation'),
    row('Supervisor first', 'Send problems to the supervisor before you.', toggle(d.escalation.supervisorFirst, (on) => (d.escalation.supervisorFirst = on))),
    dependent(
      row('Tell you after', 'If the supervisor has not settled it by then.', number(d.escalation.humanAfterMinutes, (n) => (d.escalation.humanAfterMinutes = n), 1, 24 * 60), { after: [unit('minutes')] })))

  const merging = group('merge', 'Merging and cleanup', () =>
    [
      d.merge.mode === 'auto' ? 'Matriarch merges' : 'You merge',
      METHOD_SHORT[d.merge.method],
      BEHIND_SHORT[d.merge.updateBranch],
      d.merge.requireHuman.length ? `${plural(d.merge.requireHuman.length, 'path')} always need you` : null
    ].filter(Boolean).join(' · '),
    choice('Who merges', null, d.merge.mode, [['manual', 'you: Matriarch marks PRs ready'], ['auto', 'Matriarch, once CI and review pass']], (v) => (d.merge.mode = v)),
    choice('Merge method', "On GitLab: squash or not; the project's own merge method decides the rest.", d.merge.method, [['squash', 'squash'], ['merge', 'merge commit'], ['rebase', 'rebase']], (v) => (d.merge.method = v)),
    choice('When a PR falls behind', 'GitLab cannot merge the base in for Matriarch: the worker is asked to.', d.merge.updateBranch, [['rebase', 'rebase it onto the base'], ['merge', 'merge the base into it'], ['off', 'leave it']], (v) => (d.merge.updateBranch = v)),
    choice("When the base branch's CI is red", null, d.merge.onBaseRed, [
      ['pause', 'pause merges and ask for a fix'],
      ...(d.merge.onBaseRed === 'fix-forward' ? [['fix-forward', 'pause merges and ask for a fix forward'] as const] : []),
      ['revert', 'pause merges and ask to revert what broke it']
    ], (v) => (d.merge.onBaseRed = v)),
    row('Paths that always need you', 'A PR that touches one waits for you, even when Matriarch merges.',
      textInput(d.merge.requireHuman.join(', '), (v) => (d.merge.requireHuman = globList(v)), { placeholder: 'e.g. migrations/**, .github/**' }), { stack: true }),
    el('div', { class: 'group-sub' }, 'Cleanup'),
    row('Delete merged branches', 'On GitHub or GitLab, once the PR merged.', toggle(d.merge.deleteBranch, (on) => (d.merge.deleteBranch = on))),
    row('Remove merged worktrees', 'Only when nothing runs there and nothing is uncommitted.', toggle(d.merge.removeWorktree, (on) => (d.merge.removeWorktree = on))),
    row('Remove finished worktrees', "A worktree the supervisor's workers finished in that never became a PR, such as a review gate, an hour later. Only when nothing in it is uncommitted or unpushed.",
      toggle(d.merge.removeFinishedWorktrees, (on) => (d.merge.removeFinishedWorktrees = on))))

  const project = group('project', 'Project', () =>
    d.forge?.kind === 'gitlab' ? `GitLab${d.forge.host ? ` on ${d.forge.host}` : ", on the origin's host"}` : d.forge?.kind === 'github' ? 'GitHub' : 'GitHub or GitLab, found from its origin',
    choice('Where it lives', 'github.com is GitHub. Another host is GitLab once glab is signed in to it (glab auth login --hostname <host>). Pick GitLab here for a host behind an ssh alias.',
      d.forge?.kind ?? '', [['', 'found from its origin'], ['github', 'GitHub (github.com)'], ['gitlab', 'GitLab']], (v) => {
        if (v === 'github' || v === 'gitlab') d.forge = { kind: v }
        else delete d.forge
        act.redraw()
      }),
    d.forge?.kind === 'gitlab'
      ? row('GitLab host', "Its web address without https://. Left empty, the origin's host.",
          textInput(d.forge.host ?? '', (v) => (d.forge = v.trim() ? { kind: 'gitlab', host: v.trim() } : { kind: 'gitlab' }), { placeholder: 'e.g. gitlab.example.com' }), { stack: true })
      : null)

  // Problems from the last load or save, at the top where the form starts.
  const problems = s.errors.length ? el('div', { class: 'callout' }, el('b', {}, 'Fix these to save'), el('ul', {}, ...s.errors.map((e) => el('li', {}, e)))) : null
  const notes = s.warnings.length ? el('div', { class: 'callout warn' }, el('b', {}, 'Notes'), el('ul', {}, ...s.warnings.map((w) => el('li', {}, w)))) : null

  const danger = el('div', { class: 'danger-zone' },
    el('div', { class: 'set-text' },
      el('span', { class: 'set-label' }, 'Turn Matriarch off here'),
      el('span', { class: 'set-hint' }, 'Stops Matriarch for this project. Its settings are kept for next time.')),
    s.confirmOff
      ? el('div', { class: 'set-control' },
          el('button', { class: 'ghost', type: 'button', onclick: () => { s.confirmOff = false; act.redraw() } }, 'Keep it on'),
          el('button', { class: 'danger', type: 'button', onclick: () => act.turnOff() }, 'Confirm: turn off here'))
      : el('button', { class: 'quiet-danger', type: 'button', title: 'Stops Matriarch for this project; its settings are kept for next time', onclick: () => { s.confirmOff = true; act.redraw() } }, 'Turn off'))

  const status = s.saved ? el('span', { class: 'foot-status ok' }, 'Saved. Takes effect on the next check.') : el('span', { class: 'foot-status' })
  const cancel = el('button', { class: 'ghost', type: 'button', onclick: () => act.cancel() }, s.saved ? 'Close' : 'Cancel')
  const save = el('button', { class: 'primary', type: 'button', disabled: act.busy, onclick: () => act.save() }, act.busy ? 'Saving…' : 'Save')

  const refresh = () => live.forEach((f) => f())
  const form = el(
    'div',
    { class: 'settings', oninput: refresh, onchange: refresh },
    problems,
    notes,
    el('h3', { class: 'settings-heading' }, 'Who does the work'),
    el('div', { class: 'roles' }, supervisor, workers, reviewers),
    el('h3', { class: 'settings-heading' }, 'Rules'),
    el('div', { class: 'groups' }, review, fixes, merging, project),
    danger,
    el('div', { class: 'settings-foot' }, status, cancel, save)
  )
  refresh()
  return form
}
