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

describe('shell: glab writes from a review are refused', () => {
  for (const cmd of [
    'glab mr merge 12',
    'glab mr merge',
    'glab mr note 12 -m "looks good"',
    'glab mr approve 12',
    'glab mr update 12 --ready',
    'glab mr rebase 12',
    'glab mr checkout 12',
    'glab ci retry 4711',
    'glab ci run',
    'glab ci view',
    'glab api -X PUT projects/g%2Fp/merge_requests/12/merge',
    'glab api projects/g%2Fp/merge_requests/12/notes -f body=x',
    "glab api graphql -f query='mutation { x }'",
    'glab constructor x'
  ]) {
    test(cmd, () => assert.ok(bash(cmd), `should refuse: ${cmd}`))
  }
})

describe('shell: what a reviewer reads with glab is allowed', () => {
  for (const cmd of [
    'glab mr view 12',
    'glab mr view 12 --comments -F json',
    'glab mr diff 12',
    'glab ci status',
    'glab ci trace 4711',
    'glab api projects/g%2Fp/merge_requests/12/changes',
    'glab api --hostname gitlab.example.com projects/g%2Fp/merge_requests/12/discussions'
  ]) {
    test(cmd, () => assert.equal(bash(cmd), null, `should allow: ${cmd}`))
  }
})

describe('shell: flags and forms that run a program or write a file are refused', () => {
  for (const cmd of [
    // A flag that runs a program, on a tool that only reads otherwise.
    "rg --pre sh zzz .matriarch/review/x.json",
    'rg --pre=sh x .',
    "rg --pre-glob '*.json' --pre sh x",
    'rg --hostname-bin=./x.json x',
    "git grep -O'touch PWNED; echo ran' needle",
    'git grep -iOsh needle',
    'git grep --open-files-in-pager=sh needle',
    'git grep --open-f=sh needle',
    'fd -x sh {}',
    'fd -HX sh',
    'fd --exec-batch sh',
    "bat --pager 'sh -c id' a.rs",
    'ag --pager=sh x',
    'ag --pag=sh x',
    'sort --compress-program=sh a.txt',
    'sort -o src/a.rs a.txt',
    'sort -ro src/a.rs a.txt',
    'tree -o src/a.rs',
    'file -C -m x.json',
    'yq -i .a=1 a.yml',
    'uniq a.txt src/a.rs',
    'xxd -r a.hex src/a.rs',
    'less a.rs',
    "sed -n '1e touch PWNED' a.rs",
    "sed 's/a/b/e' a.rs",
    "sed -n 'r /etc/hosts' a.rs",
    'sed -f .matriarch/review/x.json a.rs',
    `awk '{ "date" | getline d; print d }' a.rs`,
    `awk 'BEGIN { while ((getline line < "a") > 0) print line }'`,
    // git: config that runs a program, and --output by any shortening.
    'git -c core.fsmonitor=sh status',
    'git --git-dir=.matriarch/review/x status',
    'git log --outp=src/a.rs -1',
    'git log --out=src/a.rs',
    // Forms that make a word other than it reads.
    'git log --out\\put=src/a.rs -1',
    "rg $'--pre' sh x",
    'rg --p{re,} sh x',
    'P=--pre; rg $P sh x',
    'o=--output=src/a.rs; git log "$o" -1',
    // The environment of a command, and environment variables.
    "LESSOPEN='|sh -c id %s' cat a",
    'GIT_EXTERNAL_DIFF=sh git diff',
    'GIT_CONFIG_COUNT=1; git status',
    'PATH=.matriarch/review; ls'
  ]) {
    test(cmd, () => assert.ok(bash(cmd), `should refuse: ${cmd}`))
  }
})

describe('shell: the same tools, only reading, still work', () => {
  for (const cmd of [
    'rg -n "fn main" src',
    'rg --files src',
    'git grep -n needle -- src',
    'git log --oneline -5',
    'git log --format=%h -1',
    'fd -e rs src',
    'sort a.txt | uniq -c',
    'tree -L 2 src',
    'file src/a.rs',
    "sed -n '10,40p' src/a.rs",
    "sed -n '/fn main/,/^}/p' src/a.rs",
    "sed '1d;$d' a.txt",
    `awk -F'|' '{print $2}' docs/a.md`,
    "awk 'NR>=10 && NR<=20' src/a.rs",
    'f=src/a.rs; head -20 "$f"'
  ]) {
    test(cmd, () => assert.equal(bash(cmd), null, `should allow: ${cmd}`))
  }
})
