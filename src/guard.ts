// The read-only guard for reviewers in review worktrees (Claude Code waits on agent.tool.before,
// so a deny here stops the tool call). It allows what is known to be read-only and refuses the
// rest: an allowlist, not a denylist. Pure and synchronous: Orca gives a hook 2 s, and nothing
// here may await.
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'
import { clip } from './values.ts'

export interface Guard {
  ids: ReadonlySet<string>
  paths: readonly string[]
  /** Workspace id → its review worktree path, when known. */
  pathOf?: ReadonlyMap<string, string>
  /** Claude Code's config folders, where it keeps the long tool outputs an agent reads back. */
  claude?: ClaudeHomes
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
const READ_ONLY_HERE = 'This worktree is read-only (a Matriarch reviewer or advisor)'
const SHELL_RULE = 'Read-only commands such as git diff/log/show, grep, cat, ls, gh pr view/diff and glab mr view/diff are allowed'
const DENY_WRITE = `${READ_ONLY_HERE}: write only the JSON file your brief names, under .matriarch/review/.`
const DENY_OUTSIDE = `${READ_ONLY_HERE}, and only it may be read: use paths relative to it (no absolute paths, ~, $HOME or .. out of it).`
const DENY_UNREADABLE = `${READ_ONLY_HERE}: Matriarch could not tell what this command runs (it has a backslash or {…} outside quotes, $'…', $(…), <(…), backticks, a heredoc, a & that is not && or an unclosed quote), so it was refused. Write it plainly. ${SHELL_RULE}.`
/** Names the part refused, so the agent runs the rest without it instead of sending the same command again. */
const denyShell = (part: string): string =>
  `${READ_ONLY_HERE}: ${part} was refused, as Matriarch could not tell that it only reads (an option that writes a file or runs a program, or a $VARIABLE where one could go, is refused too). ${SHELL_RULE}. Run the rest without it.`
const denyRedirect = (target: string): string =>
  `${READ_ONLY_HERE}: the redirect to ${target} was refused: output may go only to the JSON file your brief names, under .matriarch/review/, or to /dev/null. Run the rest without it.`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Where Claude Code keeps its config, and so the tool outputs it saves: folders it may use. */
export interface ClaudeHomes {
  /** Config folders by their path: `~/.claude`, and `$CLAUDE_CONFIG_DIR` when set. */
  dirs: readonly string[]
  /** The folder of Orca's Claude profiles; each profile's config folder is `<it>/<uuid>/home`. */
  profiles: string | null
}

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

/** Is `dir` one of Claude Code's config folders: a known one, or an Orca profile's `home`? */
function isClaudeHome(dir: string, homes: ClaudeHomes): boolean {
  if (homes.dirs.some((d) => resolve(d) === dir)) return true
  const profile = dirname(dir)
  return homes.profiles !== null && basename(dir) === 'home' && UUID.test(basename(profile)) && dirname(profile) === resolve(homes.profiles)
}

/**
 * The folder name Claude Code gives a working directory under `projects/`: each character but
 * letters and digits a dash; a name over 200 characters is cut there and given a hash, which
 * Matriarch cannot work out, so it takes any lowercase letters and digits after the cut.
 */
function isProjectFolder(name: string, root: string): boolean {
  const full = resolve(root).replace(/[^A-Za-z0-9]/g, '-')
  if (full.length <= 200) return name === full
  return name.startsWith(`${full.slice(0, 200)}-`) && /^[a-z0-9]+$/.test(name.slice(201))
}

/**
 * Is `file` a tool output Claude Code kept for a session in the worktree `root`? It writes an
 * output too long to show into its config folder, then has the agent read it back:
 * `<config folder>/projects/<root's folder name>/<session>/tool-results/<file>`. The config folder
 * must be one Claude uses (`homes`), and the rest exactly that shape.
 */
export function isOwnToolOutput(root: string, file: string, homes: ClaudeHomes): boolean {
  if (!isAbsolute(file)) return false
  const parts = normalize(file).split('/')
  if (parts.length < 7) return false
  const [projects, project, session, folder, name] = parts.slice(-5)
  return (
    projects === 'projects' &&
    isProjectFolder(project, root) &&
    UUID.test(session) &&
    folder === 'tool-results' &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name) &&
    isClaudeHome(parts.slice(0, -5).join('/'), homes)
  )
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
      // `>>` appends and `>|` (zsh `>>|`) overrides noclobber: the same writes. A stream number
      // just before it (`2>`) is part of the redirect, not a word of the command.
      cur = cur.replace(/(^|\s)\d+$/, '$1')
      let j = i + 1
      if (command[j] === '>') j++
      if (command[j] === '|') j++
      const copy = command[j] === '&'
      if (copy) j++
      while (command[j] === ' ') j++
      // The target ends where the shell ends it, a `<` or `>` included: `>a.json>../x` is two
      // redirects, and the second writes.
      let target = ''
      while (j < command.length && !/[\s;&|<>]/.test(command[j])) target += command[j++]
      i = j - 1
      // `2>&1`, `>&2`, `>&-` and `2>&1-` copy, close or move a stream. Any other word after `>&`
      // is a file both streams are written to (bash and zsh `>&file`, zsh `>>&file`).
      if (copy && /^(?:\d+-?|-)$/.test(target)) continue
      // One pair of quotes around it at most; any other quote would make it another word.
      const bare = /^(['"])(.*)\1$/.exec(target)?.[2] ?? target
      if (/['"]/.test(bare)) return null
      redirects.push(bare)
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
  'diff', 'log', 'show', 'status', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'cat-file', 'merge-base', 'check-ignore',
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
  if (!parsed) return DENY_UNREADABLE
  const shown = (s: string) => `\`${clip(s, 120)}\``
  for (const target of parsed.redirects) {
    if (target === '/dev/null') continue
    if (root === null || !isVerdictFile(root, target)) return denyRedirect(shown(target))
  }
  const refused = parsed.segments.find((s) => !segmentAllowed(s, root))
  if (refused !== undefined) return denyShell(shown(refused))
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
  // Reading and searching stay inside the worktree too, but for reading back the agent's own
  // tool output that Claude Code kept for it. Claude trims a path and expands a leading ~ to the
  // home folder; a Glob pattern can be a path of its own.
  if (READ_TOOLS.has(event.tool)) {
    const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null
    const target = raw?.trim() ?? null
    const own = (t: string) => event.tool === 'Read' && guard.claude !== undefined && isOwnToolOutput(root, t, guard.claude)
    if (target !== null && (target.startsWith('~') || (!inside(root, target) && !own(target)))) return { deny: DENY_OUTSIDE }
    const pattern = event.tool === 'Glob' && typeof input.pattern === 'string' ? input.pattern.trim() : null
    if (pattern !== null && (pattern.startsWith('~') || isAbsolute(pattern) || pattern.split('/').includes('..'))) return { deny: DENY_OUTSIDE }
  }
  return null
}
