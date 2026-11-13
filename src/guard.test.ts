import { assert, describe, test } from 'orca/testing'
import { isReadOnlyShell, isVerdictFile, reviewGuard } from './guard.ts'

const root = '/wt/review-12'
const guard = { ids: new Set(['repo1::/wt/review-12']), paths: [root] }
const ws = 'repo1::/wt/review-12'
const bash = (command: string) => reviewGuard({ tool: 'Bash', workspaceId: ws, input: { command } }, guard)
const write = (file_path: string) => reviewGuard({ tool: 'Write', workspaceId: ws, input: { file_path } }, guard)

describe('verdict files', () => {
  test('only a .json under .matriarch/review/ of this worktree, after resolving ..', () => {
    assert.ok(isVerdictFile(root, '.matriarch/review/abc/correctness.json'))
    assert.ok(isVerdictFile(root, `${root}/.matriarch/review/abc/security.json`))
    assert.ok(!isVerdictFile(root, '.matriarch/review/../../../worker/src/a.ts'))
    assert.ok(!isVerdictFile(root, `${root}/.matriarch/review/../../src/a.json`))
    assert.ok(!isVerdictFile(root, '.matriarch/review/abc/notes.md'))
    assert.equal(write(`${root}/.matriarch/review/abc/correctness.json`), null)
    assert.ok(write(`${root}/.matriarch/review/../../../other-worktree/src/a.ts`), 'the traversal from the review is refused')
  })
})

describe('shell: the bypasses from the review are refused', () => {
  for (const cmd of [
    'git -C . push origin HEAD:feature/x',
    'git push',
    'git commit -am x',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api repos/o/r/pulls/12/reviews -f event=APPROVE',
    'gh pr merge 12',
    "sed -i 's/a/b/' src/a.rs",
    'echo hi > src/a.rs',
    'cat a >> ../worker/src/b.rs',
    'rm -rf target',
    'find . -name "*.rs" -delete',
    'echo $(git push)',
    'echo `git push`',
    'cat <<EOF > src/a.rs',
    'cargo build',
    'npm install',
    'python3 -c "open(1)"',
    'sleep 100 &'
  ]) {
    test(cmd, () => assert.ok(bash(cmd), `should refuse: ${cmd}`))
  }
})

describe('shell: what a reviewer really runs is allowed', () => {
  for (const cmd of [
    'git diff origin/main...HEAD',
    'git log --oneline origin/main..HEAD',
    'git -C . show HEAD:rust/crates/ctxmesh-init/src/product_install_v0.rs | head -40',
    'f=rust/crates/ctxmesh-init/src/product_install_v0.rs; grep -n "receipt-format compatibility is one-way\\|owner-approved clean root" "$f"',
    'ls .github/workflows; grep -n "linux\\|windows" .github/workflows/*.yml | grep -i "clippy\\|target:"',
    "sed -n '2500,2560p' src/lib.rs",
    'rg -n "fn write_install_receipt_atomic" rust/ 2>/dev/null',
    'gh pr view 51 --json files',
    'gh api repos/o/r/pulls/51/files',
    'mkdir -p .matriarch/review/abc',
    'cd rust && git status',
    "awk 'NR>=10 && NR<=20' src/lib.rs",
    'cat src/a.rs > .matriarch/review/abc/notes.json',
    'shasum -a 256 Cargo.lock',
    'sha256sum vendor/*.tar.gz | sort'
  ]) {
    test(cmd, () => assert.equal(bash(cmd), null, `should allow: ${cmd}`))
  }
})

describe('reading stays inside the review worktree', () => {
  for (const cmd of [
    'cat ../worker/src/a.rs',
    'cat /etc/hosts',
    'cat ~/.aws/credentials',
    'grep -rn key $HOME/.ssh',
    'head ${HOME}/.zshrc',
    'f=/etc/passwd; cat "$f"',
    'cat src/../../worker/a.rs',
    'git -C /other/repo log',
    'rg --file=/etc/hosts x src',
    'cat </etc/hosts',
    'cd src && cat ../../worker/a.rs',
    'cd .. && cat a.rs',
    'cd',
    'grep -e x /etc/hosts',
    'git grep -n x -- /etc'
  ]) {
    test(`refuses: ${cmd}`, () => assert.match(bash(cmd)?.deny ?? '', /read only this worktree|read-only/))
  }
  test('an absolute path inside the worktree, /dev/null and revision ranges are fine', () => {
    assert.equal(bash(`cat ${root}/src/a.rs`), null)
    assert.equal(bash('git diff origin/main...HEAD 2>/dev/null'), null)
    assert.equal(bash('git log --oneline origin/main..HEAD -- src/a.rs'), null)
    assert.equal(bash('git show HEAD~1:src/a.rs | head -40'), null)
  })
  test('a search pattern is not a path, and cd moves where relative paths start', () => {
    // From the live review of PR #51: Rust doc-comment patterns, after a cd into the crate.
    assert.equal(bash(`cd rust/crates/x/src && grep -n '/// Validation is structural\\|fn v1_receipt' product.rs ../tests/process.rs`), null)
    assert.equal(bash(`rg -n '/// Receipt' rust/`), null)
    assert.equal(bash(`git grep -n '../config' -- src`), null)
    assert.equal(bash(`awk -F/ '{print $1}' src/a.txt`), null)
  })
  test('the Read and search tools too', () => {
    const read = (tool: string, input: Record<string, string>) => reviewGuard({ tool, workspaceId: ws, input }, guard)
    assert.ok(read('Read', { file_path: '/Users/me/.aws/credentials' }))
    assert.ok(read('Grep', { pattern: 'key', path: '/Users/me' }))
    assert.equal(read('Read', { file_path: `${root}/src/a.rs` }), null)
    assert.equal(read('Grep', { pattern: 'fn', path: 'src' }), null)
  })
})

test('calls outside a review worktree are untouched, whatever they do', () => {
  assert.equal(reviewGuard({ tool: 'Bash', workspaceId: 'repo1::/wt/login', input: { command: 'git push' } }, guard), null)
  assert.equal(reviewGuard({ tool: 'Edit', workspaceId: null, input: { file_path: '/wt/login/src/a.ts' } }, guard), null)
  assert.ok(!isReadOnlyShell('git push', null))
})
