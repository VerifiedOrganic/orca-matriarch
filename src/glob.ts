// Minimal path globs for `merge.requireHuman`: `**` crosses folders, `*` and `?` stay in one.

const cache = new Map<string, RegExp>()

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob)
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
  const re = new RegExp(out + '$')
  cache.set(glob, re)
  return re
}

/** The globs that match at least one of the paths. */
export function matchingGlobs(globs: readonly string[], paths: readonly string[]): string[] {
  return globs.filter((g) => {
    const re = globToRegExp(g)
    return paths.some((p) => re.test(p))
  })
}
