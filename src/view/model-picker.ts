// A model picker that fits a sidebar: a button that shows the chosen model's name, and under it,
// while open, a search box and a short scrollable list, grouped by provider when the ids carry
// one (OpenCode's "deepseek/…", "fireworks-ai/…"). Typing filters the list in place, without
// re-drawing the panel; arrows and Enter pick, Escape closes, and a typed id that is not in the
// list can be used as it is.
import type { AgentOption } from '../protocol.ts'
import { el } from './dom.ts'

export interface ModelChoice {
  id: string
  label: string
}

/** Which role's picker is open; one at a time. Keyed by the role object of the draft. */
const open = { key: null as object | null, query: '', active: 0, close: null as (() => void) | null }

// A click anywhere outside the open picker closes it.
document.addEventListener('mousedown', (e) => {
  if (open.key && !(e.target instanceof Element && e.target.closest('.picker'))) open.close?.()
})

const provider = (id: string): string | null => (id.includes('/') ? id.slice(0, id.indexOf('/')) : null)
/** The label without a "provider/" prefix it repeats from the group header. */
const shortLabel = (m: ModelChoice): string => {
  const p = provider(m.id)
  return p && m.label.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? m.label.slice(p.length + 1) : m.label
}

/** Every word of the query appears in the name or the id. */
export function matches(m: ModelChoice, query: string): boolean {
  const hay = `${m.label} ${m.id}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

const LIMIT = 200

export function modelPicker(
  key: object,
  agent: AgentOption | undefined,
  value: string | undefined,
  pick: (model: string | undefined) => void,
  redraw: () => void
): { button: HTMLElement; panel: HTMLElement | null } {
  const models: ModelChoice[] = agent?.models ?? []
  const current = models.find((m) => m.id === value)
  const isOpen = open.key === key
  const close = () => {
    open.key = null
    open.close = null
    redraw()
  }
  const button = el(
    'button',
    {
      class: `picker picker-button${isOpen ? ' open' : ''}`,
      type: 'button',
      title: value ? `${current?.label ?? value}\n${value}` : "The agent's own default model",
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        if (isOpen) return close()
        open.key = key
        open.query = ''
        open.active = 0
        open.close = close
        redraw()
      }
    },
    el('span', { class: value ? 'picker-label' : 'picker-label muted' }, value ? (current ? current.label : value) : 'Default model'),
    el('span', { class: 'muted' }, isOpen ? '▴' : '▾')
  )
  if (!isOpen) return { button, panel: null }

  const list = el('div', { class: 'picker-list', role: 'listbox' })
  type Row = { model: string | undefined; node: HTMLElement }
  let rows: Row[] = []

  const choose = (model: string | undefined) => {
    open.key = null
    open.close = null
    pick(model)
  }
  const highlight = () => rows.forEach((r, i) => r.node.classList.toggle('active', i === open.active))
  const fill = () => {
    const q = open.query.trim()
    const found = models.filter((m) => !q || matches(m, q))
    const nodes: HTMLElement[] = []
    rows = []
    const row = (model: string | undefined, main: string, sub: string | null, extra = '') => {
      const node = el('div', {
        class: `picker-row${model === value ? ' chosen' : ''}${extra}`,
        role: 'option',
        title: model ?? '',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => choose(model)
      }, el('span', { class: 'picker-main' }, main), sub ? el('span', { class: 'picker-sub muted' }, sub) : null)
      rows.push({ model, node })
      nodes.push(node)
    }
    if (!q) row(undefined, 'Default model', "whatever the agent picks itself")
    let group: string | null = null
    for (const m of found.slice(0, LIMIT)) {
      const p = provider(m.id)
      if (p !== group && p !== null) {
        nodes.push(el('div', { class: 'picker-group' }, p))
        group = p
      }
      row(m.id, shortLabel(m), m.label === m.id ? null : m.id)
    }
    if (found.length > LIMIT) nodes.push(el('div', { class: 'picker-note muted' }, `${found.length - LIMIT} more: keep typing to narrow it down`))
    if (q && !models.some((m) => m.id === q)) row(q, `Use "${q}"`, 'a model id the agent accepts', ' custom')
    if (found.length === 0 && models.length > 0) nodes.unshift(el('div', { class: 'picker-note muted' }, `No model matches "${q}".`))
    open.active = Math.min(open.active, Math.max(rows.length - 1, 0))
    list.replaceChildren(...nodes)
    highlight()
  }

  const search = el('input', {
    type: 'text',
    class: 'picker-search',
    placeholder: models.length ? `Search ${models.length} model${models.length === 1 ? '' : 's'} or type an id` : 'Type a model id, or leave empty for the default',
    oninput: (e) => {
      open.query = (e.target as HTMLInputElement).value
      open.active = 0
      fill()
    },
    onkeydown: (e) => {
      const k = (e as KeyboardEvent).key
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault()
        open.active = Math.max(0, Math.min(rows.length - 1, open.active + (k === 'ArrowDown' ? 1 : -1)))
        highlight()
        rows[open.active]?.node.scrollIntoView({ block: 'nearest' })
      } else if (k === 'Enter') {
        e.preventDefault()
        const r = rows[open.active]
        if (r) choose(r.model)
      } else if (k === 'Escape') {
        e.preventDefault()
        close()
      }
    }
  }) as HTMLInputElement
  search.value = open.query
  fill()
  // Focus the search box once it is on the page.
  setTimeout(() => {
    if (open.key === key && search.isConnected) search.focus()
  }, 0)
  return { button, panel: el('div', { class: 'picker picker-panel' }, search, list) }
}
