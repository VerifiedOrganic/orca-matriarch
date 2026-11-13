import { execFile } from 'node:child_process'
import { assert, describe, test } from 'orca/testing'
import { CLAUDE_ALLOW, CLAUDE_DENY, createLockdown, lockdownCommand, shellWords } from './lockdown.ts'

const PROMPT = `You are the "correctness" reviewer on PR #51 "Don't --dangerously-skip-permissions"\nStep 1: git diff origin/main...HEAD`
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const rewritten = (agent: string, command: string): string => {
  const r = lockdownCommand(agent, command)
  assert.ok('command' in r, `expected a rewrite, got ${JSON.stringify(r)}`)
  return (r as { command: string }).command
}
const argv = (command: string): string[] => shellWords(command)!.map((w) => w.text)

/** What a real POSIX shell hands the program, with the program swapped for printf. */
function shellArgv(command: string, program: string): Promise<string[]> {
  const probe = command.replace(program, `printf '%s\\0'`)
  return new Promise((resolve, reject) =>
    execFile('/bin/sh', ['-c', probe], (error, stdout) => (error ? reject(error) : resolve(stdout.split('\0').slice(0, -1))))
  )
}

describe('Claude reviewers start in dontAsk mode with the allowlist', () => {
  test('full access: the bypass goes, the lockdown comes first, the prompt is untouched', async () => {
    const out = rewritten('claude', `claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high ${q(PROMPT)}`)
    const words = argv(out)
    assert.equal(words[0], 'claude')
    assert.ok(!words.slice(1, -1).includes('--dangerously-skip-permissions'))
    assert.deepEqual(words.slice(1, 10), ['--allowedTools', CLAUDE_ALLOW.join(' '), '--disallowedTools', CLAUDE_DENY.join(' '), '--permission-mode', 'dontAsk', '--setting-sources', 'user', '--strict-mcp-config'])
    assert.deepEqual(words.slice(10), ['--model', 'claude-opus-5-5', '--effort', 'high', PROMPT])
    // And a real shell agrees, quotes and all.
    assert.deepEqual(await shellArgv(out, 'claude'), words.slice(1))
  })

  test('other permission choices are replaced too', () => {
    for (const flags of ['--permission-mode auto', '--permission-mode=bypassPermissions', '--permission-mode acceptEdits --allow-dangerously-skip-permissions', '']) {
      const words = argv(rewritten('claude', `claude ${flags} 'p'`))
      assert.equal(words.filter((w) => w === '--permission-mode' || w.startsWith('--permission-mode=')).length, 1, flags)
      assert.equal(words[words.indexOf('--permission-mode') + 1], 'dontAsk')
      assert.ok(!words.includes('--allow-dangerously-skip-permissions'))
      assert.equal(words.at(-1), 'p')
    }
  })

  test('a one-value flag always follows the tool lists, so they cannot swallow the prompt', () => {
    const words = argv(rewritten('claude', `claude ${q(PROMPT)}`))
    assert.ok(words[words.indexOf('--disallowedTools') + 2].startsWith('--'))
    assert.equal(words.at(-1), PROMPT)
  })

  test('a full path, env assignments and $-quoted prompts', async () => {
    const out = rewritten('claude', `FOO=1 /Users/me/.local/bin/claude --dangerously-skip-permissions $'line one\\nit\\'s two'`)
    assert.ok(out.startsWith('FOO=1 /Users/me/.local/bin/claude --allowedTools '))
    assert.ok(!out.includes('--dangerously-skip-permissions'))
    assert.ok(out.endsWith(`$'line one\\nit\\'s two'`))
  })
})

