// The Matriarch view: one script for the sidebar panel and the full-tab editor (open a
// "Matriarch board" from the tab bar + menu). It is organised by project: a row of projects at
// the top picks one (or all of them, or adding a new one), and each project shows its
// supervisor, its settings and its own work as a swimlane timeline or a board by lane.
import type { MatriarchConfig } from '../config.ts'
import type { Board, ProjectInfo, RepoView, TrackView } from '../protocol.ts'
import { el, sv } from './dom.ts'
import { ago, bars, byGroup, concurrency, GROUPS, LANES, marksIn, scale, summary, ticks, type Group } from './layout.ts'
import { draftConfig, settingsForm, settingsState, type SettingsState } from './settings.ts'
import { CSS } from './style.ts'

const COLOR: Record<Group, string> = {
  blocked: 'var(--m-blocked)',
  fixing: 'var(--m-fixing)',
  review: 'var(--m-review)',
  active: 'var(--m-active)',
  waiting: 'var(--m-waiting)',
  ready: 'var(--m-ready)',
  quiet: 'var(--m-quiet)',
  done: 'var(--m-done)'
}
const STRIP: Group[] = ['blocked', 'fixing', 'review', 'active', 'waiting', 'ready']
const MARK_COLOR: Record<string, string> = {
  push: 'var(--m-active)',
  'ci-sent': 'var(--m-fixing)',
  'rebase-sent': 'var(--m-fixing)',
  'comments-sent': 'var(--m-fixing)',
  'review-start': 'var(--m-review)',
  'review-done': 'var(--m-review)',
  'update-branch': 'var(--m-waiting)',
  'escalate-supervisor': 'var(--m-blocked)',
  'escalate-human': 'var(--m-blocked)',
  merge: 'var(--m-ready)',
  notify: 'var(--m-done)'
}
const WINDOWS = [
  { label: '1h', ms: 3600_000 },
  { label: '6h', ms: 6 * 3600_000 },
  { label: '24h', ms: 24 * 3600_000 }
]

type Page = { kind: 'project'; repo: string } | { kind: 'all' } | { kind: 'add' }

const state = {
  board: null as Board | null,
  /** The page the person picked; null until they pick one (then a sensible default is shown). */
  page: null as Page | null,
  view: 'timeline' as 'timeline' | 'board',
  windowMs: 6 * 3600_000,
  confirming: false,
  busy: false,
  error: null as string | null,
  /** Why starting a supervisor failed, shown in its own box. */
  supervisorErrors: {} as Record<string, string>,
  /** The projects Orca knows, for the Add project page. */
  projects: null as ProjectInfo[] | null,
  /** The settings form, while it is open. */
  settings: null as SettingsState | null,
  /** The project of the workspace focused in Orca, as the worker could tell it. */
  focus: null as { repo: string | null; root: string | null; enabled: boolean; name: string | null; candidates: string[] } | null,
  /** A render was skipped while the person typed. */
  deferred: false
}

const PAGE_KEY = 'matriarch.page'
try {
  const saved = JSON.parse(localStorage.getItem(PAGE_KEY) ?? 'null') as Page | null
  if (saved && (saved.kind === 'all' || saved.kind === 'project')) state.page = saved
} catch {
  // storage unavailable: start on the default page
}

const style = document.createElement('style')
style.textContent = CSS
document.head.append(style)
const root = el('div', { class: 'app' })
document.body.append(root)

// Orca hands frames its theme's colors but not whether the theme is dark: tell from the background,
// and again whenever Orca changes the variables in place.
function syncDark(): void {
  if (!getComputedStyle(document.documentElement).getPropertyValue('--orca-background').trim()) return
  const probe = document.createElement('span')
  probe.style.color = 'var(--orca-background)'
  document.body.append(probe)
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number)
  probe.remove()
  if (!rgb || rgb.length < 3) return
  document.documentElement.classList.toggle('dark', 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128)
}
syncDark()
new MutationObserver(syncDark).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })

async function request<T>(fn: () => Promise<T>): Promise<T | null> {
  state.busy = true
  render(true)
  try {
    state.error = null
    return await fn()
  } catch (error) {
    state.error = (error as Error).message
    return null
  } finally {
    state.busy = false
    render(true)
  }
}

function go(page: Page): void {
  state.page = page
  if (state.settings && (page.kind !== 'project' || page.repo !== state.settings.repo)) state.settings = null
  try {
    if (page.kind !== 'add') localStorage.setItem(PAGE_KEY, JSON.stringify(page))
  } catch {
    // not remembered; fine
  }
  if (page.kind === 'add') void loadProjects()
  render(true)
}

