// Reviewers start locked down, in their own agent's restricted mode. Orca launches an agent with
// the permission choice the person picked (often full access: Claude with
// --dangerously-skip-permissions, Codex with --dangerously-bypass-approvals-and-sandbox). For a
// launch inside a review worktree the agent.launch.before hook swaps those flags for a
// read-only setup the agent itself enforces, so the lockdown holds even where Orca's tool hook
// cannot stop a call (Codex) and even if this plugin stops answering:
//
// - Claude Code: --permission-mode dontAsk with an allowlist (read the worktree, read-only git,
//   write only the verdict folder) and a denylist; settings from the PR's own .claude/ folder and
//   all MCP servers are left out. Anything else is refused without a prompt.
// - Codex: its workspace-write sandbox with no network, no extra writable folders (not even /tmp)
//   and no approvals, so a command that would write outside the worktree just fails.
//
// The crew checks each launch was rewritten (confirmed()) and stops a reviewer that was not.
// Pure and synchronous: Orca gives a hook 2 s, and nothing here may await.
import type { Guard } from './guard.ts'

/** Agents Matriarch can start read-only. Any other agent is refused as a reviewer unless the
 *  person sets `"readOnly": false` on it. */
export const LOCKABLE_AGENTS: readonly string[] = ['claude', 'codex']

export type LockMode = 'claude-dontask' | 'codex-sandbox' | 'off'

export const LOCK_LABEL: Record<LockMode, string> = {
  'claude-dontask': 'read-only: Claude dontAsk mode with a read-only allowlist',
  'codex-sandbox': 'read-only: Codex workspace sandbox, no network',
  off: 'not locked down: runs with your usual permissions for this agent'
}

/** What a Claude reviewer may do without asking; everything else is refused. Path rules are
 *  relative to the worktree, so reading and searching stay inside it; Edit rules cover every
 *  file-writing tool. In dontAsk mode a tool with no allow rule is not offered at all. */
export const CLAUDE_ALLOW: readonly string[] = [
  'Read(./**)', 'Grep(./**)', 'Glob(./**)', 'Edit(./.matriarch/review/**)',
  'Bash(git diff *)', 'Bash(git diff)', 'Bash(git log *)', 'Bash(git log)', 'Bash(git show *)', 'Bash(git show)',
  'Bash(git status *)', 'Bash(git status)', 'Bash(git grep *)', 'Bash(git ls-files *)', 'Bash(git ls-files)',
  'Bash(git blame *)', 'Bash(git rev-parse *)', 'Bash(git merge-base *)', 'Bash(git cat-file *)', 'Bash(git ls-tree *)',
  'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(ls *)', 'Bash(ls)', 'Bash(grep *)', 'Bash(rg *)',
  'Bash(pwd)', 'Bash(mkdir -p .matriarch/review/*)',
  'Bash(shasum *)', 'Bash(sha256sum *)', 'Bash(sha512sum *)', 'Bash(md5sum *)', 'Bash(md5 *)', 'Bash(b2sum *)', 'Bash(cksum *)'
]

/**
 * Refused even when the person's own Claude settings allow them: changes, GitHub and GitLab
 * writes, the web, and any command that reaches outside the worktree (an absolute path, the home
 * folder, or climbing out with ..), so a reviewer cannot read your files into a verdict that gets
 * posted. glab's write commands act on the current branch's merge request when given no number,
 * so each is refused bare too.
 */
export const CLAUDE_DENY: readonly string[] = [
  'Bash(* /*)', 'Bash(* "/*)', "Bash(* '/*)", 'Bash(*=/*)', 'Bash(*</*)', 'Bash(*< /*)',
  'Bash(* ~*)', 'Bash(*=~*)', 'Bash(*<~*)', 'Bash(*< ~*)', 'Bash(*$HOME*)', 'Bash(*${HOME}*)',
  'Bash(* ../*)', 'Bash(* "../*)', "Bash(* '../*)", 'Bash(*<../*)', 'Bash(*< ../*)', 'Bash(*/../*)', 'Bash(* ..)',
  'Bash(git push *)', 'Bash(git push)', 'Bash(git commit *)', 'Bash(git reset *)', 'Bash(git checkout *)', 'Bash(git switch *)',
  'Bash(git rebase *)', 'Bash(git merge *)', 'Bash(git tag *)', 'Bash(git stash *)', 'Bash(git * --output*)',
  'Bash(gh pr merge *)', 'Bash(gh pr review *)', 'Bash(gh pr comment *)', 'Bash(gh pr close *)', 'Bash(gh pr edit *)',
  'Bash(gh api *)',
  ...['merge', 'create', 'update', 'note', 'approve', 'revoke', 'close', 'reopen', 'rebase', 'delete'].flatMap((w) => [`Bash(glab mr ${w} *)`, `Bash(glab mr ${w})`]),
  ...['run', 'retry', 'cancel', 'delete', 'trigger'].flatMap((w) => [`Bash(glab ci ${w} *)`, `Bash(glab ci ${w})`]),
  'Bash(glab api *)', 'Bash(rm *)', 'WebFetch', 'WebSearch'
]

