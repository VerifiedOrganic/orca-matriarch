// Away alerts: formats, what is sent when, failures, and that the webhook URL stays a secret. No
// test reaches a real webhook: every post goes to a fake fetch.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { ALERTS_ERROR_KEY, ALERTS_KEY, ALERTS_URL_SECRET, checkUrl, createAlerter, detectFormat, payload, scrub, type Alert, type FetchLike } from './alerts.ts'
import { validateConfig } from './config.ts'
import { tick, type EngineDeps } from './engine.ts'
import type { Exec } from './exec.ts'
import { createExecutor } from './executor.ts'
import type { GitHub, PrSnapshot } from './github.ts'
import { createOrcaCli } from './orca-cli.ts'
import { config, pr, SHA } from './testing/fixtures.ts'
import { createWorker, deactivate } from './worker.ts'

const SLACK = 'https://hooks.slack.com/services/T000/B000/s3cretpath'
const needsYou: Alert = { kind: 'needs-you', title: 'acme/app #12 needs you', body: 'conflicts with main; 2/2 rounds used', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12' }

/** A fake fetch that records posts; `answer` decides each reply. */
function fakeFetch(answer: (url: string) => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 })) {
  const posts: { url: string; headers: Record<string, string>; body: string; redirect: string }[] = []
  let now = 0
  let most = 0
  const fetch: FetchLike = async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
    now++
    most = Math.max(most, now)
    try {
      return await answer(url)
    } finally {
      now--
    }
  }
  return { fetch, posts, most: () => most }
}

function setup(answer?: (url: string) => Promise<{ ok: boolean; status: number }>, opts: { secure?: boolean; timeoutMs?: number; failSet?: string } = {}) {
  const f = fakeFetch(answer)
  const secrets = new Map<string, string>()
  const storage = new Map<string, unknown>()
  const logs: string[] = []
  const alerter = createAlerter({
    fetch: f.fetch,
    secrets: {
      get: async (k) => secrets.get(k) ?? null,
      set: async (k, v) => {
        if (opts.failSet) throw new Error(opts.failSet)
        secrets.set(k, v)
      },
      delete: async (k) => void secrets.delete(k)
    },
    storage: { get: async (k) => storage.get(k) ?? null, set: async (k, v) => void storage.set(k, v) },
    secure: async () => opts.secure ?? true,
    log: (m) => logs.push(m),
    now: () => 1_000,
    timeoutMs: opts.timeoutMs
  })
  return { alerter, posts: f.posts, most: f.most, secrets, storage, logs }
}

const wait = (ms: number) => new Promise<{ ok: boolean; status: number }>((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), ms))

describe('formats', () => {
  test('are told from the URL, and anything else is JSON', () => {
    assert.equal(detectFormat(SLACK), 'slack')
    assert.equal(detectFormat('https://discord.com/api/webhooks/1/abc'), 'discord')
    assert.equal(detectFormat('https://discord.com/channels/1'), 'json', 'only a webhook path is Discord')
    assert.equal(detectFormat('https://ntfy.sh/my-topic'), 'ntfy')
    assert.equal(detectFormat('https://ntfy.example.com/topic'), 'json', 'a self-hosted ntfy is picked by hand')
    assert.equal(detectFormat('not a url'), 'json')
  })

  test('Slack escapes its markup and links the PR', () => {
    const body = JSON.parse(payload('slack', { ...needsYou, body: 'a < b & c' }).body) as { text: string }
    assert.equal(body.text, '*acme/app #12 needs you*\na &lt; b &amp; c\n<https://github.com/acme/app/pull/12|Open #12>')
  })

  test('Discord never pings: a title that says @everyone stays text', () => {
    const body = JSON.parse(payload('discord', { ...needsYou, title: '@everyone look' }).body) as { content: string; allowed_mentions: { parse: string[] } }
    assert.ok(body.content.startsWith('**@everyone look**'))
    assert.deepEqual(body.allowed_mentions, { parse: [] })
  })

  test('ntfy gets plain text with a title header, encoded when it is not ASCII', () => {
    const p = payload('ntfy', { ...needsYou, title: 'acme/app #12 needs you — now' })
    assert.equal(p.body, needsYou.body)
    assert.equal(p.headers.title, `=?UTF-8?B?${Buffer.from('acme/app #12 needs you — now').toString('base64')}?=`)
    assert.equal(p.headers.click, needsYou.url)
    assert.equal(p.headers.priority, 'high')
    assert.equal(payload('ntfy', { kind: 'merged', title: 'merged', body: 'x' }).headers.priority, undefined)
  })

  test('a line break in an ntfy title cannot start a header of its own', () => {
    const p = payload('ntfy', { ...needsYou, title: 'Fix\r\nX-Injected: 1', url: 'https://github.com/acme/app/pull/12\r\nX-Other: 2' })
    for (const v of Object.values(p.headers)) assert.ok(!/[\r\n]/.test(v), `no line break in ${JSON.stringify(v)}`)
    assert.equal(p.headers.title, `=?UTF-8?B?${Buffer.from('Fix\r\nX-Injected: 1').toString('base64')}?=`)
    assert.equal(p.headers.click, 'https://github.com/acme/app/pull/12X-Other: 2')
  })

  test('JSON carries the fields as named', () => {
    assert.deepEqual(JSON.parse(payload('json', needsYou).body), { kind: 'needs-you', title: needsYou.title, body: needsYou.body, repo: 'acme/app', number: 12, url: needsYou.url })
  })

  test('only http and https URLs are taken', () => {
    assert.equal(checkUrl(SLACK), null)
    assert.equal(checkUrl('http://ntfy.lan/topic'), null)
    assert.match(checkUrl('ftp://x/y') ?? '', /must start with https/)
    assert.match(checkUrl('hooks.slack.com/x') ?? '', /not a web address/)
  })
})

