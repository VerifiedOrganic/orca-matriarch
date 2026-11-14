// Away alerts: what reaches you in Orca's notifications can also go to a webhook (Slack, Discord,
// ntfy, or any URL that takes JSON), for when you are away from the desk. Off until you set a URL,
// always in addition to Orca's notification, never instead.
//
// The URL is a secret: anyone who has a Slack or Discord webhook URL can post to that channel. It
// lives in Orca's encrypted secrets (the OS key store), never in plugin storage or a project's
// config file, and only its host is ever shown or logged. Each alert is posted once, with a time
// limit, and never retried: a webhook that is down costs one failed post per alert, and the last
// failure shows in the alert settings.
import type { JsonValue } from 'orca/host'

export type AlertFormat = 'slack' | 'discord' | 'ntfy' | 'json'
export type AlertEvent = 'needs-you' | 'ready' | 'merged'

/** One alert: the same title and text as Orca's notification, and the PR it is about. */
export interface Alert {
  kind: AlertEvent | 'test'
  title: string
  body: string
  /** The project, as the board names it. */
  repo?: string
  number?: number
  /** The PR's page. */
  url?: string
}

/** What is kept in plugin storage: everything but the URL. */
export interface AlertSettings {
  /** `auto` picks the format from the URL's host. */
  format: AlertFormat | 'auto'
  events: Record<AlertEvent, boolean>
}

/** The alert settings as the panel shows them: the URL never leaves the worker, only its host. */
export interface AlertsView extends AlertSettings {
  /** The webhook's host when one is set. */
  host: string | null
  /** The format alerts go out in for this URL. */
  detected: AlertFormat | null
  /** The last post that failed; a post that works clears it. */
  lastError: { at: number; message: string } | null
  /** False when Orca cannot keep secrets encrypted here, so no URL can be saved. */
  secure: boolean
}

/** What the panel sends to save: `url` absent keeps the saved one, empty removes it. */
export interface AlertsSave extends AlertSettings {
  url?: string
}

export const ALERTS_KEY = 'alerts'
export const ALERTS_ERROR_KEY = 'alerts:lastError'
/** The name of the secret that holds the webhook URL. */
export const ALERTS_URL_SECRET = 'alerts.webhook'
export const ALERT_TIMEOUT_MS = 10_000
/** Posts at once; more are dropped (and logged) rather than queued behind a webhook that hangs. */
const MAX_IN_FLIGHT = 4
const MAX_TEXT = 1500

export const DEFAULT_ALERTS: AlertSettings = { format: 'auto', events: { 'needs-you': true, ready: true, merged: false } }

export const FORMAT_LABEL: Record<AlertFormat, string> = { slack: 'Slack', discord: 'Discord', ntfy: 'ntfy', json: 'JSON' }

/** The format a webhook URL takes, from its host; anything unknown gets plain JSON. */
export function detectFormat(url: string): AlertFormat {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'json'
  }
  const host = u.hostname.toLowerCase()
  if (host === 'hooks.slack.com') return 'slack'
  if (['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(host) && u.pathname.startsWith('/api/webhooks/')) return 'discord'
  if (host === 'ntfy.sh') return 'ntfy'
  return 'json'
}

/** Why a URL cannot be used, or null. Only http(s): a plain-http one is allowed, for an ntfy on your network. */
export function checkUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'That is not a web address. Paste the whole webhook URL, starting with https://.'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The webhook URL must start with https:// (or http:// for a server on your network).'
  return null
}

/** The host to show for a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the webhook'
  }
}

const clip = (s: string, n = MAX_TEXT): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Slack's mrkdwn: only these three are special. */
const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** A header value as ntfy reads one: ASCII as is, anything else RFC 2047-encoded. */
const headerValue = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
const linkText = (a: Alert): string => (a.number !== undefined ? `Open #${a.number}` : 'Open')

/** The request for one alert in one format. */
export function payload(format: AlertFormat, a: Alert): { headers: Record<string, string>; body: string } {
  const title = clip(a.title, 200)
  const body = clip(a.body)
  switch (format) {
    case 'slack':
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: [`*${slackEscape(title)}*`, slackEscape(body), a.url ? `<${a.url}|${linkText(a)}>` : ''].filter(Boolean).join('\n') })
      }
    case 'discord':
      // No mentions: a PR title that says @everyone must not ping the channel.
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: clip([`**${title}**`, body, a.url ?? ''].filter(Boolean).join('\n'), 2000), allowed_mentions: { parse: [] } })
      }
    case 'ntfy':
      return {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          title: headerValue(title),
          ...(a.url ? { click: a.url } : {}),
          ...(a.kind === 'needs-you' ? { priority: 'high', tags: 'warning' } : {})
        },
        body
      }
    case 'json':
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: a.kind, title, body, repo: a.repo ?? null, number: a.number ?? null, url: a.url ?? null })
      }
  }
}

/** Stored settings, with anything missing or wrong taken from the defaults. */
export function loadAlertSettings(raw: unknown): AlertSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Partial<AlertSettings>) : {}
  const format = r.format && ['auto', 'slack', 'discord', 'ntfy', 'json'].includes(r.format) ? r.format : DEFAULT_ALERTS.format
  const events = { ...DEFAULT_ALERTS.events }
  for (const k of Object.keys(events) as AlertEvent[]) if (typeof r.events?.[k] === 'boolean') events[k] = r.events[k]
  return { format, events }
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number }>
}

export interface AlerterDeps {
  fetch: FetchLike
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: JsonValue): Promise<void> }
  /** Whether Orca keeps secrets encrypted here; true when it cannot tell. */
  secure?: () => Promise<boolean>
  log(message: string): void
  now(): number
  timeoutMs?: number
}

