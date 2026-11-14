// Away alerts, for every project: a webhook (Slack, Discord, ntfy or any URL that takes JSON) that
// gets what reaches you in Orca's notifications. The URL goes to the worker once, on Save or Send
// a test, and the worker keeps it in Orca's encrypted secrets: this form only ever shows its host.
import type { AlertFormat, AlertsView } from '../protocol.ts'
import { el, textInput, toggle } from './dom.ts'
import { choice, row } from './settings.ts'

type AlertEvent = keyof AlertsView['events']

export interface AlertsState {
  /** As last loaded or saved. */
  view: AlertsView
  format: AlertFormat | 'auto'
  events: Record<AlertEvent, boolean>
  /** A new URL being typed; null keeps the saved one. */
  url: string | null
  /** Remove the saved URL on Save. */
  remove: boolean
  error: string | null
  saved: boolean
  test: { busy: boolean; ok: boolean | null; message: string | null }
}

export interface AlertsActions {
  busy: boolean
  redraw(): void
  save(): void
  test(): void
  close(): void
}

const LABEL: Record<AlertFormat, string> = { slack: 'Slack', discord: 'Discord', ntfy: 'ntfy', json: 'JSON' }

const EVENTS: { key: AlertEvent; label: string; hint: string }[] = [
  { key: 'needs-you', label: 'Needs you', hint: 'An escalation that reached you, a reviewer stuck on a prompt, a PR that needs your merge or is blocked.' },
  { key: 'ready', label: 'Ready to merge', hint: 'A PR that passed CI and review, when you merge.' },
  { key: 'merged', label: 'Merged', hint: 'A PR Matriarch follows merged, by it or by anyone.' }
]

export function alertsState(view: AlertsView): AlertsState {
  return {
    view,
    format: view.format,
    events: { ...view.events },
    url: view.host ? null : '',
    remove: false,
    error: null,
    saved: false,
    test: { busy: false, ok: null, message: null }
  }
}

/** What Save sends: a URL only when a new one was typed, an empty one only to remove it. */
export function alertsSave(s: AlertsState): { format: AlertFormat | 'auto'; events: Record<AlertEvent, boolean>; url?: string } {
  const base = { format: s.format, events: s.events }
  if (s.remove) return { ...base, url: '' }
  return s.url?.trim() ? { ...base, url: s.url.trim() } : base
}

export function alertsForm(s: AlertsState, act: AlertsActions): HTMLElement {
  const v = s.view
  const typing = s.url !== null && s.url.trim() !== ''
  const urlControl = s.remove
    ? el('div', { class: 'set-control hook-set' }, el('span', { class: 'muted hook-host' }, 'Removed when you save.'),
        el('button', { class: 'ghost', type: 'button', onclick: () => { s.remove = false; act.redraw() } }, 'Undo'))
    : s.url === null
      ? el('div', { class: 'set-control hook-set' },
          el('span', { class: 'hook-host', title: 'Only the host is shown: the full URL stays in Orca\'s encrypted secrets' }, '🔒 ', el('b', {}, v.host ?? '')),
          el('button', { type: 'button', onclick: () => { s.url = ''; act.redraw() } }, 'Replace'),
          el('button', { class: 'quiet-danger', type: 'button', onclick: () => { s.remove = true; act.redraw() } }, 'Remove'))
      : textInput(s.url, (x) => (s.url = x), { placeholder: 'https://hooks.slack.com/services/…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Webhook URL', class: 'hook-url' })

  const auto = v.detected && !typing && !s.remove ? `found from the URL (${LABEL[v.detected]})` : 'found from the URL'
  const testLine = s.test.busy
    ? el('span', { class: 'muted' }, 'Sending…')
    : s.test.message
      ? el('span', { class: s.test.ok ? 'ok-text' : 'warn-text' }, s.test.message)
      : null

  return el(
    'div',
    { class: 'settings alerts' },
    el('div', { class: 'alerts-head' }, el('b', {}, 'Away alerts'), el('span', { class: 'muted' }, 'for every project')),
    el('p', { class: 'set-hint' },
      'What reaches you in Orca\'s notifications can also go to Slack, Discord, ntfy or any webhook that takes JSON, for when you are away from your desk. Orca\'s notifications still come either way.'),
    v.secure ? null : el('div', { class: 'callout warn' }, 'Orca cannot keep secrets encrypted on this machine (there is no OS key store), so Matriarch does not keep a webhook URL here.'),
    s.error ? el('div', { class: 'callout' }, s.error) : null,
    v.lastError && !s.error
      ? el('div', { class: 'callout warn' }, el('b', {}, 'The last alert did not arrive'), el('div', {}, `${new Date(v.lastError.at).toLocaleString()}: ${v.lastError.message}`))
      : null,
    el('div', { class: 'group-body flat' },
      s.url === null || s.remove
        ? el('div', { class: 'set stack' }, el('div', { class: 'set-text' }, el('span', { class: 'set-label' }, 'Webhook'),
            el('span', { class: 'set-hint' }, 'Kept encrypted in Orca\'s secrets; only its host is shown again.')), urlControl)
        : row('Webhook URL', v.host ? `Replaces the one on ${v.host}. Kept encrypted in Orca's secrets; only its host is shown again.` : "Kept encrypted in Orca's secrets; only its host is shown again.", urlControl, {
            stack: true,
            after: v.host ? [el('button', { class: 'ghost', type: 'button', onclick: () => { s.url = null; act.redraw() } }, 'Keep the old one')] : []
          }),
      choice('Format', 'Slack, Discord and ntfy.sh are told apart by their address. Pick ntfy for your own ntfy server.', s.format, [
        ['auto', auto],
        ['slack', 'Slack'],
        ['discord', 'Discord'],
        ['ntfy', 'ntfy (ntfy.sh or your own server)'],
        ['json', 'JSON: kind, title, body, repo, number, url']
      ], (x) => (s.format = x)),
      el('div', { class: 'group-sub' }, 'Send'),
      ...EVENTS.map((e) => row(e.label, e.hint, toggle(s.events[e.key], (on) => (s.events[e.key] = on))))),
    el('div', { class: 'alerts-test' },
      el('button', {
        type: 'button',
        disabled: act.busy || s.test.busy || s.remove || (s.url !== null && !typing),
        title: typing ? 'Posts a test alert to the URL you typed, without saving it' : 'Posts a test alert to the saved webhook',
        onclick: () => act.test()
      }, 'Send a test'),
      testLine),
    el('div', { class: 'settings-foot' },
      el('span', { class: `foot-status${s.saved ? ' ok' : ''}` }, s.saved ? 'Saved.' : ''),
      el('button', { class: 'ghost', type: 'button', onclick: () => act.close() }, 'Close'),
      el('button', { class: 'primary', type: 'button', disabled: act.busy || !v.secure && typing, onclick: () => act.save() }, act.busy ? 'Saving…' : 'Save'))
  )
}