/** The most useful page when none was picked: a project that needs you, else the first. */
function defaultPage(b: Board): Page {
  if (b.repos.length === 0) return { kind: 'add' }
  const urgent = b.attention.find((a) => a.repo)?.repo
  return { kind: 'project', repo: urgent ?? b.repos[0].repo }
}

/** The page to show: the one picked, while it still exists. */
function currentPage(b: Board): Page {
  const p = state.page
  if (p?.kind === 'add' || p?.kind === 'all') return p
  if (p?.kind === 'project' && b.repos.some((r) => r.repo === p.repo)) return p
  return defaultPage(b)
}

async function setAutopilot(on: boolean): Promise<void> {
  state.confirming = false
  const b = await request(() => orca.plugin.request('autopilot.set', { on }))
  if (b) state.board = b
}

function header(b: Board): HTMLElement {
  const toggle = b.autopilot
    ? el('button', { title: 'Stop acting; keep watching', onclick: () => void setAutopilot(false) }, 'Pause autopilot')
    : state.confirming
      ? el('button', { class: 'danger', onclick: () => void setAutopilot(true) }, 'Confirm: act on PRs')
      : el('button', {
          class: 'primary',
          title: 'Matriarch will message workers, start reviews, update branches and merge as each project is set up to, in every project',
          onclick: () => {
            state.confirming = true
            render(true)
            setTimeout(() => {
              state.confirming = false
              render()
            }, 6000)
          }
        }, 'Turn on autopilot')
  return el(
    'div',
    { class: 'header' },
    el('span', { class: 'title' }, 'Matriarch'),
    el('span', { class: 'pill', title: b.autopilot ? 'Acting on PRs in every project' : 'Watching only; each card shows what it would do' },
      el('span', { class: 'dot', style: `background:${b.autopilot ? 'var(--m-ready)' : 'var(--m-waiting)'}` }),
      b.autopilot ? 'Autopilot' : 'Dry run'),
    toggle,
    el('button', { class: 'ghost', title: 'Check GitHub and Orca now', disabled: state.busy, onclick: () => void request(async () => {
      state.board = await orca.plugin.request('board.refresh')
    }) }, 'Refresh'),
    el('span', { class: 'muted', title: new Date(b.at).toLocaleString() }, `updated ${ago(Date.now() - b.at)} ago`)
  )
}

const shortName = (repo: string): string => repo.split('/').pop() ?? repo

/** The last project focus resolved to: the panel follows a change of it, not every event. */
let followed: string | null = null

/** Shows the project of the workspace focused in Orca, when the worker can tell which it is. */
async function followFocus(): Promise<void> {
  try {
    state.focus = await orca.plugin.request('project.focused')
  } catch {
    return
  }
  const f = state.focus
  if (f.repo && f.repo !== followed) {
    followed = f.repo
    const on = f.enabled || state.board?.repos.some((r) => r.repo === f.repo)
    if (on && !state.settings) go({ kind: 'project', repo: f.repo })
  }
  render()
}

/** What the panel knows about Orca's focused workspace that the page does not already show. */
function focusNote(page: Page): HTMLElement | null {
  const f = state.focus
  if (!f) return null
  if (f.repo && !f.enabled && f.root && !state.board?.repos.some((r) => r.repo === f.repo)) {
    const root = f.root
    return el('div', { class: 'focus-note' },
      el('span', {}, `You are in ${f.repo}, where Matriarch is off.`),
      el('button', { class: 'primary', disabled: state.busy, onclick: () => void enable({ root, name: shortName(f.repo!), repo: f.repo, enabled: false, problem: null }) }, 'Turn it on'))
  }
  const shown = page.kind === 'project' ? page.repo : null
  if (!f.repo && f.candidates.length > 1 && !(shown && f.candidates.includes(shown) && followed === shown)) {
    return el('div', { class: 'focus-note muted' },
      `Orca does not say which project's "${f.name}" is focused: it could be ${f.candidates.map(shortName).join(' or ')}. Pick it above.`)
  }
  return null
}

