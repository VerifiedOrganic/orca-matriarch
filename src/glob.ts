// Minimal path globs for `merge.requireHuman` and `review.light`: `**` crosses folders, `*` and
// `?` stay in one. A list that guards something (protected paths, files that always get the full
// review) matches without regard to case: on a case-insensitive disk (macOS, Windows), where the
// agents work, `claude.md` is the same file to them as `CLAUDE.md`.

export interface GlobOptions {
  ignoreCase?: boolean
}

const cache = new Map<string, RegExp>()

export function globToRegExp(glob: string, options: GlobOptions = {}): RegExp {
  const key = `${options.ignoreCase ? 'i' : ''}\0${glob}`
  const hit = cache.get(key)
  if (hit) return hit
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more folders; a trailing `**` matches the rest.
        const slash = glob[i + 2] === '/'
        out += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const re = new RegExp(out + '$', options.ignoreCase ? 'i' : '')
  cache.set(key, re)
  return re
}

/** The globs that match at least one of the paths. */
export function matchingGlobs(globs: readonly string[], paths: readonly string[], options: GlobOptions = {}): string[] {
  return globs.filter((g) => {
    const re = globToRegExp(g, options)
    return paths.some((p) => re.test(p))
  })
}

/** True when there are paths and each matches at least one of the globs. */
export function everyPathMatches(globs: readonly string[], paths: readonly string[]): boolean {
  if (globs.length === 0 || paths.length === 0) return false
  const res = globs.map((g) => globToRegExp(g))
  return paths.every((p) => res.some((re) => re.test(p)))
}
