// Setting a project up from the panel: listing Orca's projects, turning Matriarch on and off,
// and the settings form's load and save. The settings file is real, in a temporary folder.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { agentOptions, parseModelList } from './agents.ts'
import { modelsFromRow, profileFromRow } from './orca-profile.ts'
import { CONFIG_OFF_PATH, CONFIG_PATH, modelFlags, type MatriarchConfig } from './config.ts'
import type { Exec } from './exec.ts'
import type { GitHub } from './github.ts'
import { createWorker, deactivate, PLUGIN_VERSION, TESTED_ORCA } from './worker.ts'

const noGitHub: GitHub = { listOpen: async () => ({ viewer: 'me', prs: [], rate: null }), detail: async () => ({ pr: null, rate: null }) }

async function setup(opts: { context?: unknown; secondOnGitHub?: boolean; active?: 'root' | 'notes' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'matriarch-project-'))
  const notes = await mkdtemp(join(tmpdir(), 'matriarch-notes-'))
  // A stand-in for Orca's data folder: never the person's real profile.
  const orcaData = await mkdtemp(join(tmpdir(), 'matriarch-orca-'))
  if (opts.active) await writeFile(join(orcaData, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'p1' }))
  // git: `root` is a GitHub checkout with commits; `notes` has no GitHub origin.
  const exec: Exec = async (file, args) => {
    if (file === 'sqlite3' && opts.active && args.at(-1)?.includes('workspaceSession')) {
      const path = opts.active === 'root' ? root : notes
      return { code: 0, stdout: JSON.stringify([{ disabled: '[]', overrides: '{}', active: `repo1::${path}` }]), stderr: '' }
    }
    if (file !== 'git') return { code: 1, stdout: '', stderr: 'not in tests' }
    const cwd = args[1]
    // A worktree of the project (`<root>-login`) shares the main checkout's .git, as in real git.
    if (args.includes('--git-common-dir')) return { code: 0, stdout: `${cwd.startsWith(root) ? root : cwd}/.git\n`, stderr: '' }
    if (args.includes('remote.origin.url')) {
      if (cwd.startsWith(root)) return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
      return opts.secondOnGitHub ? { code: 0, stdout: 'git@github.com:acme/notes.git\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    }
    if (args.includes('HEAD')) return { code: 0, stdout: 'abc\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const orcaCli = {
    run: async (args: readonly string[]) =>
      args[0] === 'repo' && args[1] === 'list' ? { repos: [{ path: root, displayName: 'app' }, { path: notes, displayName: 'notes' }, { path: '/nowhere/gone' }] } : {}
  }
  const host = mockHost({
    capabilities: ['workspace:read', 'workspace:write', 'agent:read', 'notifications:show', 'storage:own', 'settings:own'],
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'ws-main', kind: 'worktree', name: 'main', path: root, branch: 'refs/heads/main', hostId: 'local' },
          { id: 'ws-login', kind: 'worktree', name: 'login', path: `${root}-login`, branch: 'refs/heads/feature/login', hostId: 'local' },
          { id: 'ws-notes', kind: 'worktree', name: 'main', path: notes, branch: 'refs/heads/main', hostId: 'local' }
        ],
        truncated: false
      },
      'workspace.readContext': opts.context ?? null,
      'agents.list': { agents: [] },
      'statusBar.update': { ok: true }
    },
    settings: { autopilot: false, pollSeconds: 45 }
  })
  const worker = await mountWorker({ default: createWorker({ exec, github: noGitHub, orcaCli, autoStart: false, orcaDataDir: orcaData }), deactivate }, {
    host,
    events: ['agent.status.changed', 'workspace.created', 'workspace.removed'],
    commands: ['showBoard', 'refresh', 'toggleAutopilot']
  })
  const cleanup = async () => {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
    await rm(notes, { recursive: true, force: true })
    await rm(orcaData, { recursive: true, force: true })
  }
  return { root, worker, cleanup }
}

type Project = { root: string; repo: string | null; enabled: boolean; problem: string | null }
type Saved = { saved: boolean; errors: string[]; warnings: string[] }