/** The project switcher: each project, all of them, and adding one. */
function projectBar(b: Board, page: Page): HTMLElement {
  const needs = (repo: string) =>
    b.attention.some((a) => a.repo === repo) || b.tracks.some((t) => t.repo === repo && t.lane === 'needs-you') || (b.repos.find((r) => r.repo === repo)?.errors.length ?? 0) > 0
  return el(
    'div',
    { class: 'projects' },
    ...b.repos.map((r) =>
      el('button', {
        class: 'project-chip',
        'aria-pressed': page.kind === 'project' && page.repo === r.repo ? 'true' : 'false',
        title: `${r.repo}\n${r.root}`,
        onclick: () => {
          followed = r.repo
          go({ kind: 'project', repo: r.repo })
        }
      },
        needs(r.repo) ? el('span', { class: 'dot', style: 'background:var(--m-blocked)' }) : null,
        shortName(r.repo),
        el('span', { class: 'muted' }, String(b.tracks.filter((t) => t.repo === r.repo).length)))
    ),
    b.repos.length > 1
      ? el('button', { class: 'project-chip', 'aria-pressed': page.kind === 'all' ? 'true' : 'false', title: 'Every project on one timeline', onclick: () => go({ kind: 'all' }) }, 'All')
      : null,
    el('button', { class: page.kind === 'add' ? 'project-chip' : 'ghost', 'aria-pressed': page.kind === 'add' ? 'true' : 'false', onclick: () => go({ kind: 'add' }) }, '+ Add project')
  )
}

function chips(tracks: TrackView[], b: Board): HTMLElement {
  const c = summary(tracks)
  return el(
    'div',
    { class: 'chips' },
    ...GROUPS.filter((g) => c[g.id] > 0).map((g) =>
      el('span', { class: 'pill' }, el('span', { class: 'dot', style: `background:${COLOR[g.id]}` }), `${c[g.id]} ${g.label}`)
    ),
    b.rate
      ? el('span', {
          class: 'pill muted',
          title: [
            `GitHub API resets ${b.rate.resetAt}.`,
            b.github ? `Last check: ${b.github.unchanged} project(s) unchanged (checked free, with conditional requests), ${b.github.read} read in full.` : ''
          ].filter(Boolean).join(' ')
        }, `GitHub ${b.rate.remaining} left${b.github && b.github.read === 0 ? ' · no changes' : ''}`)
      : null
  )
}

function focusTerminal(handle: string): void {
  void request(async () => {
    const res = await orca.plugin.request('terminal.focus', { handle })
    if (!res.opened) state.error = 'Could not open that terminal; it may have closed.'
  })
}

/** What only a person can settle, each with a button that goes there. */
function attention(b: Board, repo: string | null): HTMLElement | null {
  const items = (b.attention ?? []).filter((a) => repo === null || a.repo === repo)
  if (items.length === 0) return null
  return el(
    'div',
    { class: 'callout attention' },
    el('b', {}, `Needs you (${items.length})`),
    el('ul', {},
      ...items.map((a) =>
        el('li', {},
          el('span', {}, a.message),
          a.terminal
            ? el('button', { class: 'primary', title: 'Bring that terminal to the front', onclick: () => focusTerminal(a.terminal!) }, 'Open it')
            : a.workspaceId
              ? el('button', { class: 'primary', onclick: () => void request(() => orca.plugin.request('track.open', { key: a.workspaceId! })) }, 'Open it')
              : null)))
  )
}

function problems(b: Board, repos: RepoView[], labelled: boolean): HTMLElement | null {
  const tag = (r: RepoView, m: string) => (labelled ? `${r.repo}: ${m}` : m)
  const errors = [...(state.error ? [state.error] : []), ...b.errors, ...repos.flatMap((r) => r.errors.map((e) => tag(r, e)))]
  const warnings = repos.flatMap((r) => r.warnings.map((w) => tag(r, w)))
  if (errors.length === 0 && warnings.length === 0) return null
  return el(
    'div',
    {},
    errors.length ? el('div', { class: 'callout' }, el('b', {}, 'Problems'), el('ul', {}, ...errors.map((e) => el('li', {}, e)))) : null,
    warnings.length ? el('div', { class: 'callout warn' }, el('b', {}, 'Settings notes'), el('ul', {}, ...warnings.map((w) => el('li', {}, w)))) : null
  )
}

function openTrack(t: TrackView): void {
  void request(() => orca.plugin.request('track.open', { key: t.workspace.id }))
}

function openPr(url: string): void {
  void orca.shell?.openExternal(url)
}