describe('the alerter', () => {
  test('sends nothing until a URL is set, then posts what is switched on', async () => {
    const h = setup()
    h.alerter.send(needsYou)
    await h.alerter.idle()
    assert.equal(h.posts.length, 0)
    assert.equal(await h.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: true, merged: false }, url: SLACK }), null)
    h.alerter.send(needsYou)
    h.alerter.send({ ...needsYou, kind: 'merged', title: 'acme/app #12 merged' })
    await h.alerter.idle()
    assert.deepEqual(h.posts.map((p) => p.url), [SLACK], 'merged is off')
    assert.match(h.posts[0].body, /needs you/)
  })

  test('keeps the URL in secrets only, and shows just its host', async () => {
    const h = setup()
    await h.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: false, merged: true }, url: `  ${SLACK}  ` })
    assert.equal(h.secrets.get(ALERTS_URL_SECRET), SLACK)
    assert.ok(!JSON.stringify([...h.storage]).includes('s3cretpath'), 'never in plugin storage')
    const view = await h.alerter.view()
    assert.equal(view.host, 'hooks.slack.com')
    assert.equal(view.detected, 'slack')
    assert.ok(!JSON.stringify(view).includes('s3cretpath'))
    // Saving without a URL keeps it; an empty one removes it.
    await h.alerter.save({ format: 'json', events: { 'needs-you': true, ready: false, merged: true } })
    assert.equal(h.secrets.get(ALERTS_URL_SECRET), SLACK)
    assert.equal((await h.alerter.view()).detected, 'json', 'an explicit format wins')
    await h.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: false, merged: true }, url: '' })
    assert.equal(h.secrets.has(ALERTS_URL_SECRET), false)
    assert.equal((await h.alerter.view()).host, null)
  })

  test('refuses a bad URL, and any URL where Orca cannot keep secrets encrypted', async () => {
    const h = setup()
    assert.match((await h.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: true, merged: false }, url: 'ftp://x/y' })) ?? '', /https/)
    const plain = setup(undefined, { secure: false })
    assert.match((await plain.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: true, merged: false }, url: SLACK })) ?? '', /cannot keep secrets encrypted/)
    assert.equal(plain.secrets.size, 0)
  })

  test('a failed post is logged and remembered without the URL; one that works clears it', async () => {
    const h = setup(async () => {
      throw Object.assign(new TypeError(`fetch failed for ${SLACK}`), { cause: { code: 'ENOTFOUND' } })
    })
    h.secrets.set(ALERTS_URL_SECRET, SLACK)
    h.alerter.send(needsYou)
    await h.alerter.idle()
    const err = h.storage.get(ALERTS_ERROR_KEY) as { message: string }
    assert.equal(err.message, 'could not reach hooks.slack.com: ENOTFOUND')
    assert.ok(!h.logs.join('\n').includes('s3cretpath'))
    assert.equal((await h.alerter.view()).lastError?.message, 'could not reach hooks.slack.com: ENOTFOUND')

    const status = setup(async () => ({ ok: false, status: 404 }))
    status.secrets.set(ALERTS_URL_SECRET, SLACK)
    status.alerter.send(needsYou)
    await status.alerter.idle()
    assert.equal((status.storage.get(ALERTS_ERROR_KEY) as { message: string }).message, 'hooks.slack.com answered HTTP 404')
    status.storage.set(ALERTS_KEY, null)
    const ok = setup()
    ok.secrets.set(ALERTS_URL_SECRET, SLACK)
    ok.storage.set(ALERTS_ERROR_KEY, { at: 1, message: 'old' })
    ok.alerter.send(needsYou)
    await ok.alerter.idle()
    assert.equal(ok.storage.get(ALERTS_ERROR_KEY), null)
  })

  test('gives up on a webhook that does not answer, even one whose client ignores the abort', async () => {
    const never = (_url: string) => new Promise<{ ok: boolean; status: number }>(() => {})
    const h = setup(never, { timeoutMs: 20 })
    h.secrets.set(ALERTS_URL_SECRET, SLACK)
    for (let i = 0; i < 6; i++) h.alerter.send({ ...needsYou, title: `alert ${i}` })
    await h.alerter.idle()
    assert.equal(h.posts.length, 6, 'each one tried once, the last two after a place freed')
    assert.equal(h.logs.filter((l) => l.includes('did not answer within 0.02 s')).length, 6)
    const slow = setup(() => wait(200), { timeoutMs: 20 })
    slow.secrets.set(ALERTS_URL_SECRET, SLACK)
    assert.deepEqual(await slow.alerter.test(), { ok: false, error: 'hooks.slack.com did not answer within 0.02 s' })
  })

  test('a burst against a healthy webhook: four at a time, twenty waiting, the rest as one post', async () => {
    const h = setup(() => wait(5))
    h.secrets.set(ALERTS_URL_SECRET, SLACK)
    for (let i = 0; i < 30; i++) h.alerter.send({ ...needsYou, kind: 'ready', title: `acme/app #${i} is ready to merge` })
    await h.alerter.idle()
    assert.equal(h.most(), 4, 'never more than four at once')
    assert.equal(h.posts.length, 25, '24 one by one, then one for the rest')
    const last = JSON.parse(h.posts.at(-1)!.body) as { text: string }
    assert.match(last.text, /^\*Matriarch: and 6 more\*/)
    for (let i = 24; i < 30; i++) assert.ok(last.text.includes(`#${i} is ready`), `#${i} is named in it`)
    assert.equal(h.logs.length, 1, 'the folding is said once')
    // Nothing set, or switched off: nothing takes a place or says it was dropped.
    const none = setup()
    for (let i = 0; i < 6; i++) none.alerter.send(needsYou)
    await none.alerter.idle()
    assert.deepEqual([none.posts.length, none.logs], [0, []])
  })

  test('credentials in the URL go as a Basic header, never into the address, a log or the panel', async () => {
    const h = setup(async () => ({ ok: false, status: 401 }))
    const url = 'https://alice:p%40ss-w0rd@ntfy.example.com/alerts'
    assert.equal(await h.alerter.save({ format: 'ntfy', events: { 'needs-you': true, ready: true, merged: false }, url }), null)
    h.alerter.send(needsYou)
    await h.alerter.idle()
    assert.equal(h.posts[0].url, 'https://ntfy.example.com/alerts')
    assert.equal(h.posts[0].headers.authorization, `Basic ${Buffer.from('alice:p@ss-w0rd').toString('base64')}`)
    assert.equal(h.posts[0].redirect, 'error', 'a redirect cannot carry the post elsewhere')
    const view = await h.alerter.view()
    assert.equal(view.host, 'ntfy.example.com')
    const shown = JSON.stringify([view, h.logs, [...h.storage]])
    for (const secret of ['p%40ss-w0rd', 'p@ss-w0rd', 'alice:']) assert.ok(!shown.includes(secret), `${secret} is not shown`)
  })

  test('the URL is scrubbed from every error, whatever carries it', async () => {
    const h = setup(async () => {
      throw new TypeError(`Failed to parse URL from ${SLACK}`)
    })
    h.secrets.set(ALERTS_URL_SECRET, SLACK)
    h.alerter.send(needsYou)
    await h.alerter.idle()
    assert.equal((h.storage.get(ALERTS_ERROR_KEY) as { message: string }).message, 'could not reach hooks.slack.com: Failed to parse URL from hooks.slack.com')
    assert.ok(!h.logs.join('\n').includes('s3cretpath'))
    assert.equal(scrub('POST /services/T000/B000/s3cretpath failed', SLACK), 'POST hooks.slack.com failed', 'its path alone too')
    const failing = setup(undefined, { failSet: `keychain refused ${SLACK}` })
    const why = await failing.alerter.save({ format: 'auto', events: { 'needs-you': true, ready: true, merged: false }, url: SLACK })
    assert.equal(why, 'Orca could not store the webhook URL: keychain refused hooks.slack.com')
  })

  test('a test goes to a URL being typed without saving it, or to the saved one', async () => {
    const h = setup()
    assert.deepEqual(await h.alerter.test(), { ok: false, error: 'Set a webhook URL first.' })
    assert.deepEqual(await h.alerter.test('https://ntfy.sh/mine', 'auto'), { ok: true, error: null })
    assert.equal(h.posts[0].url, 'https://ntfy.sh/mine')
    assert.equal(h.posts[0].headers.title, 'Matriarch: test alert')
    assert.equal(h.secrets.size, 0, 'a test saves nothing')
  })
})

