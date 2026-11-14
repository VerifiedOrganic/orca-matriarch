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
// Read by a reviewer or the advisor, whichever runs in the worktree: each was told its own file.
const DENY_WRITE = 'This worktree is read-only (a Matriarch reviewer or advisor): write only the JSON file your brief names, under .matriarch/review/.'
const DENY_SHELL = 'This worktree is read-only (a Matriarch reviewer or advisor): only read-only commands (git diff/log/show, grep, cat, ls, gh pr view/diff, glab mr view/diff) are allowed here.'
const DENY_OUTSIDE = 'This worktree is read-only (a Matriarch reviewer or advisor), and only it may be read: use paths relative to it (no absolute paths, ~, $HOME or .. out of it).'

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
    // An escape, $'…' or $"…" quoting and {a,b} expansion all make a word other than it reads
    // (`--out\\put`, `--p{re,}`), which would slip a flag past the checks below.
    if (c === '\\' || c === '{' || (c === '$' && (next === "'" || next === '"'))) return null
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
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'tree', 'wc', 'file', 'stat', 'du',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'comm', 'nl', 'column', 'basename', 'dirname', 'realpath',
  'readlink', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[', 'cd', 'od', 'hexdump', 'strings', 'bat', 'fd', 'which', 'type',
  // Checksums only read: a reviewer checks a lockfile or an artifact against them.
  'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'md5', 'md5sum', 'b2sum', 'cksum', 'xxd'
])
const GIT_READ = new Set([
  'diff', 'log', 'show', 'status', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'cat-file', 'merge-base',
  'shortlog', 'describe', 'name-rev', 'rev-list', 'whatchanged', 'for-each-ref', 'show-ref', 'count-objects'
])

/** The option a word names, without its =value. */
const optName = (a: string): string => a.split('=')[0]
/** Whether `a` is `long` or a shortening of it, which git and GNU tools accept for a long option. */
const shortens = (a: string, long: string, min = 3): boolean => a.startsWith('--') && optName(a).length >= min && long.startsWith(optName(a))
/** Whether `a` is a cluster of short options (-iO, -Hx) holding one of `letters`. */
const clusterHas = (a: string, letters: string): boolean => /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => letters.includes(ch))
/** The operands of a command: its words that are not options. */
const operands = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith('-'))

function gitAllowed(args: string[]): boolean {
  let i = 0
  // Not -c, --git-dir or --work-tree: a config value (core.fsmonitor, diff.external) runs a program.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2
    else if (['--no-pager', '--no-optional-locks', '-P'].includes(args[i])) i++
    else return false
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  // git grep -O / --open-files-in-pager runs a program on the files it finds.
  if (sub === 'grep' && rest.some((a) => clusterHas(a, 'O') || shortens(a, '--open-files-in-pager', 4))) return false
  if (GIT_READ.has(sub)) return !rest.some((a) => shortens(a, '--output'))
  if (sub === 'branch') return rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--contains', '--merged', '--no-merged'].includes(a) || !a.startsWith('-'))
    && !rest.some((a) => /^-[dDmMcC]|^--(delete|move|copy|set-upstream)/.test(a)) && rest.filter((a) => !a.startsWith('-')).length === 0
  if (sub === 'remote') return rest.every((a) => a === '-v' || a === 'show' || a === 'get-url')
  if (sub === 'config') return rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-regexp')
  if (sub === 'worktree') return rest[0] === 'list'
  return false
}

/** `gh api` and `glab api` reads: no method other than GET, and no fields or body (those make it a POST). */
function apiReadOnly(args: string[]): boolean {
  for (let i = 1; i < args.length; i++) {
    const x = args[i]
    if ((x === '-X' || x === '--method') && (args[i + 1] ?? '').toUpperCase() !== 'GET') return false
    if (/^--method=/.test(x) && x.slice(9).toUpperCase() !== 'GET') return false
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(x) || /^-[fF]./.test(x)) return false
  }
  return true
}

function ghAllowed(args: string[]): boolean {
  const [a, b] = args
  if (a === 'pr' || a === 'issue' || a === 'run' || a === 'repo') return ['view', 'diff', 'checks', 'list', 'status'].includes(b)
  if (a === 'api') return apiReadOnly(args)
  return false
}

/** glab's read-only commands; `ci view` is left out, as its screen can run and retry jobs. */
const GLAB_READ: Record<string, readonly string[]> = {
  mr: ['view', 'diff', 'list'],
  issue: ['view', 'list'],
  ci: ['status', 'list', 'get', 'trace'],
  repo: ['view']
}