function rowLabel(t: TrackView): HTMLElement {
  if (t.role === 'supervisor') return el('span', {}, el('b', {}, 'Supervisor'), el('span', { class: 'muted' }, ` · ${t.workspace.name}`))
  return el(
    'span',
    {},
    t.pr ? el('b', {}, `#${t.pr.number} `) : null,
    t.pr ? t.pr.title || t.workspace.name : t.workspace.name
  )
}

/** A worktree with no PR and nothing happening is not work in flight: it folds away. */
const isIdle = (t: TrackView): boolean => !t.pr && t.lane === 'idle' && t.role !== 'supervisor'

/** The idle worktrees, folded into one line that opens to the list. */
function idleRows(tracks: TrackView[]): HTMLElement | null {
  const idle = tracks.filter(isIdle)
  if (idle.length === 0) return null
  return el('details', { class: 'idle-rows' },
    el('summary', { class: 'muted' }, `${idle.length} idle worktree${idle.length === 1 ? '' : 's'} (no PR, nothing running)`),
    el('ul', {}, ...idle.map((t) => el('li', {}, el('a', { title: 'Open the worktree in Orca', onclick: () => openTrack(t) }, t.workspace.name), t.workspace.branch ? el('span', { class: 'muted' }, ` · ${t.workspace.branch}`) : null))))
}

// Chart coordinates are percentages of each chart's width, so the timeline fills whatever
// width Orca gives the sidebar or the tab, and never needs a re-render to follow a resize.
const pct = (x: number): string => `${x.toFixed(3)}%`

function timeline(tracks: TrackView[], b: Board, headers: boolean): HTMLElement {
  const now = Date.now()
  const s = scale(now - state.windowMs, now, 0, 100)
  const offset = -new Date().getTimezoneOffset()
  const tks = ticks(s, 6, offset)

  const axis = sv(
    'svg',
    { class: 'chart', height: 18 },
    ...tks.map((t) =>
      sv('g', {}, sv('line', { x1: pct(t.x), x2: pct(t.x), y1: 12, y2: 18, class: 'grid-line' }), t.x < 92 ? sv('text', { x: pct(t.x), dx: 2, y: 10, class: 'axis-label' }, t.label) : null)
    )
  )

  const samples = concurrency(tracks, s, now, 120)
  const maxTotal = Math.max(1, ...samples.map((p) => STRIP.reduce((n, g) => n + p.counts[g], 0)))
  const stripH = 40
  const bw = 100 / samples.length
  const strip = sv(
    'svg',
    { class: 'chart', height: stripH },
    ...samples.flatMap((p, i) => {
      let y = stripH
      const parts: SVGElement[] = []
      for (const g of STRIP) {
        const n = p.counts[g]
        if (!n) continue
        const h = (n / maxTotal) * (stripH - 2)
        y -= h
        parts.push(sv('rect', { x: pct(i * bw), y, width: pct(bw * 0.9), height: h, fill: COLOR[g] }, sv('title', {}, `${new Date(p.t).toLocaleTimeString()}: ${n} ${GROUPS.find((x) => x.id === g)?.label}`)))
      }
      return parts
    })
  )

  const rows: HTMLElement[] = []
  let repo = ''
  for (const t of tracks) {
    if (headers && t.repo !== repo) {
      repo = t.repo
      const r = b.repos.find((x) => x.repo === repo)
      rows.push(el('div', { class: 'repo-row' }, repo, el('span', { class: 'muted' }, r ? ` · ${r.mergeMode} merge` : '')))
    }
    const svg = sv(
      'svg',
      { class: 'chart', height: 26 },
      ...tks.map((k) => sv('line', { x1: pct(k.x), x2: pct(k.x), y1: 0, y2: 26, class: 'grid-line', opacity: 0.5 })),
      ...bars(t.segments, s, now, 0.3).map((bar) => {
        // Idle and finished time is a thin line, so the eye goes to work that is happening.
        const thin = bar.group === 'quiet' || bar.group === 'done'
        return sv('rect', { x: pct(bar.x), y: thin ? 11 : 7, width: pct(bar.w), height: thin ? 4 : 12, rx: 2, fill: COLOR[bar.group] },
          sv('title', {}, `${LANES[bar.lane].label} for ${ago(bar.to - bar.from)}: ${bar.reason}`))
      }),
      ...marksIn(t.marks, s).map((m) =>
        sv('circle', { cx: pct(m.x), cy: 5, r: 3, fill: MARK_COLOR[m.kind] ?? 'var(--orca-foreground)', class: 'mark' },
          sv('title', {}, `${new Date(m.at).toLocaleTimeString()}: ${m.label}`))
      ),
      sv('line', { x1: '99.7%', x2: '99.7%', y1: 0, y2: 26, class: 'now-line' })
    )
    rows.push(
      el('div', { class: 'row' },
        el('div', { class: 'label', title: `${LANES[t.lane].label}: ${t.reason}\nClick to open the worktree`, onclick: () => openTrack(t) },
          el('span', { class: 'dot', style: `background:${COLOR[LANES[t.lane].group]};margin-right:6px` }), rowLabel(t)),
        svg)
    )
  }

  return el(
    'div',
    {},
    el('div', { class: 'legend' }, ...STRIP.map((g) => el('span', {}, el('span', { class: 'dot', style: `background:${COLOR[g]};margin-right:4px` }), GROUPS.find((x) => x.id === g)?.label ?? g))),
    el('div', { class: 'row', style: 'height:auto;border:0' },
      el('div', { class: 'label muted', title: 'How many worktrees were in each state at the same moment' }, `At once (peak ${maxTotal})`), strip),
    el('div', { class: 'row', style: 'height:auto;border:0' }, el('div', { class: 'label' }), axis),
    ...rows
  )
}

