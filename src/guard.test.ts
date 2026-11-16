import { assert, describe, test } from 'orca/testing'
import { isOwnToolOutput, isReadOnlyShell, isVerdictFile, reviewGuard, type ClaudeHomes } from './guard.ts'

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

describe("a long tool output Claude Code kept for the agent can be read back", () => {
  // From the live advisor in /Users/me/orca/workspaces/seaway/advice-6f8ab3vpa7: Claude saves a
  // long output under its config folder (Orca gives each profile its own) and reads it back.
  const advice = '/Users/me/orca/workspaces/seaway/advice-6f8ab3vpa7'
  const homes: ClaudeHomes = { dirs: ['/Users/me/.claude'], profiles: '/Users/me/Library/Application Support/orca/claude-profiles' }
  const g = { ids: new Set<string>(), paths: [advice], claude: homes }
  const id = `repo1::${advice}`
  const session = '6cb6ddbe-12b1-4f21-8d1b-0bca3ae10fb5'
  const project = '-Users-me-orca-workspaces-seaway-advice-6f8ab3vpa7'
  const output = `${project}/${session}/tool-results/bmxv8iz5f.txt`
  const read = (file_path: string, tool = 'Read', over: Partial<typeof g> = {}) =>
    reviewGuard({ tool, workspaceId: id, input: tool === 'Read' ? { file_path } : { pattern: 'x', path: file_path } }, { ...g, ...over })

  test("its own session's file, in Claude's config folder or an Orca profile's", () => {
    assert.equal(read(`/Users/me/Library/Application Support/orca/claude-profiles/15b32dd8-0130-4a16-b65a-20af9e3764fc/home/projects/${output}`), null)
    assert.equal(read(`/Users/me/.claude/projects/${output}`), null)
    assert.ok(isOwnToolOutput(advice, `/Users/me/.claude/projects/${project}/${session}/tool-results/b.json`, homes))
  })

  test('nothing else there, and nothing that only looks like it', () => {
    for (const path of [
      `/Users/me/.claude/projects/-Users-me-orca-workspaces-seaway-login/${session}/tool-results/a.txt`, // another worktree's
      `/Users/me/.claude/projects/${project}/${session}.jsonl`, // the transcript
      `/Users/me/.claude/projects/${project}/${session}/tool-results/../../../../.ssh/id_ed25519`,
      `/Users/me/.claude/projects/${project}/${session}/tool-results/sub/a.txt`,
      `/Users/me/.claude/projects/${project}/not-a-session/tool-results/a.txt`,
      `/Users/me/.claude/projects/${project}/${session}/tool-results/.env`,
      `/Users/me/.claude/settings.json`,
      // The same shape outside Claude's config folders: a symlink planted there could lead anywhere.
      `/tmp/projects/${output}`,
      `/Users/me/orca/workspaces/seaway/login/projects/${output}`,
      `/Users/me/Library/Application Support/orca/claude-profiles/not-a-profile/home/projects/${output}`,
      `/Users/me/Library/Application Support/orca/claude-profiles/15b32dd8-0130-4a16-b65a-20af9e3764fc/projects/${output}`
    ]) {
      assert.ok(read(path), `refuses ${path}`)
    }
    assert.ok(!isOwnToolOutput(advice, `projects/${output}`, homes), 'a relative path is the worktree’s own')
    assert.ok(read(`/Users/me/.claude/projects/${output}`, 'Read', { claude: undefined }), 'no config folders known: refused')
    assert.ok(read(`/Users/me/.claude/projects/${project}/${session}/tool-results`, 'Grep'), 'only Read: no searching the folder')
    assert.ok(bash(`cat /Users/me/.claude/projects/-wt-review-12/${session}/tool-results/a.txt`), 'nor reading it from the shell')
  })

  test('a worktree path over 200 characters, which Claude cuts and hashes', () => {
    const deep = `/Users/me/${'nested-folder/'.repeat(16)}review-51-abc1234-x`
    const key = deep.replace(/[^A-Za-z0-9]/g, '-')
    assert.ok(key.length > 200)
    const file = (name: string) => `/Users/me/.claude/projects/${name}/${session}/tool-results/a.txt`
    assert.ok(isOwnToolOutput(deep, file(`${key.slice(0, 200)}-1x9z0k`), homes))
    assert.ok(!isOwnToolOutput(deep, file(key), homes), 'not the uncut name: Claude never writes it')
    assert.ok(!isOwnToolOutput(deep, file(`${key.slice(0, 200)}-../x`), homes))
  })
})