/** Codex config overrides that pin its sandbox shut, whatever ~/.codex/config.toml says. */
export const CODEX_OVERRIDES: readonly string[] = [
  'sandbox_workspace_write.network_access=false',
  'sandbox_workspace_write.writable_roots=[]',
  'sandbox_workspace_write.exclude_slash_tmp=true',
  'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  'mcp_servers={}'
]

/** Single-quotes a word for a POSIX shell (zsh, bash). */
export const shellQuote = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

export function lockdownFlags(agent: string): string[] | null {
  if (agent === 'claude') {
    // The lists take several values, so a one-value flag must follow them; the prompt never does.
    return ['--allowedTools', CLAUDE_ALLOW.join(' '), '--disallowedTools', CLAUDE_DENY.join(' '), '--permission-mode', 'dontAsk', '--setting-sources', 'user', '--strict-mcp-config']
  }
  if (agent === 'codex') {
    return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', ...CODEX_OVERRIDES.flatMap((o) => ['-c', o])]
  }
  return null
}

export interface ShellWord {
  /** The word with quotes and escapes removed (exact for flags; approximate inside $(...)). */
  text: string
  start: number
  end: number
}

/**
 * Splits a shell command line into words, keeping where each came from so the rest of the line
 * stays byte for byte. Understands '...', "...", $'...', backslashes, $(...) and backticks, and
 * makes ; | & their own words. Null when quotes do not balance.
 */
export function shellWords(command: string): ShellWord[] | null {
  const words: ShellWord[] = []
  let i = 0
  const n = command.length
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++
    if (i >= n) break
    const start = i
    if (';|&'.includes(command[i])) {
      let j = i + 1
      if ((command[i] === '|' || command[i] === '&') && command[j] === command[i]) j++
      words.push({ text: command.slice(i, j), start, end: j })
      i = j
      continue
    }
    let text = ''
    while (i < n && !/\s/.test(command[i]) && !';|&'.includes(command[i])) {
      const c = command[i]
      if (c === "'") {
        const close = command.indexOf("'", i + 1)
        if (close < 0) return null
        text += command.slice(i + 1, close)
        i = close + 1
      } else if (c === '$' && command[i + 1] === "'") {
        let j = i + 2
        while (j < n && command[j] !== "'") j += command[j] === '\\' ? 2 : 1
        if (j >= n) return null
        text += command.slice(i + 2, j)
        i = j + 1
      } else if (c === '"') {
        let j = i + 1
        while (j < n && command[j] !== '"') {
          if (command[j] === '\\' && j + 1 < n) {
            text += command[j + 1]
            j += 2
          } else {
            text += command[j++]
          }
        }
        if (j >= n) return null
        i = j + 1
      } else if (c === '\\') {
        text += command[i + 1] ?? ''
        i += 2
      } else if (c === '$' && command[i + 1] === '(') {
        let depth = 0
        let j = i + 1
        for (; j < n; j++) {
          if (command[j] === '(') depth++
          else if (command[j] === ')' && --depth === 0) break
        }
        if (j >= n) return null
        text += command.slice(i, j + 1)
        i = j + 1
      } else if (c === '`') {
        const close = command.indexOf('`', i + 1)
        if (close < 0) return null
        text += command.slice(i, close + 1)
        i = close + 1
      } else {
        text += c
        i++
      }
    }
    words.push({ text, start, end: i })
  }
  return words
}

const PROGRAM: Record<string, RegExp> = {
  claude: /^claude(?:\.(?:exe|cmd))?$/i,
  codex: /^codex(?:\.(?:js|mjs|cjs|exe|cmd))?$/i
}
const basename = (w: string): string => w.split(/[\\/]/).pop() ?? w

/** Flags that grant more than a reviewer may have, per agent: bare, and with one value. */
const STRIP: Record<string, { bare: readonly string[]; valued: readonly string[] }> = {
  claude: {
    bare: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
    valued: ['--permission-mode', '--setting-sources', '--permission-prompt-tool']
  },
  codex: {
    bare: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me'],
    valued: ['-s', '--sandbox', '-a', '--ask-for-approval', '--add-dir']
  }
}
/** Codex `-c key=value` overrides that would loosen the sandbox again. */
const CODEX_LOOSE_KEY = /^(sandbox_mode|approval_policy|approvals_reviewer|sandbox_permissions|sandbox_workspace_write|mcp_servers)(\.|=|$)/

export type LockResult = { command: string; mode: LockMode } | { deny: string }

const DENY_PREFIX = 'Matriarch review worktrees are read-only'

/**
 * The launch command a reviewer of this agent must run: the person's permission flags taken out
 * and the lockdown flags put right after the program. A deny when that cannot be done safely.
 */