function card(t: TrackView): HTMLElement {
  const lane = LANES[t.lane]
  const pr = t.pr
  const rounds = Object.entries(t.rounds).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ')
  return el(
    'div',
    { class: 'card', style: `--lane:${COLOR[lane.group]}` },
    el('div', { class: 'top' },
      pr ? el('a', { title: 'Open the PR on GitHub', onclick: () => openPr(pr.url) }, `#${pr.number}`) : null,
      el('span', { class: 'name', title: pr?.title ?? t.workspace.name }, t.role === 'supervisor' ? 'Supervisor' : pr?.title || t.workspace.name)),
    // Without a PR the title already is the worktree's name, so it is not repeated here.
    el('div', { class: 'muted' }, el('a', { title: 'Open the worktree in Orca', onclick: () => openTrack(t) }, pr || t.role === 'supervisor' ? t.workspace.name : 'Open the worktree'), t.workspace.branch ? ` · ${t.workspace.branch}` : ''),
    el('div', { class: 'chips' },
      el('span', { class: 'pill' }, lane.label),
      pr ? el('span', { class: 'pill', title: pr.failing.join(', ') }, `CI ${pr.ci}${pr.failing.length ? ` (${pr.failing.length})` : ''}`) : null,
      pr && pr.openThreads ? el('span', { class: 'pill' }, `${pr.openThreads} comment(s)`) : null,
      t.owner ? el('span', { class: 'pill', title: t.owner.supervised ? 'Supervised orchestration worker' : 'Agent without orchestration supervision' },
        `${t.owner.agent ?? 'worker'}${t.owner.model ? ` · ${t.owner.model}` : ''} · ${t.owner.activity}`) : null,
      t.review ? el('span', { class: 'pill' }, `review r${t.review.round} ${t.review.verdict ?? t.review.status}`) : null),
    el('div', { class: 'reason' }, t.reason),
    t.review && t.review.reviewers.length
      ? el('div', { class: 'chips', title: t.review.summary ?? '' },
          ...t.review.reviewers.map((r) =>
            el('span', { class: 'pill', title: [r.blocked ?? r.error ?? '', r.lock ?? ''].filter(Boolean).join('\n') },
              el('span', { class: 'dot', style: `background:${r.status === 'running' ? 'var(--m-review)' : r.status === 'failed' ? 'var(--m-blocked)' : r.verdict === 'approve' ? 'var(--m-ready)' : 'var(--m-fixing)'}` }),
              `${r.lock?.startsWith('read-only') ? '🔒 ' : ''}${r.name} · ${r.agent}${r.model ? ` ${r.model}` : ''} · ${r.status === 'running' ? (r.blocked ? 'waiting for you' : 'reviewing') : r.status === 'failed' ? 'failed' : r.verdict === 'approve' ? 'approve' : `changes (${r.findings ?? 0})`}`)
          ),
          ...t.review.reviewers
            .filter((r) => r.blocked)
            .flatMap((r) => [
              r.terminal ? el('button', { class: 'primary', title: r.blocked, onclick: () => focusTerminal(r.terminal!) }, `Open ${r.name}`) : null,
              el('button', { title: `Start ${r.name} again in the same worktree, read-only, once its account or prompt is sorted`, onclick: () => restartReviewer(t, r.name) }, `Restart ${r.name}`)
            ]))
      : null,
    t.review?.summary ? el('div', { class: 'muted' }, t.review.summary) : null,
    t.review?.findings?.length
      ? el('details', { class: 'findings' },
          el('summary', {}, `Findings (${t.review.findings.length})`),
          el('ul', {},
            ...t.review.findings.map((f) =>
              el('li', { title: [f.detail, f.suggestion ? `Suggested fix: ${f.suggestion}` : ''].filter(Boolean).join('\n\n') },
                el('span', { class: `sev sev-${f.severity}` }, f.severity),
                ' ',
                el('b', {}, f.title),
                el('div', { class: 'muted' }, `${f.file ?? 'general'}${f.line ? `:${f.line}` : ''} · ${f.reviewers.join(', ')}`)))))
      : null,
    rounds ? el('div', { class: 'muted' }, `rounds used: ${rounds}`) : null,
    t.next.length ? el('div', { class: 'next' }, el('span', { class: 'muted' }, 'Would do next:'), el('ul', {}, ...t.next.map((n) => el('li', {}, n)))) : null,
    pr && t.review?.status !== 'running' && ['ai-review', 'ready', 'fixing-review', 'needs-you', 'awaiting-ci'].includes(t.lane)
      ? el('div', {}, el('button', { class: 'ghost', title: 'Run the review crew on this commit now; findings stay on this board until autopilot is on', onclick: () => void runReview(t) }, 'Run AI review now'))
      : null
  )
}