export interface Alerter {
  /** Posts an alert when a URL is set and its kind is switched on. Never throws, never waits on the post. */
  send(alert: Alert): void
  /** The settings for the panel. */
  view(): Promise<AlertsView>
  /** Saves the settings (and the URL, as a secret); answers why not, else null. */
  save(next: AlertsSave): Promise<string | null>
  /** Posts a test alert now, to the URL given or the saved one, and waits for the answer. */
  test(url?: string, format?: AlertFormat | 'auto'): Promise<{ ok: boolean; error: string | null }>
  /** Resolves once every post in flight has finished (tests). */
  idle(): Promise<void>
}

export function createAlerter(deps: AlerterDeps): Alerter {
  const timeoutMs = deps.timeoutMs ?? ALERT_TIMEOUT_MS
  const inFlight = new Set<Promise<void>>()

  /** Posts once; the answer never carries the URL, which a secret path can be part of. */
  async function post(url: string, settings: Pick<AlertSettings, 'format'>, alert: Alert): Promise<{ ok: boolean; error: string | null }> {
    const format = settings.format === 'auto' ? detectFormat(url) : settings.format
    const { headers, body } = payload(format, alert)
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // The time limit holds even for a client that does not stop on the abort.
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })
    try {
      const res = await Promise.race([deps.fetch(url, { method: 'POST', headers, body, signal: ctl.signal }), late])
      return res.ok ? { ok: true, error: null } : { ok: false, error: `${hostOf(url)} answered HTTP ${res.status}` }
    } catch (error) {
      if (ctl.signal.aborted) return { ok: false, error: `${hostOf(url)} did not answer within ${timeoutMs / 1000} s` }
      const e = error as Error & { cause?: { code?: string } }
      const why = e.cause?.code ?? e.message
      return { ok: false, error: `could not reach ${hostOf(url)}: ${why.split(url).join(hostOf(url))}` }
    } finally {
      clearTimeout(timer)
    }
  }

  async function noteResult(r: { ok: boolean; error: string | null }): Promise<void> {
    if (r.ok) {
      if (await deps.storage.get(ALERTS_ERROR_KEY)) await deps.storage.set(ALERTS_ERROR_KEY, null)
      return
    }
    await deps.storage.set(ALERTS_ERROR_KEY, { at: deps.now(), message: r.error ?? 'failed' })
  }

  return {
    send(alert) {
      if (inFlight.size >= MAX_IN_FLIGHT) {
        deps.log(`away alert dropped (${MAX_IN_FLIGHT} still being sent): ${alert.title}`)
        return
      }
      const job = (async () => {
        const settings = loadAlertSettings(await deps.storage.get(ALERTS_KEY))
        if (alert.kind !== 'test' && !settings.events[alert.kind]) return
        const url = await deps.secrets.get(ALERTS_URL_SECRET)
        if (!url) return
        const r = await post(url, settings, alert)
        if (!r.ok) deps.log(`away alert not delivered: ${r.error}`)
        await noteResult(r)
      })()
        .catch((error: Error) => deps.log(`away alert: ${error.message}`))
        .finally(() => inFlight.delete(job))
      inFlight.add(job)
    },

    async view() {
      const settings = loadAlertSettings(await deps.storage.get(ALERTS_KEY))
      const url = await deps.secrets.get(ALERTS_URL_SECRET).catch(() => null)
      const err = (await deps.storage.get(ALERTS_ERROR_KEY)) as { at?: unknown; message?: unknown } | null
      return {
        ...settings,
        host: url ? hostOf(url) : null,
        detected: url ? (settings.format === 'auto' ? detectFormat(url) : settings.format) : null,
        lastError: err && typeof err.at === 'number' && typeof err.message === 'string' ? { at: err.at, message: err.message } : null,
        secure: deps.secure ? await deps.secure().catch(() => true) : true
      }
    },

    async save(next) {
      const settings = loadAlertSettings(next)
      if (next.url !== undefined) {
        const url = next.url.trim()
        if (!url) {
          await deps.secrets.delete(ALERTS_URL_SECRET)
          await deps.storage.set(ALERTS_ERROR_KEY, null)
        } else {
          const bad = checkUrl(url)
          if (bad) return bad
          if (deps.secure && !(await deps.secure().catch(() => true))) {
            return 'Orca cannot keep secrets encrypted on this machine (no OS key store), so Matriarch does not keep a webhook URL here.'
          }
          try {
            await deps.secrets.set(ALERTS_URL_SECRET, url)
          } catch (error) {
            return `Orca could not store the webhook URL: ${(error as Error).message.split(url).join(hostOf(url))}`
          }
          // A new URL starts with a clean record.
          await deps.storage.set(ALERTS_ERROR_KEY, null)
        }
      }
      await deps.storage.set(ALERTS_KEY, settings as unknown as JsonValue)
      return null
    },

    async test(url, format) {
      const target = url?.trim() || (await deps.secrets.get(ALERTS_URL_SECRET))
      if (!target) return { ok: false, error: 'Set a webhook URL first.' }
      const bad = checkUrl(target)
      if (bad) return { ok: false, error: bad }
      const settings = loadAlertSettings(await deps.storage.get(ALERTS_KEY))
      const r = await post(target, { format: format ?? settings.format }, {
        kind: 'test',
        title: 'Matriarch: test alert',
        body: 'Away alerts work. Matriarch posts here when something needs you, and for the other events you switched on.'
      })
      // Only the saved URL's record changes; a URL still being typed has none yet.
      if (!url?.trim()) await noteResult(r)
      return r
    },

    async idle() {
      while (inFlight.size) await Promise.all([...inFlight])
    }
  }
}