describe('where alerts come from', () => {
  test('the executor tells the person, and says which kind of alert it is', async () => {
    const told: { title: string; kind?: string }[] = []
    const noExec: Exec = async () => ({ code: 0, stdout: '', stderr: '' })
    const ex = createExecutor({ exec: noExec, orca: createOrcaCli(noExec), notify: async (title, _body, about) => void told.push({ title, kind: about?.kind }) })
    const ctx = { repo: { owner: 'acme', name: 'app' }, pr: pr({ number: 12 }), config: config(), root: '/r' }
    await ex.execute({ kind: 'notify', key: `ready:${SHA}`, title: 'acme/app #12 is ready to merge', body: 'x' }, ctx)
    await ex.execute({ kind: 'notify', key: `blocked:${SHA}`, title: 'acme/app #12 is blocked', body: 'x' }, ctx)
    await ex.execute({ kind: 'escalate', to: 'human', key: 'k:human', reason: 'stuck', address: null }, ctx)
    assert.deepEqual(told.map((t) => t.kind), ['ready', 'needs-you', 'needs-you'])
  })

  test('the engine alerts once when it first sees a PR merged, only while it acts', async () => {
    const run = async (autopilot: boolean) => {
      const store = new Map<string, unknown>()
      const alerts: Alert[] = []
      let state: PrSnapshot = pr({ number: 12 })
      const github: GitHub = {
        listOpen: async () => ({ viewer: 'me', rate: null, prs: state.state === 'OPEN' ? [{ number: 12, headRef: state.headRef, headSha: state.headSha, author: state.author, updatedAt: state.updatedAt, rollup: state.ci }] : [] }),
        detail: async () => ({ pr: state, rate: null })
      }
      const deps: EngineDeps = {
        now: () => 1_800_000_000_000,
        log: () => {},
        workspaces: async () => [],
        repoOf: async () => null,
        readConfig: async () => validateConfig({ review: { enabled: false } }),
        github,
        workers: async () => [],
        activity: () => null,
        supervisor: async () => null,
        store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
        executor: { execute: async () => ({ ok: true }) },
        alert: (a) => void alerts.push(a)
      }
      // Followed while open, from a workspace on its branch.
      deps.workspaces = async () => [{ id: 'ws', kind: 'worktree', name: 'login', path: '/r/wt/login', branch: state.headRef, hostId: null }]
      deps.repoOf = async () => ({ ref: { owner: 'acme', name: 'app' }, key: 'acme/app', root: '/r' })
      await tick(deps, { autopilot })
      state = { ...state, state: 'MERGED' }
      await tick(deps, { autopilot })
      await tick(deps, { autopilot })
      return { alerts, url: state.url }
    }
    const acting = await run(true)
    assert.deepEqual(acting.alerts.map((a) => [a.kind, a.title, a.url]), [['merged', 'acme/app #12 merged', acting.url]])
    assert.deepEqual((await run(false)).alerts, [], 'dry run sends nothing, to the webhook either')
  })
})

