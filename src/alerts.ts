// Away alerts: what reaches you in Orca's notifications can also go to a webhook (Slack, Discord,
// ntfy, or any URL that takes JSON), for when you are away from the desk. Off until you set a URL.
// "Needs you" and "ready to merge" go in addition to Orca's notification, never instead. "Merged"
// goes to the webhook only: Orca shows no notification for a merge. Like everything Matriarch
// sends, the engine's alerts go only while it acts (autopilot on). A reviewer or the advisor stuck
// on a prompt is told whenever it happens, as Orca's own notification of it is: a review the
// person started by hand runs in dry run, and an advisor at work keeps working when autopilot is
// turned off mid-question.
//
// The URL is a secret: anyone who has a Slack or Discord webhook URL can post to that channel. It
// lives in Orca's encrypted secrets (the OS key store), never in plugin storage or a project's
// config file, and only its host is ever shown or logged. Credentials in it (`user:pass@`, as a
// self-hosted ntfy takes) are sent as a Basic Authorization header, never shown. Each alert is
// posted once, with a time limit, never retried and never redirected to another address: a webhook
// that is down costs one failed post per alert, and the last failure shows in the alert settings.
// A burst (autopilot turned on with many PRs ready) is queued: four posts at a time, twenty more
// waiting, and anything past that folded into one "and N more" post.
import { clip } from './values.ts'
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
/** Alerts waiting for one of those; past this they are folded into one "and N more" post. */
const MAX_QUEUED = 20
const MAX_TEXT = 1500

export const DEFAULT_ALERTS: AlertSettings = { format: 'auto', events: { 'needs-you': true, ready: true, merged: false } }


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

/** Alert text cut to what a webhook takes. */
const cut = (s: string, n = MAX_TEXT): string => clip(s, n)
/** Slack's mrkdwn: only these three are special. */
const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** A header value as ntfy reads one: printable ASCII as is, anything else (a line break too) RFC 2047-encoded. */
const headerValue = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
/** A link for a header: only printable ASCII, so nothing can start a header of its own. */
const headerLink = (s: string): string => s.replace(/[^\x20-\x7e]/g, '')
const linkText = (a: Alert): string => (a.number !== undefined ? `Open #${a.number}` : 'Open')

/** The request for one alert in one format. */
export function payload(format: AlertFormat, a: Alert): { headers: Record<string, string>; body: string } {
  const title = cut(a.title, 200)
  const body = cut(a.body)
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
        body: JSON.stringify({ content: cut([`**${title}**`, body, a.url ?? ''].filter(Boolean).join('\n'), 2000), allowed_mentions: { parse: [] } })
      }
    case 'ntfy':
      return {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          title: headerValue(title),
          ...(a.url ? { click: headerLink(a.url) } : {}),
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
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }): Promise<{ ok: boolean; status: number }>
}

/** A message with the URL, and anything secret in it (its path, its password), replaced by the host. */
export function scrub(message: string, url: string): string {
  const host = hostOf(url)
  const secret = [url]
  try {
    const u = new URL(url)
    const bare = new URL(url)
    bare.username = ''
    bare.password = ''
    secret.push(u.href, bare.href, u.pathname + u.search, `${u.username}:${u.password}`)
    if (u.password) secret.push(u.password, decodeURIComponent(u.password))
  } catch {
    // not a URL: only the text as given
  }
  let out = message
  for (const s of secret.filter((x) => x.length > 2).sort((a, b) => b.length - a.length)) out = out.split(s).join(host)
  return out
}