function restartReviewer(t: TrackView, name: string): void {
  if (!t.pr) return
  const number = t.pr.number
  void request(async () => {
    const res = await orca.plugin.request('review.restartReviewer', { repo: t.repo, number, reviewer: name })
    if (!res.restarted) state.error = res.message
    state.board = await orca.plugin.request('board.get')
  })
}

function runReview(t: TrackView): void {
  if (!t.pr) return
  const number = t.pr.number
  void request(async () => {
    const res = await orca.plugin.request('review.start', { repo: t.repo, number })
    if (!res.started) state.error = res.message
    state.board = await orca.plugin.request('board.get')
  })
}

function boardView(tracks: TrackView[]): HTMLElement {
  return el(
    'div',
    { class: 'columns' },
    ...byGroup(tracks, true).map((g) =>
      el('div', { class: g.tracks.length ? 'column' : 'column empty' },
        el('h3', {}, el('span', { class: 'dot', style: `background:${COLOR[g.group]}` }), g.label, el('span', { class: 'muted' }, String(g.tracks.length))),
        ...g.tracks.map(card))
    )
  )
}

function tabs(): HTMLElement {
  const tab = (id: 'timeline' | 'board', label: string) =>
    el('button', { 'aria-pressed': state.view === id ? 'true' : 'false', onclick: () => { state.view = id; render(true) } }, label)
  return el(
    'div',
    { class: 'tabs' },
    tab('timeline', 'Timeline'),
    tab('board', 'Board'),
    el('span', { class: 'spacer' }),
    ...(state.view === 'timeline'
      ? WINDOWS.map((w) => el('button', { class: 'ghost', 'aria-pressed': state.windowMs === w.ms ? 'true' : 'false', onclick: () => { state.windowMs = w.ms; render(true) } }, w.label))
      : [])
  )
}

function work(tracks: TrackView[], b: Board, headers: boolean): HTMLElement[] {
  return [tabs(), state.view === 'timeline' ? timeline(tracks, b, headers) : boardView(tracks)]
}

