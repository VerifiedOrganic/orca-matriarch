// Removing a worktree: what is checked in it, right before it goes.
import { assert, describe, test } from 'orca/testing'
import { exitCodeOf, type Exec, type ExecResult } from './exec.ts'
import type { OrcaCli } from './orca-cli.ts'
import { removeWorktree } from './worktrees.ts'

const PATH = '/r/wt/login'
const MERGED = 'b'.repeat(40)
const EARLIER = 'c'.repeat(40)

/**
 * A worktree as git answers in it, to exactly the commands Matriarch runs (anything else fails the
 * test): its status, its HEAD's ref (null when detached, 'error' when git fails), how many of its
 * commits are outside the given heads, and how many are on no remote.
 */
function worktree(state: { status?: string; ref?: string | null | 'error'; beyondHeads?: number; unpushed?: number }) {
  const ran: string[] = []
  const exec: Exec = async (file, args) => {
    assert.deepEqual([file, ...args.slice(0, 2)], ['git', '-C', PATH])
    const cmd = args.slice(2).join(' ')
    ran.push(cmd)
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
    if (cmd === 'status --porcelain --untracked-files=normal') return ok(state.status ?? '')
    if (cmd === 'symbolic-ref -q HEAD') {
      const ref = state.ref === undefined ? 'refs/heads/feature/login' : state.ref
      // nodeExec fills an empty stderr with Node's message, so a detached HEAD's quiet exit 1 is not quiet.
      return ref === 'error' ? { code: 128, stdout: '', stderr: 'fatal: not a git repository' } : ref === null ? { code: 1, stdout: '', stderr: `Command failed: git -C ${PATH} symbolic-ref -q HEAD\n` } : ok(`${ref}\n`)
    }
    if (cmd.startsWith('rev-list --count --ignore-missing HEAD --not ')) return ok(`${state.beyondHeads ?? 0}\n`)
    if (cmd === 'rev-list --count HEAD --not --remotes') return ok(`${state.unpushed ?? 0}\n`)
    throw new Error(`unexpected git ${cmd}`)
  }
  const removed: (readonly string[])[] = []
  const cli: OrcaCli = { run: async (args) => (removed.push(args), {}) }
  return { exec, cli, ran, removed }
}

const merged = (heads: string[] = [MERGED, EARLIER]) => ({ merged: { number: 12, branch: 'feature/login', heads } })

describe("a merged PR's worktree", () => {
  test('goes with its branch while it is on that branch with nothing beyond the heads the PR had', async () => {
    const w = worktree({})
    assert.deepEqual(await removeWorktree(w.exec, w.cli, PATH, merged()), { removed: true })
    assert.deepEqual(w.removed, [['worktree', 'rm', '--worktree', `path:${PATH}`, '--delete-branch']])
    // Every head counts: a branch the forge rebased merged a head this worktree never had.
    assert.ok(w.ran.includes(`rev-list --count --ignore-missing HEAD --not ${MERGED} ${EARLIER}`))
  })

  test('is let go when a later worker switched it to another branch, or to a detached commit', async () => {
    for (const [ref, says] of [['refs/heads/fix/next', 'it is on fix/next now'], [null, 'it is on a detached commit now']] as const) {
      const w = worktree({ ref })
      const res = await removeWorktree(w.exec, w.cli, PATH, merged())
      assert.deepEqual([res.removed, res.moved], [false, true])
      assert.ok(res.reason?.startsWith(says), res.reason)
      assert.deepEqual(w.removed, [], 'its branch is not deleted either')
    }
  })

  test('is kept, and tried again, when git cannot read its branch, a timeout included', async () => {
    const w = worktree({ ref: 'error' })
    assert.deepEqual(await removeWorktree(w.exec, w.cli, PATH, merged()), { removed: false, reason: 'git could not read its branch there' })
    // nodeExec reports a timeout as 124: not a detached HEAD.
    const slow = worktree({})
    const timedOut: Exec = async (file, args) => (args.includes('symbolic-ref') ? { code: 124, stdout: '', stderr: 'Command failed: git -C /r/wt/login symbolic-ref -q HEAD' } : slow.exec(file, args))
    assert.deepEqual(await removeWorktree(timedOut, slow.cli, PATH, merged()), { removed: false, reason: 'git could not read its branch there' })
  })

  test('stays while it has commits beyond the PR that are not pushed; pushed ones lose nothing', async () => {
    const local = worktree({ beyondHeads: 2, unpushed: 2 })
    assert.deepEqual(await removeWorktree(local.exec, local.cli, PATH, merged()), { removed: false, reason: 'it has commits that #12 did not have' })
    assert.deepEqual(local.removed, [])
    const pushed = worktree({ beyondHeads: 2, unpushed: 0 })
    assert.deepEqual(await removeWorktree(pushed.exec, pushed.cli, PATH, merged()), { removed: true })
  })

  test('with no heads known, asks the remotes', async () => {
    const w = worktree({ unpushed: 0 })
    assert.deepEqual(await removeWorktree(w.exec, w.cli, PATH, merged([])), { removed: true })
    assert.ok(!w.ran.some((c) => c.includes('--ignore-missing')))
    const local = worktree({ unpushed: 1 })
    assert.equal((await removeWorktree(local.exec, local.cli, PATH, merged([]))).removed, false)
  })

  test('stays with anything uncommitted, untracked files included, and asks nothing more', async () => {
    const w = worktree({ status: '?? notes.txt\n' })
    assert.deepEqual(await removeWorktree(w.exec, w.cli, PATH, merged()), { removed: false, reason: 'it has uncommitted changes' })
    assert.deepEqual(w.ran, ['status --porcelain --untracked-files=normal'])
  })
})

describe('a finished worktree that never became a PR', () => {
  test('goes without its branch once every commit on it is pushed', async () => {
    const w = worktree({ ref: 'refs/heads/spike' })
    assert.deepEqual(await removeWorktree(w.exec, w.cli, PATH, { keepBranch: true }), { removed: true })
    assert.deepEqual(w.removed, [['worktree', 'rm', '--worktree', `path:${PATH}`]])
  })

  test('stays with unpushed commits; on a detached commit it has none of its own', async () => {
    const local = worktree({ ref: 'refs/heads/spike', unpushed: 1 })
    assert.deepEqual(await removeWorktree(local.exec, local.cli, PATH, { keepBranch: true }), { removed: false, reason: 'it has commits that are not pushed' })
    const gate = worktree({ ref: null, unpushed: 5 })
    assert.deepEqual(await removeWorktree(gate.exec, gate.cli, PATH, { keepBranch: true }), { removed: true })
    const unknown = worktree({ ref: 'error' })
    assert.equal((await removeWorktree(unknown.exec, unknown.cli, PATH, { keepBranch: true })).removed, false)
  })
})

describe('a command that did not exit 0', () => {
  test('has its own code; one that could not start is 127, and one killed by its timeout 124, never 1', () => {
    assert.equal(exitCodeOf({ code: 1 }), 1)
    assert.equal(exitCodeOf({ code: 128 }), 128)
    assert.equal(exitCodeOf({ code: 'ENOENT' }), 127)
    assert.equal(exitCodeOf({ code: null, killed: true, signal: 'SIGTERM' }), 124)
    assert.equal(exitCodeOf({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: 'SIGTERM' }), 124)
  })
})