export function lockdownCommand(agent: string, command: string): LockResult {
  const flags = lockdownFlags(agent)
  if (!flags) {
    return { deny: `${DENY_PREFIX}, and Matriarch can only start claude and codex read-only. To use ${agent} as a reviewer anyway, set "readOnly": false on it in .orca/matriarch.json.` }
  }
  const words = shellWords(command)
  if (!words) return { deny: `${DENY_PREFIX}: Matriarch could not read this launch command, so it did not start it.` }
  const program = words.findIndex((w) => PROGRAM[agent].test(basename(w.text)))
  if (program < 0) return { deny: `${DENY_PREFIX}: Matriarch could not find ${agent} in this launch command, so it did not start it.` }

  const strip = STRIP[agent]
  const drop = new Set<number>()
  for (let i = program + 1; i < words.length; i++) {
    const t = words[i].text
    if (t === '--' || t === ';' || t === '&&' || t === '||' || t === '|' || t === '&') break
    if (strip.bare.includes(t)) drop.add(i)
    else if (strip.valued.includes(t)) {
      drop.add(i)
      if (i + 1 < words.length) drop.add(++i)
    } else if (strip.valued.some((f) => f.startsWith('--') && t.startsWith(`${f}=`))) drop.add(i)
    else if (agent === 'codex' && (t === '-c' || t === '--config') && CODEX_LOOSE_KEY.test(words[i + 1]?.text ?? '')) {
      drop.add(i)
      drop.add(++i)
    } else if (agent === 'codex' && t.startsWith('--config=') && CODEX_LOOSE_KEY.test(t.slice(9))) drop.add(i)
  }

  let out = ''
  let at = 0
  for (let i = 0; i < words.length; i++) {
    if (drop.has(i)) {
      // Cut the word and the space before it.
      out += command.slice(at, words[i].start).replace(/\s+$/, '')
      at = words[i].end
      continue
    }
    if (i === program) {
      out += command.slice(at, words[i].end) + ' ' + flags.map(shellQuote).join(' ')
      at = words[i].end
    }
  }
  out += command.slice(at)
  return { command: out, mode: agent === 'claude' ? 'claude-dontask' : 'codex-sandbox' }
}

/** Which review worktree a workspace id names: Orca's ids are `<repoId>::<path>`. */
export function reviewWorktreeOf(workspaceId: string | null, guard: Guard): string | null {
  if (workspaceId === null) return null
  return guard.pathOf?.get(workspaceId) ?? guard.paths.find((p) => workspaceId.endsWith(`::${p}`)) ?? (guard.ids.has(workspaceId) && guard.paths.length === 1 ? guard.paths[0] : null)
}

export interface Lockdown {
  /** Lets this agent start unchanged in this worktree (a reviewer with `"readOnly": false`). */
  exempt(path: string, agent: string): void
  /** The mode this agent was last started with in this worktree, if at or after `since`. */
  confirmed(path: string, agent: string, since: number): LockMode | null
  /** The same, also from what a previous run of the plugin recorded (it may have been reloaded). */
  recall(path: string, agent: string, since: number): Promise<LockMode | null>
  /** Drops what is known about a worktree once it is gone. */
  forget(path: string): void
  /** The agent.launch.before decision: a rewritten command, a refusal, or null to pass. */
  onLaunch(event: { agent: string; workspaceId: string | null; command: string }, guard: Guard): LockResult | null
}

/** Where launch records outlive a reload of the plugin (its storage); optional in tests. */
export interface LockdownStore {
  get(key: string): Promise<unknown>
  set(key: string, value: { mode: LockMode; at: number } | null): Promise<void>
}

export function createLockdown(now: () => number = Date.now, store?: LockdownStore): Lockdown {
  const exempt = new Set<string>()
  const started = new Map<string, { mode: LockMode; at: number }>()
  const key = (path: string, agent: string) => `${path}\n${agent}`
  const stored = (path: string, agent: string) => `lockdown:${key(path, agent)}`
  const note = (path: string, agent: string, mode: LockMode) => {
    const record = { mode, at: now() }
    started.set(key(path, agent), record)
    // The hook may not wait, so this is not awaited; a reload in between only loses the record.
    void store?.set(stored(path, agent), record).catch(() => {})
  }
  return {
    exempt: (path, agent) => void exempt.add(key(path, agent)),
    confirmed(path, agent, since) {
      const s = started.get(key(path, agent))
      return s && s.at >= since ? s.mode : null
    },
    async recall(path, agent, since) {
      const here = this.confirmed(path, agent, since)
      if (here || !store) return here
      const s = (await store.get(stored(path, agent)).catch(() => null)) as { mode?: LockMode; at?: number } | null
      return s?.mode && (s.at ?? 0) >= since ? s.mode : null
    },
    forget(path) {
      for (const k of [...exempt]) if (k.startsWith(`${path}\n`)) exempt.delete(k)
      for (const k of [...started.keys()]) {
        if (!k.startsWith(`${path}\n`)) continue
        started.delete(k)
        void store?.set(`lockdown:${k}`, null).catch(() => {})
      }
    },
    onLaunch(event, guard) {
      const path = reviewWorktreeOf(event.workspaceId, guard)
      if (path === null) return null
      if (exempt.has(key(path, event.agent))) {
        note(path, event.agent, 'off')
        return null
      }
      const result = lockdownCommand(event.agent, event.command)
      if ('mode' in result) note(path, event.agent, result.mode)
      return result
    }
  }
}