function supervisorCard(r: RepoView): HTMLElement {
  const s = r.supervisor
  const phase = s.run ? 'running' : s.pending ? 'starting' : 'idle'
  const badge = { running: 'Running', starting: 'Chat open', idle: 'Not running' }[phase]
  const who = `${s.agent}${s.model ? ` · ${s.model}` : ''}`
  const error = state.supervisorErrors[r.repo]
  const openChat = () =>
    void request(async () => {
      const res = await orca.plugin.request('supervisor.start', { repo: r.repo })
      if (res.started) delete state.supervisorErrors[r.repo]
      else state.supervisorErrors[r.repo] = res.message
      state.board = await orca.plugin.request('board.get')
    })
  const reopen = () =>
    void request(async () => {
      const res = await orca.plugin.request('supervisor.open', { repo: r.repo })
      if (!res.opened) state.supervisorErrors[r.repo] = 'Could not find the supervisor chat; it may have been closed.'
    })
  return el(
    'div',
    { class: 'sup' },
    el('div', { class: 'sup-head' },
      el('b', {}, 'Supervisor'),
      el('span', { class: `badge badge-${phase}` }, badge),
      el('span', { class: 'muted' }, who),
      phase === 'running' ? el('span', { class: 'muted' }, `· ${s.workers} worker${s.workers === 1 ? '' : 's'}`) : null,
      el('span', { class: 'spacer' }),
      phase === 'idle'
        ? el('button', { class: 'primary', disabled: state.busy || r.empty === true, title: r.empty ? 'Push a first commit to GitHub first' : 'Opens a briefed chat; nothing starts until you agree a plan there', onclick: openChat }, 'Open supervisor chat')
        : el('button', { class: 'primary', onclick: reopen }, 'Open'),
      phase === 'idle' ? null : el('button', { class: 'ghost', disabled: state.busy, title: 'Start a fresh supervisor chat; Matriarch links the new one instead', onclick: openChat }, 'New chat')),
    el('div', { class: 'muted' },
      r.empty
        ? 'This project has no commits on GitHub yet. Push a first commit to main, then start the supervisor.'
        : phase === 'idle'
          ? 'Tell it what to build in its chat. It proposes a plan and starts workers only after you agree. Each worker opens a PR, and Matriarch takes it from there.'
          : phase === 'starting'
            ? 'Talk to it in its chat. Matriarch links it here once you agree a plan and it creates its orchestration Run.'
            : `Running in ${s.run}. Its workers show below as worktrees, then as PRs.`),
    error ? el('div', { class: 'sup-hint' }, error) : null
  )
}

// Each action changes state inside request(), which re-draws once it is done.
async function openSettings(repo: string): Promise<void> {
  await request(async () => {
    const res = await orca.plugin.request('config.get', { repo })
    state.settings = settingsState(repo, res.config, res.agents, res.errors, res.warnings)
  })
}

async function saveSettings(s: SettingsState): Promise<void> {
  const { config, problems } = draftConfig(s)
  if (problems.length) {
    s.errors = problems
    render(true)
    return
  }
  await request(async () => {
    const res = await orca.plugin.request('config.save', { repo: s.repo, config: config as MatriarchConfig })
    s.errors = res.errors
    s.warnings = res.warnings
    s.saved = res.saved
    if (res.saved) state.board = await orca.plugin.request('board.get')
  })
}

async function turnOff(repo: string): Promise<void> {
  await request(async () => {
    const res = await orca.plugin.request('project.disable', { repo })
    if (!res.ok) throw new Error(res.message)
    state.settings = null
    state.page = null
    state.board = await orca.plugin.request('board.get')
  })
}

function projectPage(b: Board, r: RepoView): HTMLElement[] {
  const tracks = b.tracks.filter((t) => t.repo === r.repo)
  const open = state.settings?.repo === r.repo ? state.settings : null
  return [
    el('div', { class: 'project-head' },
      el('b', {}, r.repo),
      el('span', { class: 'pill', title: 'Who merges; change it in Settings' }, r.mergeMode === 'auto' ? 'auto merge' : 'you merge'),
      el('span', { class: 'spacer' }),
      el('button', {
        class: open ? 'project-chip' : 'ghost',
        'aria-pressed': open ? 'true' : 'false',
        title: 'Who supervises, builds and reviews, on which models; review and merge rules',
        onclick: () => (open ? ((state.settings = null), render(true)) : void openSettings(r.repo))
      }, 'Settings')),
    el('div', { class: 'muted path head-path', title: r.root }, r.root),
    open
      ? settingsForm(open, {
          busy: state.busy,
          redraw: () => render(true),
          save: () => void saveSettings(open),
          cancel: () => { state.settings = null; render(true) },
          turnOff: () => void turnOff(r.repo)
        })
      : null,
    attention(b, r.repo),
    // With the form open, its own notes replace the project's.
    problems(b, [open ? { ...r, warnings: [] } : r], false),
    supervisorCard(r),
    tracks.length ? chips(tracks.filter((t) => !isIdle(t)), b) : null,
    ...(tracks.some((t) => !isIdle(t))
      ? work(tracks.filter((t) => !isIdle(t)), b, false)
      : [el('div', { class: 'empty muted' }, tracks.length ? 'Nothing in flight right now.' : 'No work here yet. Open the supervisor chat and tell it what to build: each worker shows up here as a worktree, then as a PR.')]),
    idleRows(tracks)
  ].filter((x): x is HTMLElement => x !== null)
}