test('a project is turned on, set up, turned off and back on from the panel', async () => {
  const { root, worker, cleanup } = await setup()
  try {
    const listed = (await worker.request('projects.list')) as { projects: Project[] }
    assert.deepEqual(listed.projects.map((p) => [p.repo, p.enabled]), [['acme/app', false], [null, false]], 'a missing folder is left out')
    assert.match(listed.projects[1].problem ?? '', /not on GitHub/)

    const on = (await worker.request('project.enable', { root })) as { ok: boolean; repo: string }
    assert.deepEqual([on.ok, on.repo], [true, 'acme/app'])
    const written = JSON.parse(await readFile(join(root, CONFIG_PATH), 'utf8')) as MatriarchConfig
    assert.equal(written.supervisor.agent, 'claude')

    const got = (await worker.request('config.get', { repo: 'acme/app' })) as { config: MatriarchConfig; errors: string[]; agents: { id: string }[] }
    assert.deepEqual(got.errors, [])
    assert.ok(got.agents.some((a) => a.id === 'codex'))

    // The form's save: checked, then written.
    const changed = { ...got.config, supervisor: { agent: 'codex', model: 'gpt-6-astra' } }
    const ok = (await worker.request('config.save', { repo: 'acme/app', config: changed })) as Saved
    assert.equal(ok.saved, true)
    assert.equal((JSON.parse(await readFile(join(root, CONFIG_PATH), 'utf8')) as MatriarchConfig).supervisor.agent, 'codex')

    // A bad value is refused and nothing is written.
    const bad = (await worker.request('config.save', { repo: 'acme/app', config: { ...changed, reviewers: [{ name: 'Bad Name', agent: 'claude', blocking: true }] } })) as Saved
    assert.equal(bad.saved, false)
    assert.ok(bad.errors.some((e) => e.startsWith('reviewers[0].name')))
    assert.equal((JSON.parse(await readFile(join(root, CONFIG_PATH), 'utf8')) as MatriarchConfig).reviewers.length, 2)

    // Off keeps the settings aside; on brings them back as they were.
    const off = (await worker.request('project.disable', { repo: 'acme/app' })) as { ok: boolean }
    assert.equal(off.ok, true)
    assert.ok(await readFile(join(root, CONFIG_OFF_PATH), 'utf8'))
    assert.equal(((await worker.request('projects.list')) as { projects: Project[] }).projects[0].enabled, false)
    await worker.request('project.enable', { root })
    assert.equal((JSON.parse(await readFile(join(root, CONFIG_PATH), 'utf8')) as MatriarchConfig).supervisor.agent, 'codex')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await cleanup()
  }
})

type Focused = { repo: string | null; enabled: boolean; candidates: string[] }

test('the panel follows the focused workspace to its project, and says when it cannot tell', async () => {
  // A worker's worktree has its own name and branch: it names its project.
  const one = await setup({ context: { branch: 'refs/heads/feature/login', displayName: 'login', terminals: [] } })
  try {
    const f = (await one.worker.request('project.focused')) as Focused
    assert.deepEqual([f.repo, f.enabled], ['acme/app', false])
  } finally {
    await one.cleanup()
  }
  // Two projects' own checkouts, both "main" on main with no terminals: Orca does not say which.
  const two = await setup({ context: { branch: 'main', displayName: 'main', terminals: [] }, secondOnGitHub: true })
  try {
    const f = (await two.worker.request('project.focused')) as Focused
    assert.equal(f.repo, null)
    assert.deepEqual(f.candidates, ['acme/app', 'acme/notes'])
  } finally {
    await two.cleanup()
  }
  // Orca's own record of the focused workspace settles the same case.
  const settled = await setup({ context: { branch: 'main', displayName: 'main', terminals: [] }, secondOnGitHub: true, active: 'notes' })
  try {
    assert.equal(((await settled.worker.request('project.focused')) as Focused).repo, 'acme/notes')
  } finally {
    await settled.cleanup()
  }
})

test('the profile and model catalog rows parse, and junk is ignored', () => {
  const p = profileFromRow({ disabled: '["codex"]', overrides: '{"opencode2":"opencode","x":""}', active: 'r::/p' })
  assert.deepEqual(p, { disabledAgents: ['codex'], commandOverrides: { opencode2: 'opencode' }, activeWorktreeId: 'r::/p' })
  assert.deepEqual(profileFromRow({}), { disabledAgents: [], commandOverrides: {}, activeWorktreeId: null })
  const m = modelsFromRow({ agent: 'claude', discovered: { models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: [{ value: 'none' }, { value: 'high' }], isDefault: true }, { label: 'no id' }] }, configured: { modelId: 'claude-opus-5-5', effort: 'high' } })
  assert.deepEqual(m?.models.models, [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['high'], isDefault: true }])
  assert.deepEqual(m?.models.configured, { model: 'claude-opus-5-5', effort: 'high' })
  assert.equal(modelsFromRow({ nope: 1 }), null)
})

