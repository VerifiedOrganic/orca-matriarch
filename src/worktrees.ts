// Removing a worktree Matriarch is done with. Every check runs in the worktree itself, right
// before it goes: what Orca's lists said a minute ago does not count, since a worker can start in
// it again, switch it to another branch, or commit there in between.

import type { Exec } from './exec.ts'
import type { OrcaCli } from './orca-cli.ts'

/** Which worktree this is, and so what must hold before it goes. */
export type RemoveWorktree =
  /**
   * A merged PR's: it goes with its branch, but only while it still holds that PR's branch and
   * nothing the PR did not have. `heads` are the PR's head commits Matriarch saw, the merged one
   * first: a branch the forge rebased has a head the worktree never had, so any of them counts.
   */
  | { merged: { number: number; branch: string; heads: readonly string[] } }
  /** One that never became a PR: its branch stays, and it goes only if every commit on that branch is on a remote. */
  | { keepBranch: true }

export interface RemovedWorktree {
  removed: boolean
  /** Why it stayed. */
  reason?: string
  /** It holds other work now: it is no longer this cleanup's to remove. */
  moved?: boolean
}

export async function removeWorktree(exec: Exec, cli: OrcaCli, path: string, what: RemoveWorktree): Promise<RemovedWorktree> {
  // Anything uncommitted keeps it, an untracked file too, whatever the repository's own
  // status.showUntrackedFiles says. Ignored files (builds, caches, a local copy of an env file)
  // are not work in progress and go with it.
  const status = await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=normal'], { timeoutMs: 15_000 })
  if (status.code !== 0) return { removed: false, reason: 'git status failed there' }
  if (status.stdout.trim()) return { removed: false, reason: 'it has uncommitted changes' }
  // The full ref, so a tag of the same name cannot make it ambiguous. Exit 1 is a detached HEAD;
  // any other failure (a timeout is 124) means git could not tell, and it is tried again later.
  const head = await exec('git', ['-C', path, 'symbolic-ref', '-q', 'HEAD'], { timeoutMs: 10_000 })
  const detached = head.code === 1
  if (head.code !== 0 && !detached) return { removed: false, reason: 'git could not read its branch there' }
  const ref = head.code === 0 ? head.stdout.trim() : null
  if ('merged' in what) {
    const pr = what.merged
    // Another branch, or a detached commit: a later worker took the worktree over. Its work is
    // not this PR's, and removing the worktree would delete that branch too.
    if (ref !== `refs/heads/${pr.branch}`) {
      const now = ref ? `on ${ref.replace(/^refs\/heads\//, '')}` : 'on a detached commit'
      return { removed: false, moved: true, reason: `it is ${now} now, not #${pr.number}'s branch` }
    }
    if (!(await nothingNew(exec, path, pr.heads))) return { removed: false, reason: `it has commits that #${pr.number} did not have` }
    await cli.run(['worktree', 'rm', '--worktree', `path:${path}`, '--delete-branch'])
    return { removed: true }
  }
  // One on a detached commit (a gate checking a PR) has no commits of its own.
  if (ref !== null && !(await pushed(exec, path))) return { removed: false, reason: 'it has commits that are not pushed' }
  await cli.run(['worktree', 'rm', '--worktree', `path:${path}`])
  return { removed: true }
}

/**
 * Whether every commit the worktree holds was in the PR: none is outside all of its heads (one
 * git does not have here, pushed from elsewhere, is skipped). Failing that, whether every commit
 * is on a remote, so nothing is lost with it either.
 */
async function nothingNew(exec: Exec, path: string, heads: readonly string[]): Promise<boolean> {
  if (heads.length > 0) {
    const r = await exec('git', ['-C', path, 'rev-list', '--count', '--ignore-missing', 'HEAD', '--not', ...heads], { timeoutMs: 15_000 })
    if (r.code === 0 && r.stdout.trim() === '0') return true
  }
  return pushed(exec, path)
}

/** Whether every commit HEAD holds is on a remote. */
async function pushed(exec: Exec, path: string): Promise<boolean> {
  const r = await exec('git', ['-C', path, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], { timeoutMs: 15_000 })
  return r.code === 0 && r.stdout.trim() === '0'
}