function allPage(b: Board): HTMLElement[] {
  return [
    chips(b.tracks.filter((t) => !isIdle(t)), b),
    attention(b, null),
    problems(b, b.repos, true),
    ...(b.tracks.some((t) => !isIdle(t)) ? work(b.tracks.filter((t) => !isIdle(t)), b, true) : [el('div', { class: 'empty muted' }, 'Nothing in flight in any project.')]),
    idleRows(b.tracks)
  ].filter((x): x is HTMLElement => x !== null)
}

async function loadProjects(): Promise<void> {
  await request(async () => {
    state.projects = (await orca.plugin.request('projects.list')).projects
  })
}

async function enable(p: ProjectInfo): Promise<void> {
  let repo: string | null = null
  await request(async () => {
    const res = await orca.plugin.request('project.enable', { root: p.root })
    if (!res.ok || !res.repo) throw new Error(res.message)
    repo = res.repo
    state.board = await orca.plugin.request('board.get')
  })
  if (!repo) return
  go({ kind: 'project', repo })
  // Straight to its settings: choosing agents and models is the next step.
  await openSettings(repo)
}

function addPage(b: Board): HTMLElement[] {
  const list = state.projects
  return [
    el('div', { class: 'add' },
      el('b', {}, 'Add a project'),
      el('p', { class: 'muted' }, 'These are the projects open in Orca. Turn Matriarch on for one, then choose its agents and models in its settings.'),
      state.error ? el('div', { class: 'callout' }, state.error) : null,
      list === null
        ? el('div', { class: 'muted' }, 'Looking at your Orca projects…')
        : list.length === 0
          ? el('div', { class: 'muted' }, 'Orca has no projects on this machine yet. Add one in Orca first.')
          : el('div', { class: 'project-list' },
              ...list.map((p) =>
                el('div', { class: 'project-item' },
                  el('div', { class: 'grow' },
                    el('b', {}, p.name),
                    p.repo ? el('span', { class: 'muted' }, ` · ${p.repo}`) : null,
                    el('div', { class: 'muted path', title: p.root }, p.root),
                    p.problem ? el('div', { class: 'warn-text' }, p.problem) : null),
                  p.enabled
                    ? el('button', { onclick: () => p.repo && go({ kind: 'project', repo: p.repo }) }, 'Open')
                    : p.repo
                      ? el('button', { class: 'primary', disabled: state.busy, onclick: () => void enable(p) }, 'Turn on')
                      : null))),
      b.repos.length ? el('div', {}, el('button', { class: 'ghost', onclick: () => go(defaultPage(b)) }, 'Back')) : null)
  ]
}

function render(force = false): void {
  syncDark()
  // Re-rendering replaces the DOM; never do it under the person's cursor unless they acted.
  const active = document.activeElement
  if (!force && active && root.contains(active) && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active instanceof HTMLSelectElement)) {
    state.deferred = true
    return
  }
  state.deferred = false
  const b = state.board
  if (!b) {
    root.replaceChildren(el('div', { class: 'muted' }, state.error ? `Could not reach the Matriarch worker: ${state.error}` : 'Loading…'))
    return
  }
  if (!b.ready) {
    root.replaceChildren(header(b), el('div', { class: 'muted' }, 'Checking your projects and PRs…'))
    return
  }
  const page = currentPage(b)
  if (page.kind === 'add' && state.projects === null && !state.busy) void loadProjects()
  const repo = page.kind === 'project' ? b.repos.find((r) => r.repo === page.repo)! : null
  root.replaceChildren(
    header(b),
    projectBar(b, page),
    focusNote(page) ?? '',
    ...(page.kind === 'add' ? addPage(b) : page.kind === 'all' ? allPage(b) : projectPage(b, repo!))
  )
}

// A render put off while the person typed happens once they leave the field.
root.addEventListener('focusout', () => {
  if (state.deferred) setTimeout(() => render(), 0)
})
// Follow the workspace focused in Orca (the subscription first delivers the current one).
orca.on('workspace.changed', () => void followFocus())
orca.plugin.on('board.changed', (b) => {
  state.board = b
  render()
})
// Keeps "updated … ago" and the open bars current; the layout itself follows resizes in CSS.
setInterval(() => render(), 15_000)
void request(async () => {
  state.board = await orca.plugin.request('board.get')
})