describe('Codex reviewers start in the workspace sandbox with no network', () => {
  test('full access: the bypass goes, the sandbox flags come first, its other options stay', async () => {
    const out = rewritten('codex', `codex --dangerously-bypass-approvals-and-sandbox -m gpt-6-astra -c model_reasoning_effort=high ${q(PROMPT)}`)
    const words = argv(out)
    assert.ok(!words.includes('--dangerously-bypass-approvals-and-sandbox'))
    assert.deepEqual(words.slice(1, 5), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'])
    assert.ok(words.includes('sandbox_workspace_write.network_access=false'))
    assert.ok(words.includes('sandbox_workspace_write.writable_roots=[]'))
    assert.ok(words.includes('mcp_servers={}'))
    assert.deepEqual(words.slice(-5), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', PROMPT])
    assert.deepEqual(await shellArgv(out, 'codex'), words.slice(1))
  })

  test('ask and auto choices, and overrides that loosen the sandbox, are replaced', () => {
    const words = argv(
      rewritten('codex', `codex -a on-request -s read-only -c approvals_reviewer=user --yolo --approve-for-me --add-dir /x -c 'sandbox_mode="danger-full-access"' --sandbox=danger-full-access 'p'`)
    )
    assert.equal(words.filter((w) => w === '--sandbox').length, 1)
    assert.equal(words.filter((w) => w === '-s' || w === '-a' || w === '--add-dir' || w === '--yolo' || w === '--approve-for-me').length, 0)
    assert.ok(!words.some((w) => w.startsWith('approvals_reviewer') || w.startsWith('sandbox_mode') || w.startsWith('--sandbox=')))
    assert.equal(words.at(-1), 'p')
  })
})

describe('anything that cannot be locked down is refused', () => {
  test('an agent Matriarch cannot start read-only', () => {
    const r = lockdownCommand('gemini', `gemini --yolo -i 'p'`)
    assert.ok('deny' in r && /readOnly/.test(r.deny))
  })
  test('a command it cannot read, or without the agent in it', () => {
    assert.ok('deny' in lockdownCommand('claude', `claude 'unbalanced`))
    assert.ok('deny' in lockdownCommand('claude', `sh -c 'claude --dangerously-skip-permissions'`))
  })
})

describe('the launch hook', () => {
  const guard = { ids: new Set(['repo1::/wt/review-51']), paths: ['/wt/review-51'], pathOf: new Map([['repo1::/wt/review-51', '/wt/review-51']]) }
  test('rewrites launches in review worktrees only, and remembers it did', () => {
    let t = 1000
    const lock = createLockdown(() => t)
    assert.equal(lock.onLaunch({ agent: 'claude', workspaceId: 'repo1::/wt/login', command: 'claude --dangerously-skip-permissions' }, guard), null)
    const r = lock.onLaunch({ agent: 'claude', workspaceId: 'repo1::/wt/review-51', command: `claude --dangerously-skip-permissions 'p'` }, guard)
    assert.ok(r && 'command' in r && r.command.includes('dontAsk'))
    assert.equal(lock.confirmed('/wt/review-51', 'claude', 1000), 'claude-dontask')
    assert.equal(lock.confirmed('/wt/review-51', 'claude', 1001), null, 'a later launch is not confirmed by an earlier one')
    assert.equal(lock.confirmed('/wt/review-51', 'codex', 0), null)
    t = 2000
    assert.ok(lock.onLaunch({ agent: 'gemini', workspaceId: 'repo1::/wt/review-51', command: 'gemini' }, guard) && true)
    lock.exempt('/wt/review-51', 'gemini')
    assert.equal(lock.onLaunch({ agent: 'gemini', workspaceId: 'repo1::/wt/review-51', command: 'gemini' }, guard), null)
    assert.equal(lock.confirmed('/wt/review-51', 'gemini', 2000), 'off')
    lock.forget('/wt/review-51')
    assert.equal(lock.confirmed('/wt/review-51', 'claude', 0), null)
  })
})

test('a launch record outlives a reload of the plugin', async () => {
  const saved = new Map<string, unknown>()
  const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: unknown) => void saved.set(k, v) }
  const guard = { ids: new Set<string>(), paths: ['/wt/review-51'] }
  const before = createLockdown(() => 5_000, store)
  before.onLaunch({ agent: 'codex', workspaceId: 'repo1::/wt/review-51', command: `codex --dangerously-bypass-approvals-and-sandbox 'p'` }, guard)
  await new Promise((r) => setTimeout(r, 0))
  // A fresh copy, as after a reload, knows nothing in memory but finds the record.
  const after = createLockdown(() => 6_000, store)
  assert.equal(after.confirmed('/wt/review-51', 'codex', 5_000), null)
  assert.equal(await after.recall('/wt/review-51', 'codex', 5_000), 'codex-sandbox')
  assert.equal(await after.recall('/wt/review-51', 'codex', 5_001), null, 'an older launch does not confirm a newer one')
})