/** Where to post, and the credentials the URL carried as a header: Node's fetch refuses them in a URL. */
function target(url: string): { url: string; auth: string | null } {
  const u = new URL(url)
  if (!u.username && !u.password) return { url, auth: null }
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`, 'utf8').toString('base64')}`
  u.username = ''
  u.password = ''
  return { url: u.href, auth }
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

interface Job {
  url: string
  settings: AlertSettings
  alert: Alert
}

export function createAlerter(deps: AlerterDeps): Alerter {
  const timeoutMs = deps.timeoutMs ?? ALERT_TIMEOUT_MS
  /** Everything under way (checks, posts), for idle(). */
  const active = new Set<Promise<unknown>>()
  const track = (p: Promise<unknown>): void => {
    active.add(p)
    void p.then(() => active.delete(p), () => active.delete(p))
  }
  let running = 0
  const queue: Job[] = []
  let folded: Job[] = []

  /** Posts once; the answer never carries the URL, which a secret path can be part of. */
  async function post(url: string, settings: Pick<AlertSettings, 'format'>, alert: Alert): Promise<{ ok: boolean; error: string | null }> {
    const format = settings.format === 'auto' ? detectFormat(url) : settings.format
    const { headers, body } = payload(format, alert)
    let to: { url: string; auth: string | null }
    try {
      to = target(url)
    } catch {
      return { ok: false, error: 'the webhook URL is not a web address' }
    }
    if (to.auth) headers.authorization = to.auth
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
      // A redirect is refused: a 307 or 308 would send the same POST, credentials and all, elsewhere.
      const res = await Promise.race([deps.fetch(to.url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'error' }), late])
      return res.ok ? { ok: true, error: null } : { ok: false, error: `${hostOf(url)} answered HTTP ${res.status}` }
    } catch (error) {
      if (ctl.signal.aborted) return { ok: false, error: `${hostOf(url)} did not answer within ${timeoutMs / 1000} s` }
      const e = error as Error & { cause?: { code?: string; message?: string } }
      const why = e.cause?.code ?? e.cause?.message ?? e.message
      return { ok: false, error: `could not reach ${hostOf(url)}: ${scrub(scrub(String(why), url), to.url)}` }
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

  function start(job: Job): void {
    running++
    track(
      (async () => {
        const r = await post(job.url, job.settings, job.alert)
        if (!r.ok) deps.log(`away alert not delivered: ${r.error}`)
        await noteResult(r)
      })()
        .catch((error: Error) => deps.log(`away alert: ${scrub(error.message, job.url)}`))
        .finally(() => {
          running--
          next()
        })
    )
  }

  /** The next waiting alert; once none wait, the folded ones as one post. */
  function next(): void {
    const job = queue.shift()
    if (job) return start(job)
    if (!folded.length || running >= MAX_IN_FLIGHT) return
    const extra = folded
    folded = []
    const last = extra[extra.length - 1]
    start({
      url: last.url,
      settings: last.settings,
      alert: {
        kind: extra.some((j) => j.alert.kind === 'needs-you') ? 'needs-you' : last.alert.kind,
        title: `Matriarch: and ${extra.length} more`,
        body: extra.map((j) => `- ${j.alert.title}`).join('\n')
      }
    })
  }

  function enqueue(job: Job): void {
    if (running < MAX_IN_FLIGHT) return start(job)
    if (queue.length < MAX_QUEUED) {
      queue.push(job)
      return
    }
    if (!folded.length) deps.log(`away alerts: over ${MAX_IN_FLIGHT + MAX_QUEUED} at once; the rest go as one "and N more" post`)
    folded.push(job)
  }

  return {
    send(alert) {
      // Whether it goes at all is settled before it takes a place: one switched off, or with no
      // URL set, never holds up another.
      track(
        (async () => {
          const settings = loadAlertSettings(await deps.storage.get(ALERTS_KEY))
          if (alert.kind !== 'test' && !settings.events[alert.kind]) return
          const url = await deps.secrets.get(ALERTS_URL_SECRET)
          if (!url) return
          enqueue({ url, settings, alert })
        })().catch((error: Error) => deps.log(`away alert: ${error.message}`))
      )
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
            return `Orca could not store the webhook URL: ${scrub((error as Error).message, url)}`
          }
          // A new URL starts with a clean record.
          await deps.storage.set(ALERTS_ERROR_KEY, null)
        }
      }
      await deps.storage.set(ALERTS_KEY, settings as unknown as JsonValue)
      return null
    },

    async test(url, format) {
      const hook = url?.trim() || (await deps.secrets.get(ALERTS_URL_SECRET))
      if (!hook) return { ok: false, error: 'Set a webhook URL first.' }
      const bad = checkUrl(hook)
      if (bad) return { ok: false, error: bad }
      const settings = loadAlertSettings(await deps.storage.get(ALERTS_KEY))
      const r = await post(hook, { format: format ?? settings.format }, {
        kind: 'test',
        title: 'Matriarch: test alert',
        body: 'Away alerts work. Matriarch posts here when something needs you, and for the other events you switched on.'
      })
      // Only the saved URL's record changes; a URL still being typed has none yet.
      if (!url?.trim()) await noteResult(r)
      return r
    },

    async idle() {
      while (active.size) await Promise.allSettled([...active])
    }
  }
}