describe('the alert settings requests', () => {
  test('save the URL as a secret, answer only its host, and send a test to the fake webhook', async () => {
    const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not in tests' })
    const noGitHub: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }
    const f = fakeFetch()
    const host = mockHost({
      capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own', 'secrets:own'],
      results: { 'workspace.list': { workspaces: [], truncated: false }, 'statusBar.update': { ok: true }, 'secrets.protection': { status: 'os-keyring' } },
      settings: { autopilot: false, pollSeconds: 45 }
    })
    const worker = await mountWorker({ default: createWorker({ exec: noExec, github: noGitHub, autoStart: false, fetch: f.fetch }), deactivate }, {
      host,
      events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
      commands: ['showBoard', 'refresh', 'toggleAutopilot']
    })
    const saved = (await worker.request('alerts.save', { format: 'auto', events: { 'needs-you': true, ready: true, merged: false }, url: SLACK })) as { saved: boolean; alerts: { host: string } }
    assert.equal(saved.saved, true)
    assert.equal(saved.alerts.host, 'hooks.slack.com')
    assert.equal(host.data().secrets[ALERTS_URL_SECRET], SLACK)
    assert.ok(!JSON.stringify(host.data().storage).includes('s3cretpath'))
    assert.ok(!JSON.stringify(await worker.request('alerts.get')).includes('s3cretpath'))
    assert.ok(!worker.logs.join('\n').includes('s3cretpath'), 'the log names the host only')
    assert.deepEqual(await worker.request('alerts.test', {}), { ok: true, error: null })
    assert.equal(f.posts.length, 1)
    assert.equal(f.posts[0].url, SLACK)
    await worker.deactivate()
  })
})