test('the agent choices follow the Orca profile, and the models Orca discovered', async () => {
  const found = async (command: string) => ['claude', 'agy', 'codex', 'opencode'].includes(command)
  const profile = { disabledAgents: ['codex'], commandOverrides: { opencode2: 'opencode --pure' }, activeWorktreeId: null }
  const models = {
    claude: {
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'high', 'xhigh'], isDefault: true },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: [], isDefault: false }
      ],
      configured: { model: 'claude-opus-5-5', effort: 'xhigh' }
    }
  }
  const options = await agentOptions(['claude', 'gemini'], { found, profile, models })
  const by = Object.fromEntries(options.map((o) => [o.id, o]))
  assert.ok(!by.codex, 'turned off in Orca: not offered')
  assert.ok(by.opencode2?.installed, 'its command override is what counts')
  assert.ok(by.antigravity?.installed && !by.cursor, 'only installed agents')
  assert.ok(by.gemini && !by.gemini.installed, 'an agent the settings use is kept, marked unavailable')
  assert.deepEqual(by.claude.models.map((m) => m.label), ['Claude Opus 5.5', 'Claude Haiku 5.5'])
  // Without Orca's list there is no stale one of Matriarch's own: the model is typed, or the default.
  assert.deepEqual(by.antigravity.models, [])
  assert.deepEqual(by.antigravity.efforts, ['low', 'medium', 'high'])
  // What OpenCode lists now wins over Orca's older copy, which still lends its names.
  const now = await agentOptions([], {
    found,
    models: { opencode: { models: [{ id: 'fireworks-ai/glm-5p3', label: 'fireworks-ai/GLM 5.3', efforts: ['low'], isDefault: false }, { id: 'gone/old', label: 'Old', efforts: [], isDefault: false }], configured: null } },
    live: { opencode: parseModelList('fireworks-ai/glm-5p3\ndeepinfra/ByteDance/Seed-2.0-code\nnot a model line\n') }
  })
  const oc = now.find((o) => o.id === 'opencode')!
  assert.deepEqual(oc.models.map((m) => [m.id, m.label, m.efforts]), [['fireworks-ai/glm-5p3', 'fireworks-ai/GLM 5.3', ['low']], ['deepinfra/ByteDance/Seed-2.0-code', 'ByteDance/Seed-2.0-code', []]])
  // OpenCode's API gives names and thinking levels (its "variants").
  const api = parseModelList(JSON.stringify({ location: {}, data: [
    { providerID: 'deepinfra', modelID: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', enabled: true, variants: [{ id: 'none' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] },
    { providerID: 'deepinfra', modelID: 'off', name: 'Off', enabled: false, variants: [] }
  ] }))
  assert.deepEqual(api, [{ id: 'deepinfra/deepseek-ai/DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro', efforts: ['none', 'low', 'high', 'max'] }])
  assert.deepEqual([by.claude.defaultModel, by.claude.defaultEffort], ['claude-opus-5-5', 'xhigh'])
})

test("Oh My Pi's own list gives each model's selector, name and thinking levels", () => {
  const omp = parseModelList(JSON.stringify({ models: [
    { provider: 'deepinfra', kind: 'chat', id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', selector: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash 1017', thinking: ['low', 'high', 'max'] },
    { provider: 'deepinfra', kind: 'chat', id: 'deepseek-ai/DeepSeek-V3', selector: 'deepinfra/deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', thinking: null },
    { provider: 'x', kind: 'embedding', id: 'e', selector: 'x/e', name: 'E', thinking: null }
  ] }))
  assert.deepEqual(omp, [
    { id: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', label: 'DeepSeek V4.1 Flash 1017', efforts: ['low', 'high', 'max'] },
    { id: 'deepinfra/deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3', efforts: [] }
  ])
  // Orca gets the model and the thinking level for an Oh My Pi worker.
  assert.deepEqual(modelFlags({ agent: 'omp', model: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', effort: 'max' }), ['--model', 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017', '--effort', 'max'])
})

test('the thinking level goes to Orca as --effort, for OpenCode too (its API rejects model#variant)', () => {
  assert.deepEqual(modelFlags({ agent: 'opencode', model: 'deepinfra/deepseek-ai/DeepSeek-V4-Pro', effort: 'high' }), ['--model', 'deepinfra/deepseek-ai/DeepSeek-V4-Pro', '--effort', 'high'])
  assert.deepEqual(modelFlags({ agent: 'opencode', model: 'x/y#low' }), ['--model', 'x/y', '--effort', 'low'])
  assert.deepEqual(modelFlags({ agent: 'opencode', model: 'x/y#low', effort: 'max' }), ['--model', 'x/y', '--effort', 'max'])
  assert.deepEqual(modelFlags({ agent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }), ['--model', 'claude-opus-5-5', '--effort', 'xhigh'])
  assert.deepEqual(modelFlags({ agent: 'codex' }), [])
})

test("an agent Orca discovered models for is offered even when Matriarch's list lacks it", async () => {
  const options = await agentOptions([], {
    found: async () => false,
    models: { 'new-agent': { models: [{ id: 'm1', label: 'M1', efforts: ['high'], isDefault: true }], configured: null } }
  })
  const fresh = options.find((o) => o.id === 'new-agent')
  assert.ok(fresh?.installed && fresh.takesModel)
  assert.deepEqual(fresh.models.map((m) => m.id), ['m1'])
  const off = await agentOptions([], { found: async () => false, profile: { disabledAgents: ['new-agent'], commandOverrides: {}, activeWorktreeId: null }, models: { 'new-agent': { models: [{ id: 'm1', label: 'M1', efforts: [], isDefault: false }], configured: null } } })
  assert.ok(!off.some((o) => o.id === 'new-agent'), 'turned off in Orca: not offered')
})

test('the versions Matriarch states match its manifest and package.json', async () => {
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as { version: string; engines: { orca: string } }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { config: { orcaVersion: string } }
  assert.equal(PLUGIN_VERSION, manifest.version)
  assert.equal(TESTED_ORCA, pkg.config.orcaVersion)
  assert.equal(manifest.engines.orca, `>=${TESTED_ORCA}`)
})