function glabAllowed(args: string[]): boolean {
  const [a, b] = args
  if (a === 'api') return apiReadOnly(args)
  return Object.hasOwn(GLAB_READ, a) && GLAB_READ[a].includes(b)
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

/** One sed command that only prints, deletes from the output, quits or numbers lines, after an address. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/I?)`
const SED_PRINT = new RegExp(String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?)?\s*!?\s*[pdq=]?\s*$`)

/** sed only to print lines: -n/-E and scripts of addresses with p, d, q or =. Not -i, -f, w, r or e. */
function sedAllowed(args: readonly string[]): boolean {
  const scripts: string[] = []
  let fromOption = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-e' || a === '--expression') {
      scripts.push(args[++i] ?? '')
      fromOption = true
    } else if (a.startsWith('--expression=')) {
      scripts.push(a.slice(13))
      fromOption = true
    } else if (a.startsWith('-')) {
      if (!['-n', '-E', '-r', '--quiet', '--silent', '--regexp-extended', '--posix'].includes(a)) return false
    } else if (!fromOption && scripts.length === 0) scripts.push(a)
  }
  return scripts.length > 0 && scripts.every((s) => s.split(/[;\n]/).every((cmd) => SED_PRINT.test(cmd)))
}

/** awk's program without its -F and -v values: no system(), no pipe to or from a command, no getline or print into a file. */
function awkAllowed(args: readonly string[]): boolean {
  const program: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-F' || a === '-v') i++
    else if (a === '-f') return false
    else if (!a.startsWith('-')) program.push(a)
  }
  return !program.some((a) => /system\s*\(|getline|\||print[^|]*>/.test(a))
}

/**
 * Flags that make a read-only tool run a program or write a file, by tool. A tool not listed
 * has none. Long options are matched with their shortenings where the tool accepts them.
 */
const RISKY_FLAGS: Record<string, (args: readonly string[]) => boolean> = {
  rg: (args) => args.some((a) => a.startsWith('--pre') || a.startsWith('--hostname-bin')),
  ag: (args) => args.some((a) => shortens(a, '--pager', 4)),
  fd: (args) => args.some((a) => a.startsWith('--exec') || clusterHas(a, 'xX')),
  bat: (args) => args.some((a) => a.startsWith('--pager')),
  sort: (args) => args.some((a) => clusterHas(a, 'o') || shortens(a, '--output') || shortens(a, '--compress-program', 4)),
  tree: (args) => args.some((a) => clusterHas(a, 'o')),
  file: (args) => args.some((a) => clusterHas(a, 'C') || shortens(a, '--compile', 4)),
  yq: (args) => args.some((a) => clusterHas(a, 'i') || a.startsWith('--inplace') || a.startsWith('--in-place')),
  // With a second operand these write their output there.
  uniq: (args) => operands(args).length > 1,
  xxd: (args) => operands(args).length > 1
}
/** Tools whose words a $VAR could turn into a flag: one with flags that matter, or a pattern. */
const FLAG_SENSITIVE = new Set(['git', 'gh', 'glab', 'sed', 'awk', 'find', 'mkdir', 'tee', ...Object.keys(RISKY_FLAGS)])

/** Whether a segment expands a variable outside single quotes ($f, "$f", ${f}). */
function expandsVariable(segment: string): boolean {
  let single = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === "'") single = !single
    else if (!single && c === '$' && /[A-Za-z0-9_{@*#?!-]/.test(segment[i + 1] ?? '')) return true
  }
  return false
}

function segmentAllowed(segment: string, root: string | null): boolean {
  const w = words(segment)
  let k = 0
  while (k < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k])) k++
  // A line of only assignments sets shell variables, which later words may read. Not uppercase
  // names: those are the environment (PATH, LESSOPEN, GIT_CONFIG_*, PAGER), which programs act on.
  if (k === w.length) return w.every((a) => /^[a-z_][a-z0-9_]*=/.test(a))
  // VAR=value before a command puts it in that command's environment: GIT_EXTERNAL_DIFF and the like.
  if (k > 0) return false
  const [cmd, ...args] = w
  if (FLAG_SENSITIVE.has(cmd) && expandsVariable(segment)) return false
  if (cmd === 'git') return gitAllowed(args)
  if (cmd === 'gh') return ghAllowed(args)
  if (cmd === 'glab') return glabAllowed(args)
  if (cmd === 'sed') return sedAllowed(args)
  if (cmd === 'awk') return awkAllowed(args)
  if (cmd === 'find') return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a))
  if (cmd === 'mkdir') return root !== null && args.filter((a) => !a.startsWith('-')).every((d) => resolve(root, d).startsWith(`${resolve(root)}/.matriarch/`))
  if (cmd === 'tee') return root !== null && args.filter((a) => !a.startsWith('-')).every((f) => isVerdictFile(root, f))
  if (Object.hasOwn(RISKY_FLAGS, cmd) && RISKY_FLAGS[cmd](args)) return false
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