describe('reads with ~ or a padded path are refused, as Claude expands them', () => {
  // Claude trims a path and expands a leading ~; resolving them as given would place them inside.
  const read = (tool: string, input: Record<string, string>) => reviewGuard({ tool, workspaceId: ws, input }, guard)
  test('the Read, Grep and Glob tools', () => {
    assert.ok(read('Read', { file_path: '~/.ssh/id_ed25519' }))
    assert.ok(read('Read', { file_path: ' /Users/me/.ssh/id_ed25519' }))
    assert.ok(read('Grep', { pattern: 'key', path: '~' }))
    assert.ok(read('Glob', { pattern: '/Users/me/.ssh/*' }))
    assert.ok(read('Glob', { pattern: '~/.ssh/*' }))
    assert.ok(read('Glob', { pattern: '../worker/**/*.rs' }))
    assert.equal(read('Glob', { pattern: 'src/**/*.rs' }), null)
    assert.equal(read('Read', { file_path: ` ${root}/src/a.rs ` }), null, 'padding alone is fine inside')
  })
})

describe('shell: >& writes to a file unless it copies a stream', () => {
  // bash and zsh write both streams to the file after >& (zsh >>& appends); the guard took it as
  // a stream and let it through.
  for (const cmd of ['cat a >&/Users/me/.zshrc', 'cat a >>&/Users/me/.zshrc', 'grep -r x . >&/Users/me/.ssh/authorized_keys', 'cat a >& out.txt', 'cat a >&out', 'ls >|out.txt', 'ls >& 2x']) {
    test(`refuses: ${cmd}`, () => assert.ok(bash(cmd), cmd))
  }
  test('copying, closing or moving a stream is fine', () => {
    for (const cmd of ['git log 2>&1 | head', 'ls >&2', 'ls 2>&-', 'git diff 2>& 1', 'ls 2>&1 >/dev/null', 'ls 2>&1-', '2>/dev/null git log']) assert.equal(bash(cmd), null, cmd)
  })
})

describe('shell: a second redirect glued onto the verdict file is a redirect of its own', () => {
  // Seen in review: the target ran on to the next `>`, so `x.json>../../out.json` folded into a
  // verdict path; the shell writes both files, the second outside the worktree.
  for (const cmd of [
    'cat a >.matriarch/review/x.json>../../out.json',
    'cat a >.matriarch/review/x.json>/elsewhere/out.json',
    'cat a >".matriarch/review/x.json">../../out.json',
    'cat a >>.matriarch/review/x.json>>../../out.json',
    'cat a 2>.matriarch/review/x.json>../../out.json',
    'cat a >.matriarch/review/x.json<>../../out.json',
    'cat a >".matriarch/review/x".json',
    'cat a >>|out.txt'
  ]) {
    test(`refuses: ${cmd}`, () => assert.ok(bash(cmd), cmd))
  }
  test('the verdict file alone, quoted or not, is fine', () => {
    for (const cmd of ['cat a >.matriarch/review/x.json', 'cat a > ".matriarch/review/x.json"', "cat a >'.matriarch/review/x.json' 2>/dev/null"]) assert.equal(bash(cmd), null, cmd)
  })
  test('a refused redirect says where output may go', () => {
    assert.match(bash('cat a >>|out.txt')?.deny ?? '', /the redirect to `out.txt` was refused: output may go only to the JSON file your brief names/)
  })
})

describe('a refusal names what was refused', () => {
  test('the part of the command, so the rest can run without it', () => {
    // From the live advisor: it sent this twice, refused whole each time.
    const deny = bash('grep -c x Cargo.lock; echo; buf --version 2>&1 | head -1; just --version')?.deny ?? ''
    assert.match(deny, /`buf --version` was refused/)
    assert.match(deny, /Run the rest without it/)
    assert.match(bash('cat src/a.rs > notes.txt')?.deny ?? '', /the redirect to `notes.txt` was refused/)
    assert.match(bash('ls >| notes.txt')?.deny ?? '', /the redirect to `notes.txt` was refused/)
    assert.match(bash('echo $(git push)')?.deny ?? '', /could not tell what this command runs/)
    assert.match(bash('tail -n 5 log.txt | xargs rm')?.deny ?? '', /`xargs rm` was refused/)
    assert.match(bash('rm x 2>/dev/null')?.deny ?? '', /`rm x` was refused/, 'the stream number is not shown as an argument')
    assert.match(bash('git log --output=x')?.deny ?? '', /`git log --output=x` was refused, as Matriarch could not tell that it only reads \(an option that writes a file/)
  })
  test('git check-ignore only reads, so it runs', () => {
    assert.equal(bash('git check-ignore -v .matriarch/review/advice-1/answer.json'), null)
    assert.equal(bash('git log --all --oneline -- .github | head; git branch -a | head -20; ls .matriarch 2>/dev/null'), null)
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
