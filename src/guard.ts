// The read-only guard for reviewers in review worktrees (Claude Code waits on agent.tool.before,
// so a deny here stops the tool call). It allows what is known to be read-only and refuses the
// rest: an allowlist, not a denylist. Pure and synchronous: Orca gives a hook 2 s, and nothing
// here may await.
import { isAbsolute, normalize, resolve } from 'node:path'

export interface Guard {
  ids: ReadonlySet<string>
  paths: readonly string[]
  /** Workspace id → its review worktree path, when known. */
  pathOf?: ReadonlyMap<string, string>
}

export interface ToolEvent {
  tool: string
  workspaceId: string | null
  input: unknown
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const VERDICT_DIR = '.matriarch/review/'
const DENY_WRITE = 'Matriarch reviewers are read-only: write only your verdict file, .matriarch/review/<sha>/<your name>.json.'
const DENY_SHELL = 'Matriarch reviewers are read-only: only read-only commands (git diff/log/show, grep, cat, ls, gh pr view/diff) are allowed here.'
const DENY_OUTSIDE = 'Matriarch reviewers read only this worktree: use paths relative to it (no absolute paths, ~, $HOME or .. out of it).'

/** Is `file` (absolute or relative to `root`) a verdict file inside the review worktree `root`? */
export function isVerdictFile(root: string, file: string): boolean {
  // resolve() folds `..`, so a path that climbs out of the folder no longer starts with it.
  const full = resolve(root, file)
  return full.startsWith(`${resolve(root)}/${VERDICT_DIR}`) && full.endsWith('.json')
}

const inside = (root: string, file: string): boolean => {
  const full = resolve(root, file)
  const base = resolve(root)
  return full === base || full.startsWith(`${base}/`)
}

/** Splits a shell command on unquoted ; && || | and newlines; null when it hides a command. */
export function shellSegments(command: string): { segments: string[]; redirects: string[] } | null {
  const segments: string[] = []
  const redirects: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const next = command[i + 1]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') {
        cur += c + (next ?? '')
        i++
        continue
      } else if (quote === '"' && (c === '`' || (c === '$' && next === '('))) return null
      cur += c
      continue
    }
    if (c === '\\') {
      cur += c + (next ?? '')
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '`' || (c === '$' && next === '(') || ((c === '<' || c === '>') && next === '(')) return null
    if (c === '<' && next === '<') return null // heredocs: write files with the Write tool instead
    if (c === '>') {
      // A redirect: allowed only into the verdict folder, or to /dev/null and between streams.
      let j = i + 1
      if (command[j] === '>') j++
      if (command[j] === '&') {
        i = j + 1
        continue
      }
      while (command[j] === ' ') j++
      let target = ''
      while (j < command.length && !/[\s;&|]/.test(command[j])) target += command[j++]
      redirects.push(target.replace(/^['"]|['"]$/g, ''))
      i = j - 1
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && next === c) i++
      else if (c === '&') return null // backgrounding
      if (cur.trim()) segments.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (quote) return null
  if (cur.trim()) segments.push(cur.trim())
  return { segments, redirects }
}

const words = (segment: string): string[] => segment.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g)?.map((w) => w.replace(/^['"]|['"]$/g, '')) ?? []

const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'tree', 'wc', 'file', 'stat', 'du',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'comm', 'nl', 'column', 'basename', 'dirname', 'realpath',
  'readlink', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'cd', 'od', 'hexdump', 'strings', 'bat', 'fd', 'which', 'type',
  // Checksums only read: a reviewer checks a lockfile or an artifact against them.
  'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'md5', 'md5sum', 'b2sum', 'cksum', 'xxd'
])
const GIT_READ = new Set([
  'diff', 'log', 'show', 'status', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'cat-file', 'merge-base',
  'shortlog', 'describe', 'name-rev', 'rev-list', 'whatchanged', 'for-each-ref', 'show-ref', 'count-objects'
])

function gitAllowed(args: string[]): boolean {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C' || args[i] === '-c') i += 2
    else if (['--no-pager', '--no-optional-locks', '-P'].includes(args[i]) || /^--(git-dir|work-tree)=/.test(args[i])) i++
    else return false
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (GIT_READ.has(sub)) return !rest.some((a) => a === '--output' || a.startsWith('--output='))
  if (sub === 'branch') return rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--contains', '--merged', '--no-merged'].includes(a) || !a.startsWith('-'))
    && !rest.some((a) => /^-[dDmMcC]|^--(delete|move|copy|set-upstream)/.test(a)) && rest.filter((a) => !a.startsWith('-')).length === 0
  if (sub === 'remote') return rest.every((a) => a === '-v' || a === 'show' || a === 'get-url')
  if (sub === 'config') return rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-regexp')
  if (sub === 'worktree') return rest[0] === 'list'
  return false
}

function ghAllowed(args: string[]): boolean {
  const [a, b] = args
  if (a === 'pr' || a === 'issue' || a === 'run' || a === 'repo') return ['view', 'diff', 'checks', 'list', 'status'].includes(b)
  if (a === 'api') {
    // Reads only: no method other than GET, and no fields or body (those make it a POST).
    for (let i = 1; i < args.length; i++) {
      const x = args[i]
      if ((x === '-X' || x === '--method') && (args[i + 1] ?? '').toUpperCase() !== 'GET') return false
      if (/^--method=/.test(x) && x.slice(9).toUpperCase() !== 'GET') return false
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(x) || /^-[fF]./.test(x)) return false
    }
    return true
  }
  return false
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Tools whose first operand is a pattern or a script, not a file. */
const PATTERN_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk'])

/** The words of a segment that may name files: a search tool's pattern or script is left out. */
function pathWords(w: readonly string[]): string[] {
  const out: string[] = []
  let i = 0
  // VAR=value assignments can carry a path into a later "$VAR".
  while (i < w.length && ASSIGNMENT.test(w[i])) out.push(w[i++])
  const cmd = w[i++]
  if (cmd === undefined) return out
  let args = w.slice(i)
  let tool = cmd
  if (cmd === 'git' && args.includes('grep')) {
    // Options before `grep` (such as -C <dir>) are paths; after it, grep's rules apply.
    out.push(...args.slice(0, args.indexOf('grep')))
    args = args.slice(args.indexOf('grep') + 1)
    tool = 'grep'
  }
  if (!PATTERN_TOOLS.has(tool)) return [...out, ...args]
  // With -e or -f the patterns come from options, and every operand is a file.
  let patternTaken = args.some((a) => ['-e', '--regexp', '--expression', '-f', '--file'].includes(a) || /^--(regexp|expression|file)=|^-e./.test(a))
  for (let j = 0; j < args.length; j++) {
    const a = args[j]
    if (a === '-e' || a === '--regexp' || a === '--expression' || (tool === 'awk' && (a === '-v' || a === '-F'))) {
      j++ // its value is a pattern, a variable or a separator
      continue
    }
    if (/^-e./.test(a) || /^--(regexp|expression)=/.test(a)) continue
    if (a.startsWith('-') || patternTaken) out.push(a)
    else patternTaken = true
  }
  return out
}

/** Whether one word, read from `base`, names nothing outside the worktree. */
function wordInside(word: string, base: string | null, root: string | null): boolean {
  // The value of --opt=value and VAR=value, and the file of a <redirect, count as paths too.
  const value = word.replace(/^(--?[A-Za-z][A-Za-z-]*|[A-Za-z_][A-Za-z0-9_]*)=/, '').replace(/^<+/, '')
  if (/^~|\$HOME\b|\$\{HOME\}/.test(value)) return false
  if (value === '' || value === '/dev/null') return true
  if (isAbsolute(value)) return root !== null && inside(root, normalize(value))
  if (value.split('/').includes('..')) return root !== null && base !== null && inside(root, resolve(base, value))
  return true
}

/**
 * Whether a command reads only inside the review worktree: no ~ or $HOME, no absolute path
 * elsewhere (but /dev/null), nothing that climbs out with `..`, following `cd` from segment to
 * segment. A revision range such as `main...HEAD` and a search pattern are not paths. Without a
 * known root, nothing outside can be ruled out.
 */
export function staysInside(segments: readonly string[], root: string | null): boolean {
  let base = root
  for (const segment of segments) {
    const w = words(segment)
    let k = 0
    while (k < w.length && ASSIGNMENT.test(w[k])) k++
    if (w[k] === 'cd') {
      const target = w[k + 1] ?? '~'
      if (target === '-' || !wordInside(target, base, root) || (base !== null && !inside(root ?? base, resolve(base, target)))) return false
      if (base !== null) base = resolve(base, target)
      continue
    }
    if (!pathWords(w).every((word) => wordInside(word, base, root))) return false
  }
  return true
}

function segmentAllowed(segment: string, root: string | null): boolean {
  const w = words(segment)
  // Leading VAR=value assignments only set shell variables.
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift()
  if (w.length === 0) return true
  const [cmd, ...args] = w
  if (cmd === 'git') return gitAllowed(args)
  if (cmd === 'gh') return ghAllowed(args)
  if (cmd === 'sed') return !args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place') || /(^|[;{])\s*[wW]\s/.test(a))
  if (cmd === 'awk') return !args.some((a) => /system\s*\(|print[^|]*>|\|\s*"/.test(a))
  if (cmd === 'find') return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a))
  if (cmd === 'mkdir') return root !== null && args.filter((a) => !a.startsWith('-')).every((d) => resolve(root, d).startsWith(`${resolve(root)}/.matriarch/`))
  if (cmd === 'tee') return root !== null && args.filter((a) => !a.startsWith('-')).every((f) => isVerdictFile(root, f))
  return READ_ONLY.has(cmd)
}

/** Whether a shell command only reads, with writes allowed solely into the verdict folder. */
export function isReadOnlyShell(command: string, root: string | null): boolean {
  return shellDecision(command, root) === null
}

/** Null when the command only reads inside the worktree; else the reason to refuse it. */
function shellDecision(command: string, root: string | null): string | null {
  const parsed = shellSegments(command)
  if (!parsed) return DENY_SHELL
  for (const target of parsed.redirects) {
    if (target === '/dev/null') continue
    if (root === null || !isVerdictFile(root, target)) return DENY_SHELL
  }
  if (!parsed.segments.every((s) => segmentAllowed(s, root))) return DENY_SHELL
  if (!staysInside(parsed.segments, root)) return DENY_OUTSIDE
  return null
}

/** The review worktree a call runs in: by workspace id (Orca's are `<repoId>::<path>`), else by file path. */
function reviewRoot(ws: string | null, file: string | null, guard: Guard): string | null {
  if (ws !== null) {
    const known = guard.pathOf?.get(ws)
    if (known) return known
    const byId = guard.paths.find((p) => ws.endsWith(`::${p}`))
    if (byId) return byId
    if (guard.ids.has(ws) && guard.paths.length === 1) return guard.paths[0]
  }
  if (file !== null && isAbsolute(file)) return guard.paths.find((p) => inside(p, normalize(file))) ?? null
  return null
}

/**
 * The decision for one tool call: a reason to refuse it, or null to let it through. Only calls
 * in a running (or kept) review worktree are judged; every other workspace is untouched.
 */
export function reviewGuard(event: ToolEvent, guard: Guard): { deny: string } | null {
  const input = (typeof event.input === 'object' && event.input !== null ? event.input : {}) as Record<string, unknown>
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  const root = reviewRoot(event.workspaceId, file, guard)
  if (root === null) return null
  if (WRITE_TOOLS.has(event.tool)) return file !== null && isVerdictFile(root, file) ? null : { deny: DENY_WRITE }
  if (event.tool === 'Bash') {
    const reason = shellDecision(typeof input.command === 'string' ? input.command : '', root)
    return reason ? { deny: reason } : null
  }
  // Reading and searching stay inside the worktree too.
  if (READ_TOOLS.has(event.tool)) {
    const target = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null
    if (target !== null && !inside(root, target)) return { deny: DENY_OUTSIDE }
  }
  return null
}
