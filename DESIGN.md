# Matriarch: design

An orca pod is led by its matriarch. This plugin is the supervisor for a pod of coding
agents in Orca:

- a **supervisor** agent plans and delegates, and can ask an **advisor** for a second opinion;
- **workers** build each piece in their own worktree and open PRs;
- a **review crew** of several reviewers, each on its own provider and model, reviews every PR;
- a deterministic **engine** drives every PR through CI, review, fixes, conflicts and merge, on
  GitHub or GitLab (gitlab.com or self-hosted), where a PR is a merge request.

It can run unattended.

Status: the engine, timeline, review crew and supervisor have run on a real project (see
[Tuned after the first long run](#tuned-after-the-first-long-run-on-a-real-project-2026-11-12)).
What came after that run (stacked PRs, flaky re-runs, light review, the activity log, away
alerts, worker limits, issues as objectives and the advisor) is built and tested offline only.
See [Roadmap](#roadmap).

## Goals

1. Each role (supervisor, worker tiers, every reviewer, arbiter, advisor) picks its own agent,
   model and thinking level.
2. Several reviewers run on every PR, and their verdicts are combined by a policy.
3. CI failures, review comments and conflicts go back to the worker that owns the branch,
   with no human in the loop, up to a round limit.
4. Merging is either manual (stop at *Ready to merge*) or automatic. In automatic mode the
   supervisor handles what the engine cannot settle: repeated failures, conflicts across PRs,
   a red base branch.
5. Nothing is irreversible without a guard: dry run by default, per-repo opt-in, merges
   checked against the reviewed commit, never bypassing branch protection.

## How it improves on orchestrator.inc

These gaps were verified in its source (commit `fbc1a8e5`); each row says what Matriarch does instead.

| orchestrator.inc | Matriarch |
|---|---|
| Only `reviewers[0]` runs automatically; verdicts are never combined | Every configured reviewer runs; a pass policy combines them; an optional arbiter settles disagreements |
| Reviewer prompt is hard-coded | Each reviewer has a `focus`, so you can run specialists (security, tests, ...) |
| Reviewer works in the worker's live worktree | Reviewers work in a throwaway worktree pinned to the reviewed commit |
| Reviewer sandboxed by its agent's own flags | The same, set at launch by a hook (Claude `dontAsk` + allowlist, Codex sandbox without network), each launch confirmed and stopped if not locked down, plus a tool guard for Claude |
| Polls GitHub every 30 s with ETag checks on the PR list and check runs | Conditional HEAD probes of the newest PR update, the default branch and each followed PR's checks; GraphQL only on a change (or every 5 min); an idle poll costs no rate limit |
| Auto-review runs on red builds | Reviews start once CI is green (configurable) |
| CI fixes retry forever; nothing escalates | Round caps per category, then escalation: worker, then supervisor, then human |
| One message per review comment | One combined message per round |
| A message held back while the worker waits for input is never resent | The planner reads current state on every tick, so held messages go out when the worker is free |
| No automatic merge | Manual or automatic, with a merge train, branch updates, conflict handling and protected paths |

## Roles and config

Each repository opts in by committing `.orca/matriarch.json`. Orca's plugin settings only hold
simple values, so the role setup lives in the repo and is versioned with it. Settings in the
panel writes this file; nobody has to edit it by hand. An example with every field (the models
and the tier are examples):

```jsonc
{
  "version": 1,
  // Optional: only when the origin does not say (see Forges). "host" defaults to the origin's.
  "forge": { "kind": "gitlab", "host": "gitlab.example.com" },
  "supervisor": { "agent": "claude", "model": "claude-opus-5-5", "effort": "high" },
  "workers": {
    "default": { "agent": "codex", "model": "gpt-6-astra", "effort": "high" },
    "tiers": { "small": { "agent": "claude", "model": "claude-sonnet-5-5" } }
  },
  "reviewers": [
    { "name": "correctness", "agent": "claude", "model": "claude-opus-5-5", "focus": "bugs, edge cases, missing tests", "blocking": true },
    { "name": "security", "agent": "codex", "model": "gpt-6-astra", "focus": "authz, injection, secrets, unsafe input", "blocking": true }
  ],
  "arbiter": null,
  // A second opinion the supervisor can ask for (see Advisor). Read-only like a reviewer.
  "advisor": { "agent": "claude", "model": "claude-fable-5-2", "effort": "max" },
  "review": { "enabled": true, "trigger": "ci-green", "pass": "all-blocking-approve", "blockAt": "major",
              "differentProviderThanAuthor": true, "maxRounds": 3, "publish": "github", // "github": on the PR, GitLab too
              "followUp": "focused", "fallback": null,
              // A PR changing only these files gets "one" reviewer or "none" (see Review crew).
              "light": { "paths": ["**/*.md", "**/*.rst", "**/*.adoc"], "crew": "one" } },
  "fix": { "ci": { "enabled": true, "maxRounds": 3, "rerunFlaky": true }, "comments": { "enabled": true, "maxRounds": 3 },
           "conflicts": { "enabled": true, "maxRounds": 2 } },
  "merge": { "mode": "manual", "method": "squash", "requireHuman": [], "updateBranch": "rebase",
             "onBaseRed": "pause", "deleteBranch": true, "removeWorktree": true, "removeFinishedWorktrees": true },
  "escalation": { "supervisorFirst": true, "humanAfterMinutes": 30 },
  // maxWorkers and maxWorkerStartsPerDay: 0 for no cap; minFreeDiskGB: 0 for no floor.
  "limits": { "maxConcurrentReviews": 2, "maxWorkers": 4, "maxWorkerStartsPerDay": 0, "minFreeDiskGB": 10 },
  // Labeled issues become the supervisor's objectives (see Supervisor).
  "issues": { "enabled": false, "label": "matriarch", "comment": false }
}
```

The defaults (`defaultConfig` in `src/config.ts`) name no model, so each agent runs its own
default until one is picked in Settings: a Claude supervisor, a Codex worker, the two reviewers
above (correctness on Claude, security on Codex), no tiers, no arbiter and **no advisor**
(`null`). Every other field is as shown.

`model` reaches the agent through `--model` for Claude, Codex, Cursor, Antigravity, Grok and
Muse (Orca 1.4.255). Any other agent runs its default model, and the config check warns about it.

Reviewers and the advisor are read-only. Claude and Codex are locked down by their own agent (see
Review crew). Matriarch cannot lock down any other agent, so such a reviewer or advisor is not
started unless it has `"readOnly": false`. With that set, it runs with your usual permissions for
that agent in the throwaway worktree.

## Architecture

```
            ┌─────────────── Orca desktop ───────────────┐
 you ──▶ Matriarch panel ──▶ engine (plugin worker, always on via status bar item)
            │            │      ├─ forge per project: GitHub (ETag probes; GraphQL list + detail
            │            │      │   on change) or GitLab (GraphQL list each tick; detail on change)
            │            │      ├─ owner index: PR branch → workspace → orchestration dispatch
            │            │      ├─ planner (pure): lane + next actions per PR
            │            │      ├─ ledger + history (plugin storage): what was done and why
            │            │      ├─ executor: orca CLI / gh or glab CLI / notifications / webhook
            │            │      └─ per project: labeled issues, worker limits, the advisor
            │            ▼
            │     supervisor agent ── orca orchestration worker-start ──▶ workers (own worktrees)
            │       ▲        │                                                  │ push + PR
            │       │        └─ "Advice:" mail ─▶ mailbox ─▶ advisor (read-only worktree)
            │       └── escalations, issues, answers (send --to run:<id>) ◀── engine ◀──┘
            └── review crew: throwaway worktree per PR head, one agent per reviewer
```

- **Engine.** A `trusted-worker` plugin. A contributed status bar item keeps its worker
  running. All its state lives in `orca.storage` (and the webhook URL in `orca.secrets`), so
  restarts and reloads lose nothing. It never calls an LLM.
- **Supervisor.** An Orca agent started on its own provider and model with a generated brief:
  the role map, exact `worker-start` command templates per tier, the PR contract below, the
  limits, and how to ask the advisor. It owns the orchestration Run. The engine raises judgment
  calls with it through `orca orchestration send --to run:<runId>`.
- **Workers.** Supervised Orca orchestration workers. A worker must push its branch, open a PR
  that carries the `Matriarch-Task: <taskId>` trailer, and report `worker_done` with the PR
  URL. The brief has the supervisor end every task spec with this contract.
- **Mailbox.** Orca accepts a message only from a terminal, so Matriarch keeps one of its own in
  each project ("Matriarch mailbox", `cat > /dev/null`). It sends everything from it, and the
  supervisor sends the advisor's questions to it.
- **Feedback.** `orca orchestration send --to dispatch:<id>` works from outside any Run, and a
  finished worker gets the message as a follow-up task.

## PR lifecycle

The planner (`src/plan.ts`) is pure. On each tick it reads the PR snapshot, the owning worker's
activity, the ledger and the config, and returns a lane, a reason and the next actions. It
evaluates in this order:

1. merged / closed / draft
2. merge already requested for this commit → `merging`
3. stacked on a PR that merged, still pointing at its branch → `retarget` to where it merged
4. worker active → `working` (never interrupt a turn)
5. worker waiting for input → `needs-you`, escalated to the supervisor first
6. stacked on a PR that merged, the branch not pushed since, and the base without the commit it
   was built on → its owner is asked once to rebase off the parent's commits → `fixing-conflict`
7. CI failing (after every check finished) → a job that looks like the infrastructure failing is
   re-run once on that commit (`awaiting-ci`); the rest, a check failing again, and a re-run the
   forge refused → `fixing-ci`
8. merge conflict → `fixing-conflict`
9. unresolved human or bot review threads, or a human "changes requested" → `fixing-review`
10. CI pending or cancelled → `awaiting-ci`
11. AI review on this commit: not started → start; running → `ai-review`; changes requested → `fixing-review`
12. merge gate → `ready` (manual), or `merging` (auto, one merge at a time per base branch)

### Stacked PRs

A PR is stacked when its base is the head branch of another open PR that Matriarch follows (from
an Orca worktree, opened by you) and that can be a parent: a PR from a short-lived branch of this
repository into another branch. These are never parents, so PRs into their branch merge there as
they ask:

- a PR from the default branch (git flow's develop → main release PR);
- a PR from a branch named like a long-lived one: main, master, trunk, develop, dev, staging,
  production, prod, stable, next, release, `release/*`, `release-*`, `releases/*`, or a version
  (`v2`, `1.x`, `2.3.4`);
- a fork's PR (GitHub's `isCrossRepository`, or a GitLab source project other than the target);
- a PR into its own head branch;
- a PR Matriarch does not follow: someone else's, or one with no worktree here.

While the parent is open, the child goes through CI, comments and review as usual, and waits at
the merge gate (`ready`, "stacked on #n"), in both merge modes, with no ready notification. A
parent that closes without merging puts the child in `needs-you`.

The ledger keeps the parent, so the PR stays stacked after the parent leaves the board, and a
parent that left the open list is read once to learn whether it merged. It also keeps the fork
point: the parent's head when the PR was first seen on it, which stays put as the parent moves
on (rebased off its own parent, amended).

When the parent merged:

- a child the forge left on the parent's branch is moved to where the parent merged (`gh pr edit
  --base`, GitLab's `target_branch`);
- the forge is asked once whether that base has the fork point (GitHub's compare, GitLab's merge
  base). After a merge commit or a fast-forward it does, and the child goes on without a rebase;
- otherwise its owner (or the supervisor, when the worker finished) is asked once to run
  `git fetch origin && git rebase --onto origin/<base> <fork point> && git push --force-with-lease`.
  Starting at the fork point, a three-deep stack, A ← B ← C, rebases C off the B it was built on.
  The child merges only after that push; a branch that has not moved an hour later is escalated.

When the forge lists more open PRs than Matriarch reads (four pages), a PR into a branch with an
Orca worktree here may be stacked on one left out: it waits for you instead of merging.

### Flaky checks

`src/flaky.ts`, with `fix.ci.rerunFlaky` (on by default). Once per failed check and commit, the
engine reads what the forge kept of the failure: a GitHub check's failure-level annotations and
log tail, a GitLab job's `failure_reason` and log. A failure is flaky when a line matches one of a
short list of signs, each the error line its tool prints, at the start of the line: a GitHub
runner that went away, GitLab's own failure reasons around a job (`runner_system_failure`,
`stuck_or_timeout_failure`, `api_failure`, `scheduler_failure`, `data_integrity_failure`), npm,
pnpm, yarn or git unable to reach their server, a container registry turning a pull away, and
Docker Hub's or GitHub's API rate limit. A test's own output (its name, an assertion, a status the
app under test answered) and a warning about something that recovered never match: a wrong
"flaky" costs a CI cycle, so the list stays short.

- **Once.** A flaky check is re-run once on that commit. A second failure goes to the worker, and
  so does a re-run the forge refuses, recorded with its error.
- **Starting again.** A re-run is recorded with the failed attempt's job id. Until the forge shows
  a new attempt (a new job id), or for ten minutes, the old failure is the job starting again,
  not failing again.
- **Which checks.** Only a GitHub Actions job (its check suite's app is `github-actions`) or a
  GitLab job can be read or re-run; a check another app posts is not the forge's to re-run.
  Several flaky jobs of one GitHub workflow run re-run together (`rerun-failed-jobs`), since
  GitHub refuses a second job's re-run while the run is going again; that re-runs the run's other
  failed jobs as well.
- **Mixed failures.** When one check failed for real and another looks flaky, the flaky one runs
  again first, and the real failure goes to the worker once that re-run finished.
- A failure the forge said nothing about (no log, the read failed, past the first few) counts as
  real, so nothing is read again on every tick.

### Fix rounds and escalation

The ledger keys every action by commit: CI by commit plus the set of failing checks; conflicts
by commit; comments by commit plus thread IDs. Each new commit with the same problem uses one
round. When `maxRounds` is used up the PR escalates:

1. **Worker** gets up to `maxRounds` rounds.
2. **Supervisor** (when `supervisorFirst` is set and a Run is known) gets one escalation per
   problem and commit. It can re-plan, spawn a fixer on a stronger tier, resolve the conflict
   itself, or split the PR.
3. **Human**: if nothing changes within `humanAfterMinutes`, Matriarch sends a desktop
   notification and puts the PR in `needs-you`.

## Review crew (phase 3, built)

Code: `src/crew.ts` (rounds), `src/review.ts` (brief, verdicts, aggregation), `src/lockdown.ts`
and `src/guard.ts`. Rounds start from the planner when autopilot is on, or on demand. On-demand
starts come from the card's **Run AI review now** button or the `review.start` request, and run
in dry run too. Sending findings to a worker and posting to GitHub still wait for autopilot.

- **Trigger.** A new head commit, worker not active, CI green (or `trigger: "pr-open"`), fewer
  than `maxRounds` rounds, and a review slot free.
- **Placement.** One throwaway worktree per PR head (`orca worktree create --base-branch
  origin/<head>`). Each reviewer is started with `orca agent launch --agent --model --effort`.
  The worktree is removed afterwards.
- **Lockdown** (`src/lockdown.ts`). Reviewers start in their own agent's restricted mode: the
  `agent.launch.before` hook rewrites any launch inside a review worktree, swapping your Orca
  permission choice for:
  - **Claude:** `--permission-mode dontAsk`, an allowlist (read the worktree, read-only git,
    `cat`/`grep`/`ls`, write only `.matriarch/review/**`) and a denylist (push, commit,
    reset, merge, `gh` and `glab` writes, `gh api`, `glab api`, `rm`, web). The denylist also
    refuses any command that reaches outside the worktree: absolute paths (quoted or not, after
    `=` or `<`), `~`, `$HOME`, and `..` out of it. So a reviewer cannot read your files into a
    verdict that gets posted. Also `--setting-sources user`, so a PR's own
    `.claude/settings.json` cannot widen it while Orca's hooks (in your user settings) still
    run, and `--strict-mcp-config`, so no MCP tools. Anything else is refused without a prompt.
  - **Codex:** `--sandbox workspace-write --ask-for-approval never`, with network off, no extra
    writable folders (not even `/tmp`) and no MCP servers. Writes outside the worktree,
    commits (the git dir is outside it) and network calls fail.
  - Other agents are refused, unless the reviewer has `"readOnly": false`: then it runs with
    your usual permissions in the throwaway worktree (a config warning says so).
  - After each launch the crew checks the hook really rewrote it. A reviewer started without
    the lockdown (the hook timed out, say) has its terminal closed and counts as failed.
  - The `agent.tool.before` guard stays on as a second layer for Claude: an allowlist of
    read-only commands, writes only to the verdict file, and reads only inside the worktree. It
    resolves real paths: it follows `cd`, and it skips search patterns (a `'/// doc'` grep
    pattern is not an absolute path).
  - Neither layer allows a flag that runs a program or writes a file (`rg --pre`, `git grep -O`,
    `fd -x`, `sort -o`, `git -c`, sed's `e` and `w`, awk's pipes), and the guard refuses what
    could disguise one: an escape or `$'…'` quoting, `{a,b}` expansion, a `$VAR` given to such a
    tool, environment variables, and git's shortened long options. Claude's allowlist leaves out
    `rg` and `git grep` altogether, since a rule there is a prefix; its Grep tool searches instead.
    This matters because `--setting-sources user` keeps your own allow rules, which the guard
    is then the only check on.
  - Codex's sandbox can read outside the worktree; it has no network, so its only output is the
    verdict.
- **Output.** Each reviewer writes `.matriarch/review/<sha>/<name>.json`:
  `{ verdict: "approve"|"request_changes", summary, findings: [{ severity, file, line, title, detail, suggestion }] }`.
  A missing or invalid file counts as a failed reviewer. **Run AI review now** runs the round
  again; there is no automatic retry.
- **Aggregation.**
  - Overlapping findings are merged (same file, nearby lines, similar titles).
  - `pass` decides the outcome:
    - `all-blocking-approve`: every blocking reviewer approves and nothing is at or above `blockAt`;
    - `majority`: more than half of the whole crew approves (silence is not a vote);
    - `no-blockers`: nothing at or above `blockAt`, with more than half the crew answering.
  - An optional `arbiter` gets every review and returns the final list (drops false
    positives, settles disagreements).
- **Cross-provider rule.** With `differentProviderThanAuthor`, reviewers on the author's agent
  are skipped, unless that would leave no reviewer.
- **Light changes** (`review.light`). A PR gets a lighter review when every changed file matches
  `paths`, none is in `ALWAYS_FULL_REVIEW` (what steers an agent once merged: `AGENTS.md`,
  `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `*.prompt.md`, `.github/**`, `.claude/**`, `.orca/**` and
  the other agents' folders, in `src/config.ts`; matched without regard to case, since on a
  case-insensitive disk `claude.md` is `CLAUDE.md`), no file was renamed or copied, no old path falls outside `paths`, and the
  file list is whole. Then `crew: "one"` runs only the first blocking reviewer left after the
  cross-provider rule, and `"none"` skips the AI review (the merge reason says so).
  - GitLab's diff stats do not mark renames, so for a merge request that would be light the
    REST diffs are read (`…/diffs`, or `…/changes` before GitLab 15.7), once per head commit,
    kept as `moves:<repo>#<n>`. A failed or partial read keeps the full crew and is tried again
    after 10 minutes.
  - A round already on the commit (running, or asking for changes) still decides, and **Run AI
    review now** runs the full crew.
- **Publishing** (`publish`).
  - `github` (recommended; the name predates GitLab and means "on the PR"): one combined comment
    review per round, with inline comments for findings at or above `blockAt`. On GitLab, one
    merge request note with those findings folded in. Each carries a `<!-- matriarch:... -->`
    marker so the engine can tell its own threads from human ones. It posts as you, so it can
    only be a comment review, never approve or request changes; orchestrator.inc has the same
    limit.
  - `orca-only`: findings stay in the panel and the worker message.
- **Re-review.** The next round gets the earlier findings plus the diff since the last reviewed
  commit, and checks that each finding was fixed.

## Supervisor (phase 4, built)

`src/supervisor.ts`, and **Open supervisor chat** per repository in the panel.

- **Launch.** The supervisor is a conversation, so it opens as a native Orca chat; if the agent
  has no chat surface, as a terminal session. It uses the configured agent, model and thinking
  level, in the repository's main checkout, and starts with a brief that tells it to:
  - ask what to build;
  - propose a plan: the tasks, which files each touches, the tier for each;
  - start workers only after the user agrees (a labeled issue counts as agreed: see below).

  The brief also contains:
  - the Run to create, tagged `[matriarch:<repo>:<nonce>]`;
  - the exact `worker-start` command per tier, and the project's worker limits;
  - the PR contract every task spec must end with;
  - with an advisor set, when and how to ask it;
  - the instruction to leave reviews and merges to Matriarch.

  Saving new worker settings or limits mails a running supervisor the new ones.
- **Escalations.** Matriarch finds the Run by its tag (`orchestration run-list`). Escalations then
  go to `run:<id>`, which wakes the supervisor.
- **A first run** should be on a task you choose: its workers push branches and open PRs.

### Worker limits

`src/limits.ts`. The supervisor starts workers itself, so Matriarch holds it to
`limits.maxWorkers`, `maxWorkerStartsPerDay` and `minFreeDiskGB`. The brief states them, and
saving new ones in Settings tells a running supervisor. Then two layers hold them. They keep cost
and disk in hand; they are not a security boundary.

**Before a start.** The `agent.tool.before` hook refuses a Bash call that starts a worker over a
limit, with what to do instead. It judges only calls from the supervisor's terminal or one of its
Run's workers' terminals (the event's terminal handle, matched against the handles in the Run's
worker list), so the person's own sessions are never judged. Reading the command, it fails
closed: quotes, escapes and line continuations are dropped, and every `orchestration` followed
(past flags and their values) by `worker-start`, `dispatch` or a word the shell would expand
counts as a start, whatever the command word (`orca`, `orca-ide`, `$ORCA_CLI_COMMAND`, a path),
as does every `agent launch`. A call with several starts counts each; one with a loop (`for`,
`while`, `xargs`, a function) is refused while a count limit is set.

The hook gets 2 seconds and may not await, so each tick hands it the counts: running workers of
the supervisor's Run, workers first seen today, free disk, and when the worker list was asked
for. It adds the starts it let through since, and drops one once a list asked for more than 30
seconds after it would show its worker. The counts are kept in plugin storage, so a restart or a
failed tick does not reset them. Running means not settled and not seen exited: a worker Orca
cannot vouch for (`unverifiable`: just started, restored after a restart, stale) counts.

**After a start.** Orca waits on that hook only for Claude Code (other agents' calls are only
reported), and an agent in a chat reports no tool calls at all (see [Orca sources
read](#orca-sources-read)), so the hook never sees a supervisor in a chat, which is the default.
For that and every other agent, the limits hold right after a start instead. Each tick judges the
workers first seen in the Run's list in the order they started, as the hook would have
(`overLimitStarts`). Under autopilot it stops each one that had no room (`orchestration
worker-stop`, which fences the dispatch; `stop_unknown` counts as stopped), notes it in the
worktree's activity log, and tells the supervisor which, why, and when to start it again. For the
rest of that tick the stopped worker owns nothing, so a message for its PR goes to the
supervisor. Its worktree is kept for the task (`stopped:<repo>`): the finished-worktree cleanup
skips it until a newer worker has run there, or for a week. A stopped worker takes no room, and its start does not count against the day. A stop that
fails is tried again while the worker runs, for 10 minutes. In dry run the board says what it
would stop.

**Counting.** A worker counts as started when Matriarch first sees it in its Run's list. Only a
start is judged: the workers already there when Matriarch first looks at a Run, or when a limit is
lowered, are neither stopped nor counted, and Needs you says the project is over. A Run linked
after it started workers undercounts them, since Orca's worker list gives no start time.

**What Orca lacks.** A hook before an orchestration start would let Matriarch refuse every agent's
start instead of stopping it ([docs/orca-api-requests.md](docs/orca-api-requests.md)).
`agent.launch.before` cannot stand in: Orca 1.4.257 gives it the agent, the workspace, a
pre-allocated terminal handle and the command, with no dispatch or task id, so a worker's launch
looks like any other.

### Issues as objectives

`src/issues.ts`, with `issues.enabled`. What a user needs to know is in the README's
[Issues as objectives](README.md#issues-as-objectives); this is how it works.

- **Reading.** The open issues carrying `issues.label` are read every 5 minutes (a minute when an
  issue waits only for a supervisor or autopilot to come back), over REST, in pages of 100 up to
  500, oldest first. GitHub lists PRs among issues; they take places on its pages and are
  dropped after. The board says when more carry the label. A change of the configured label
  reads at once.
- **The label check.** Each new or changed issue not handed over yet is checked, at most 10 per
  read:
  - GitHub: one GraphQL read of its newest `LabeledEvent`s and `RenamedTitleEvent`s and its
    `lastEditedAt`, then `collaborators/<actor>/permission` (role triage, write, maintain or
    admin, or permission write or admin). A `Bot` actor never passes.
  - GitLab: `resource_label_events` (the newest `add`), the member's `members/all/<id>` access
    level (20, Reporter, and up), and GraphQL `lastEditedAt` (title and description edits). A bot
    user never passes: an access token's (`project_<id>_bot_…`, `group_<id>_bot_…`) or one of
    GitLab's own (`…-bot`) by its username, and any other by `bot` on its `users/<id>` record
    (when that record is hidden, the username decides).

  It passes only when the latest label was added by such a person and nothing was edited after
  it; otherwise it waits on the board with the reason until the label is added again. Checks are
  kept by the issue's `updated_at`; one that could not be made is asked again next read.
- **Handing over.** Under autopilot, up to 5 passing issues a tick go to the running supervisor,
  each as plain mail titled "New objective: <repo>#<n>" and a cleaned, short title. The title and
  body go inside a fence longer than any run of `~` in them, marked as the issue's text, not the
  user's or Matriarch's. The mail says the label is the go-ahead and asks for `Closes #<n>`. With
  `issues.comment`, one comment follows on the issue, as the signed-in person.
- **Once.** A handoff is tied to the time of the label event that passed the check, and recorded
  in its own key (`issue:<repo>#<n>`) before the message is sent. An issue whose record names the
  same label event is never sent again, so a failed save cannot hand one over twice; adding the
  label again is a new event and a new handoff. A send that fails clears the record so it is
  tried again; if even that write fails, the record stays "sending" and the board shows the
  handoff as unsure, never resending it by itself.
- **Storage.** Only numbers, times and short reasons are kept, never an issue's text (bodies are
  cut to 6000 characters as they are read). A storage failure only leaves an issue waiting, and
  never stops the tick.
- With no supervisor running, Needs you says the issues wait; in dry run the board says it would
  hand them over. A label with a comma, over 100 characters, or named `any`, `none` or `no label`
  (filters on GitLab) is refused.

### Advisor

`src/advisor.ts`. An optional role above the supervisor (`advisor` in the config), on its own
agent, model and thinking level, that the supervisor asks for a second opinion. It sees only what
the supervisor chooses to ask.

- **Asking.** With an advisor set, the brief tells the supervisor when to ask (a risky plan, a
  reviewer and a worker disagreeing, being stuck, a step that is hard to undo) and the command:
  `orca orchestration send --to <Matriarch's mailbox> --subject 'Advice: …' --body '<context>'`.
  Once Orca says the mailbox is gone (closed, or lost in a restart), Matriarch drops it and makes
  a new one. It records what each supervisor was told (its Run, the address, the advisor) and
  mails it again when any of these change, or when the advisor is turned off. A supervisor whose
  sender Matriarch cannot name (a chat opened by hand) is not told at all, since every question
  it sent would be dropped; the board says so.
- **Reading.** Each tick, `orchestration check --terminal <mailbox> --peek --full` reads new mail
  as Orca stores it; questions (`Advice: …`; a reply such as `Re: Advice: …` is logged and not
  answered again, and a follow-up is a new `Advice:`) are saved, by message id,
  before a plain `check --full` marks the batch read, so a crash in between loses nothing and
  nothing is taken twice. Mail that came between the two is taken from that batch. A message is
  marked read only once its subject or body was read. Mail that is not a question is dropped.
- **Only the supervisor.** A question counts only when its `from_handle` is one of the
  supervisor's addresses; anything else is dropped and logged, and nobody is told. Orca 1.4.257
  stores a sender as its caller's address: a chat (an Orca agent session) as
  `orca_session_id:<id>`, the root id that survives `/clear`; a terminal agent as its terminal
  handle. Matriarch keeps the session id from the chat's launch receipt (`outcome.sessionId` when
  `outcome.kind` is `structured`) and the terminal from a terminal launch, and reads the handle
  the Run is bound to now (`run-show --full`: `coordinator_handle`; Orca hides a Run's
  coordinator session id). A supervisor Matriarch did not launch is known only by that handle,
  so a chat started by hand gets no answers. The board counts dropped questions. This is an
  address match, not authentication: Orca does not authenticate senders (see SECURITY.md).
- **Answering.** One question at a time per project, up to 10 waiting: a throwaway worktree of
  the default branch (a `matriarch/review-` branch, so the board skips it), the advisor launched
  there exactly as a reviewer is (same lockdown, same launch confirmation, same tool guard), and
  told to write `{"answer": …}` to `.matriarch/review/advice-<id>/answer.json`, inside the
  verdict folder the lockdown already lets it write. The answer is mailed to `run:<id>`, then the
  worktree goes.
- **Starting safely.** The question is saved as starting before the worktree is made, and again
  with it before the agent launches; one found still starting after a reload ends, and its
  worktree goes, so a second advisor never starts.
- **Watching.** Every terminal in the worktree is read, without the lines of its brief echoed
  back (the question may say "codex resume" or "Do you want to proceed?"). Quiet for 30 minutes,
  over 2 hours (waiting on a person or not), its terminal closed, its agent quit, or an agent
  resumed there without the lockdown (closed at once): the supervisor hears there is no answer.
- **Dry run.** Like automatic reviews it starts only with autopilot on. In dry run questions wait,
  and the board says why (autopilot off, or settings with errors); answers wait in an outbox
  until autopilot. Notices of how the advisor is set up (available, changed, moved, off) go
  whatever autopilot says, like every notice of a change the person made in Settings.
- **Polled.** Like review rounds, every project with an advisor at work, mail waiting or a
  worktree left (`advice:active`) is looked after each tick, also when no tick sees the project
  (its workspaces closed): timeouts, terminal checks, removals and mail go on. Only a project the
  tick sees starts a new question.
- **Turned off.** Turning the advisor off stops the question being answered and drops the waiting
  ones, and the supervisor is told both. Turning Matriarch off for the project does the same,
  removes the worktree and clears the project's advisor state; the supervisor hears it in dry
  run too.
- **Board.** The supervisor's card shows the advisor and its question, an advisor set that
  Matriarch cannot start (with why), and how many questions it dropped; one stuck on a prompt
  shows under **Needs you** with its terminal.

## Merging (phase 5)

- **Gate.** All of these must hold:
  - PR open and not a draft;
  - CI passing on the exact head commit;
  - review policy passed on that commit (or skipped as a light change);
  - no unresolved human threads and no human "changes requested";
  - not stacked on an open PR (see [Stacked PRs](#stacked-prs)), and its base known not to be
    one when the open list was cut short;
  - the forge reports it can merge;
  - no file matches `requireHuman` (in any case). If the file list was cut short, the gate assumes it does.
- **Manual.** `ready`, plus one notification per commit.
- **Auto: a merge train per base branch.**
  - Merges one PR at a time, in task order, then by PR number.
  - Merges with `gh pr merge --<method> --match-head-commit <sha>` (on GitLab, `PUT
    …/merge` with `sha`), so a change after review can't be merged by mistake.
  - Never uses `--admin`.
  - A PR that is only behind its base gets `gh pr update-branch` (GitLab: `PUT …/rebase`, or a
    message to its worker when `updateBranch` is `merge`). A PR with real conflicts goes to its
    worker, then up the escalation ladder.
  - Branch protection that needs a human (`BLOCKED`; on GitLab also missing approvals,
    unresolved threads and other merge checks) leaves the PR in `needs-you`.
- **Base branch health.** The cheap list query also reads the default branch's CI rollup
  (GitLab: its latest pipeline, when that pipeline is for the branch's head). While it is red,
  auto merges pause and the supervisor is asked to fix it forward, or with `onBaseRed: "revert"`
  to find and revert the change that broke it (Matriarch does not open the revert PR itself yet,
  and the config check says so).
- **After each merge.** The other PRs are polled again: newly conflicting ones are sent back,
  clean ones are updated, and a PR stacked on the merged one moves on (see Stacked PRs).
- **Cleanup.** The merged PR's worktree is removed once no worker is live there and nothing in it
  is uncommitted (`merge.removeWorktree`); the branch is deleted when `deleteBranch` is set. A
  worktree the supervisor's workers used that never became a PR goes an hour after its last
  worker finished, when nothing in it is uncommitted or unpushed (`merge.removeFinishedWorktrees`),
  except one whose worker Matriarch stopped over a limit (see Worker limits).

## Forges: GitHub and GitLab

Code: `src/forge.ts` (the abstraction, each forge's names and agent commands, remote parsing),
`src/github.ts` and `src/gitlab.ts`. Detection is `detectForge` in `src/worker.ts`.

- **One snapshot.** Each forge reads a PR into the same `PrSnapshot`, so the planner never asks
  which one it reads. A merge request carries `forge: "gitlab"`, which only picks the words and
  commands in reasons, messages and briefs (`forgeTerms`).
- **The interface.** A `Forge` reads (`listOpen`, `detail`, and where it can `failureDetails`,
  `isAncestor`, `fileMoves`, `labeledIssues`, `labelCheck`) and acts (`merge`, `updateBranch`,
  `publishReview`, `failedLogs`, `retarget`, `rerun`, `commentIssue`), and says which branch
  updates it can do itself (`updates`). The
  engine reads through the project's forge, and the executor acts through it. GitHub's code moved
  behind it unchanged: the same `gh` calls, arguments and error texts.
- **Identity.** On GitHub a project is `{ owner, name }` as before. On GitLab it is
  `{ kind: "gitlab", host, owner, name }`, where `owner` is the namespace with every nested group
  (`group/sub`). Storage keys: GitHub's stay `owner/name`, since a live installation's state is
  stored under them; GitLab's are `<host>/<path>` (`gitlab.example.com/group/sub/app`). These have
  at least two slashes, so they can never be a GitHub key.
- **Detection**, from the origin URL. https, `git@host:path` and `ssh://git@host:port/path` are
  read; a trailing `.git` or `/` is dropped; an ssh port is dropped, an https port kept.
  1. github.com is GitHub, exactly as before, unless the project's setting names a GitLab host.
  2. `forge: { kind: "gitlab", host? }` in `.orca/matriarch.json` (Settings → Project → **Where it
     lives**) makes it GitLab on that host, or the origin's: for an ssh alias, or a host glab is
     not signed in to yet.
  3. Otherwise `glab auth status --hostname <host>` decides. Only its exit code is read, once per
     host per lookup; the project list looks again each time it opens.
  4. Failing all three, the project list says the origin is on neither GitHub nor a GitLab host glab
     is signed in to, and to run `glab auth login --hostname <host>`.

### GitLab through glab

Every call is `glab api --hostname <host> …`, so glab never guesses the host from a working folder
and does the signing in. Matriarch never reads, prints or passes a token.

- **No free polling.** GitLab sends ETags and answers `If-None-Match` with 304, but a 304 still
  counts against its rate limit (checked on gitlab.com: `RateLimit-Observed` went up). The
  simplest sound approach is one GraphQL query per project per tick. It reads:
  - `currentUser`;
  - the open merge requests (50 a page, up to 4 pages, newest update first), each with its
    branches, `sourceProjectId` and `targetProjectId` (a fork's merge request is never a stack
    parent), `diffHeadSha`, `updatedAt`, author and `headPipeline { status }`;
  - the default branch's name, its head (`repository.tree(ref:).lastCommit.sha`), and its latest
    pipeline (`project.pipelines(ref:, first: 1)`).

  A commit's own pipelines include other refs' (Duo workflow refs on gitlab.com), so the base is
  judged by the branch's pipelines. Its name is kept per project: the first read asks with `HEAD`,
  learns the name and reads again.
- **Detail on change.** A merge request is read in full only when its head, `updatedAt` or pipeline
  status moved, or its detail is older than 5 minutes (`QUIET_REFRESH_MS`, through the list's
  `detailMaxAgeMs`): approvals and resolved threads may not move `updatedAt`. One GraphQL query
  reads it; on gitlab.com it fits even the anonymous complexity limit.
- **Lazy mergeability.** GitLab works out whether a merge request can merge only when asked, and a
  GraphQL read does not ask: on gitlab.com merge requests stayed `UNCHECKED` across reads. While it
  is unknown, the detail also reads the merge request over REST. GitLab rechecks on that read for
  someone who may merge it (not verified: anonymous reads never trigger it).
- **Mapping into PrSnapshot.**

  | GitLab | PrSnapshot |
  |---|---|
  | head pipeline's jobs (`retried: false`) | checks. Failed is failure, or neutral when allowed to fail. Canceled is cancelled. A manual job is skipped when allowed to fail, else pending. Unfinished is pending. A bridge job has no log. When the list is cut short, the pipeline's status decides. |
  | head pipeline's status | the list's rollup, in GitHub's words: failed is FAILURE, unfinished is PENDING |
  | resolvable discussions | threads, resolved ones kept as resolved, path and line from the first note's position. Started by the viewer, or carrying `<!-- matriarch`, they are ours. System notes and plain comments are not resolvable and are left out. |
  | a reviewer whose `reviewState` is `REQUESTED_CHANGES` | a `review:<user>` thread, like GitHub's "changes requested" review body |
  | `diffStats` | files, cut short when `diffStatsSummary.fileCount` is larger |
  | `approved`, `approvedBy`, reviewers, `NOT_APPROVED` | `reviewDecision`, as on GitHub. The gate reads the merge status below, not this. |
  | the default branch's latest pipeline, when it is for the branch's head | the base rollup, for the red-base pause |
  | `RateLimit-Remaining` and `-Reset` headers (`glab api -i`) | the board's budget, labelled GitLab when no GitHub project reports one. A self-hosted GitLab may send none. |

  | `detailedMergeStatus` | mergeable | mergeStateStatus | so the planner |
  |---|---|---|---|
  | `mergeable` | MERGEABLE | CLEAN | marks it ready, or merges it |
  | `conflict`, `broken_status` | CONFLICTING | DIRTY | sends the conflict to the worker |
  | `need_rebase` | MERGEABLE | BEHIND | updates the branch |
  | `draft_status` | MERGEABLE | DRAFT | treats it as a draft |
  | `ci_must_pass`, `ci_still_running` | MERGEABLE | UNKNOWN | follows the jobs, and waits |
  | `checking`, `unchecked`, `preparing`, `approvals_syncing` | UNKNOWN | UNKNOWN | waits, reading it again each tick |
  | `not_approved`, `discussions_not_resolved`, `blocked_status`, `requested_changes`, and the other checks a person settles | MERGEABLE | BLOCKED | needs you |

- **Actions.**
  - Merge: `PUT …/merge_requests/:iid/merge` with `sha` (GitLab refuses when it is no longer the
    head), `squash` (method `squash`) and `should_remove_source_branch` (`merge.deleteBranch`).
    Methods `merge` and `rebase` both merge with the project's own merge method in GitLab.
  - Update a branch that is behind: `PUT …/rebase`, which GitLab runs in the background, like
    `gh pr update-branch`. GitLab has no API to merge the base into a branch, so with
    `updateBranch: "merge"` the worker that owns the branch is asked to (the supervisor when none
    does).
  - Review: one note (`POST …/notes`), starting with `<!-- matriarch:review … -->`, with the
    blocking findings folded in. A plain note is not a resolvable thread, so it never blocks "every
    thread resolved".
  - CI logs: `projects/<project>/jobs/:id/trace`, from the project the job ran in, taken from its
    page (a fork's pipeline runs in the fork). Section markers, redrawn lines and runner timestamps
    are dropped.
- **Agent commands.** `glab mr create --target-branch <base> --fill --yes`, `glab mr view <n> -F
  json` and `glab mr update <n> --ready`. A worker resolves a thread with `discussionToggleResolve`
  through `glab api graphql`. A GitLab brief also says the project is on GitLab and that a PR there
  is a merge request.
- **Reviewer lockdown.** The Claude denylist adds `glab mr
  merge|create|update|note|approve|revoke|close|reopen|rebase|delete` and `glab ci
  run|retry|cancel|delete|trigger`, each bare too (glab acts on the current branch's merge request
  without a number), and `glab api`. The tool guard allows only `glab mr view|diff|list`, `glab
  issue view|list`, `glab ci status|list|get|trace`, `glab repo view` and GET-only `glab api`, as
  for gh. `glab ci view` is refused: its screen can run and retry jobs.
- **Checked against gitlab.com (2026-11-13)** with anonymous GET requests on public projects
  (gitlab-org/gitlab-runner):
  - the REST merge request list, a single merge request, pipelines and jobs;
  - the GraphQL list and detail queries above: their field names, `iid` as a string, `gid://`
    ids, diff notes' `position`, `bot` on authors, `retried` on jobs, `reviewState`, and
    `project: null` for a project it cannot see;
  - rate-limit headers on REST and GraphQL, and a 304 counting against them;
  - that a head pipeline may run in a fork.

  **Not verified:**
  - job traces (gitlab.com answers 401 without signing in) and `currentUser`;
  - merge, rebase, notes, approvals and the REST mergeability recheck;
  - for stacked PRs: `sourceProjectId`/`targetProjectId` (from GitLab's GraphQL reference, not
    run against gitlab.com), the `target_branch` update and `repository/merge_base`;
  - for flaky checks: `GET jobs/:id`'s `failure_reason` and the job retry;
  - for light review: `merge_requests/:iid/diffs` with its `X-Next-Page` header, and the older
    `…/changes` fallback;
  - for issues: the issue list, `resource_label_events`, `members/all/:id`, `users/:id` and its
    `bot` field, the issue's GraphQL `lastEditedAt` (and whether it moves on a title edit), and
    issue notes;
  - `--hostname` with a port;
  - anything on a self-hosted GitLab. An older one lacks some of these GraphQL fields
    (`detailedMergeStatus`, `reviewState` among them), and the board then shows GitLab's error.

## Seeing the work

Many worktrees run, wait and block at the same time. One view has to answer three questions
at a glance: what is happening now, what is stuck and on whom, and how the work flowed.

### What the other plugins do

| Plugin | View | What it shows |
|---|---|---|
| Orca's Agent Dashboard (built in) | Kanban | Needs You / Working / Done / Idle columns, filterable by PR status |
| Orchestra | HTML panel | live task DAG and a board of tasks waiting on dependencies, ready, in progress and done |
| Subagent Graph | Panel | the orchestrator → worker tree, with counts in the status bar |
| Agents Director | HTML panel | a swimlane timeline per agent |
| orchestrator.inc | Kanban | building / validating / in review / ready, from PR and CI facts |

Agents Director registers its HTML page as a sidebar panel and also as a custom editor with a
"new file" entry, so the same view opens as a full-width tab from the tab bar + menu.

### What Matriarch shows

One HTML view (`src/view/main.ts`). It is registered as the sidebar panel, and as a custom
editor for `.matriarch` files. The **Matriarch board** item in the tab bar + menu opens it
full width.

- **Timeline (swimlanes).**
  - One row per worktree, grouped by repository.
  - Bars colored by lane group over the last 1, 6 or 24 hours. Idle and merged time is drawn
    as a thin line so active work stands out.
  - Dots for events: pushes, CI or comment messages sent, reviews started, branch updates,
    escalations, merges.
  - **At once** strip above the rows: how many worktrees were working, awaiting CI, fixing, in
    AI review, blocked on you or ready, at each moment. It shows when several things stall
    together.
  - Hovering a bar or dot tells why. Clicking a row opens its activity log under it (with a
    button to open the worktree in Orca).
- **Board.** Cards grouped by lane: Needs you, Fixing, AI review, Working, Awaiting CI,
  Ready / merging, Idle, Merged / closed. In the sidebar the groups stack into one column. A
  card shows:
  - the PR and its worktree, the agent with its model and activity;
  - CI state and failing checks, open comments;
  - the reason for its lane and the rounds used;
  - in dry run, **Would do next**;
  - **What Matriarch did**, folded: the same activity log as a timeline row's.
- **Header.** Dry run or autopilot (turning autopilot on takes a second confirming click),
  counts per lane group, problems and config warnings, GitHub rate budget left.
- **Status bar.** For example `Matriarch 1 need you · 1 fixing · 2 running (dry run)`. The
  tone is red when something needs you. Clicking it goes straight to the first thing that needs
  you, otherwise it opens the sidebar.

### Needs you, one click away

What only a person can settle is never left to a line of text in the panel. A stuck review
taught this: the only place to answer it was a terminal in a worktree you never created.

- **Panel.** A **Needs you** box at the top, with an **Open it** button that brings the exact
  terminal (or workspace) to the front.
- **Orca's own surfaces.**
  - a desktop notification the moment it happens;
  - the unread dot on the review worktree in Orca's sidebar, with a comment saying why.
- **Away from the desk.** The same notices can go to a webhook: see [Away alerts](#away-alerts).
- **Naming.** Review worktrees are named `Matriarch review · #<n> · <sha>` and linked to their
  PR, so they read as Matriarch's at a glance.
- **Timing.** A reviewer is timed out only when it has been quiet for the whole limit: no
  verdict and no change in its terminal.
  - Change means new output lines, or the same lines redrawn: a thinking agent's timer moves,
    its line count doesn't.
  - Time spent waiting on a person never counts.
  - A round marked failed while its reviewer kept working goes back to running.
  - A verdict that arrives late is still adopted, for 2 hours, while the worktree is kept.

### Away alerts

`src/alerts.ts`, and the **Alerts** page. With a webhook set, what reaches the person in Orca's
notifications also goes to Slack, Discord, ntfy or any JSON webhook, by kind: needs you (an
escalation to the person, a reviewer or advisor stuck on a prompt, a PR that needs a human merge
or is blocked), ready to merge, and (off by default) merged, which is webhook-only since Orca
shows no notification for a merge. Board-only notices (a nearly full disk, a supervisor over its
limits) send nothing. The engine's alerts go only while it acts (autopilot on); in dry run only a
reviewer stuck on a prompt in a review the person started is sent, as Orca notifies them of it.
The settings are per machine: the URL in Orca's secrets, the rest in plugin storage, none of it in
a project's config.

- **Sending.** Each alert is posted once, never retried and never redirected (`redirect:
  'error'`, so a 307 or 308 cannot carry the POST elsewhere), with a 10-second limit raced
  against the request so a hung webhook cannot hold anything up. Whether an alert goes (its kind
  switched on, a URL set) is settled before it takes a place. Four post at a time, twenty more
  wait, and anything past that is folded into one "and N more" post once the queue drains. A
  failed post is kept for the Alerts page until one works.
- **The URL is a secret** (whoever has a Slack or Discord webhook can post to it): it lives in
  Orca's encrypted secrets (`secrets:own`, the OS key store), is refused where Orca has none, and
  only its host is ever shown or logged; every error is scrubbed of it, its path and any
  password. Credentials in it go as a Basic `Authorization` header, since Node's fetch refuses
  them in a URL. `http://` is accepted, for a server on the person's network.
- **No PR text can steer a post.** A Discord post allows no mentions, so a PR titled `@everyone`
  cannot ping a channel; Slack's `&`, `<` and `>` are escaped; an ntfy title with a line break or
  non-ASCII is RFC 2047-encoded, and the click header keeps only printable ASCII.

### Data behind it

The engine keeps each worktree's history in plugin storage (`track:<workspaceId>`), pruned to
7 days. The view never polls GitHub itself. It gets the board from the worker after every
tick (`board.changed`), and the board carries the last 24 hours of history.

- **Segments:** a lane plus from/to, recorded each time the planner's lane changes.
- **Marks:** point events.
- **Log:** what Matriarch did and why, in words: each new lane with its reason (not every new
  reason within a lane, since some change each check), new commits, finished reviews, and every
  action it carried out or tried, with the recipient and subject of each message the executor
  sent and the error of each that failed. Dry run's plans are not logged. The same line right
  after itself (an action that fails every check) is counted on the first, with when it last came,
  so a stuck PR does not fill the log. Capped at 300 lines and pruned with the rest. It is not on
  the board: the panel asks for one track's log (`track.log`) when it is opened, and again after
  each tick while it stays open.
- **Whose history:** a worktree's history (`track:<workspaceId>`) belongs to the first PR on that
  worktree (`pr` in the record), so one row runs from building to merged. Any other PR on the
  same worktree (a follow-up from the same branch while the first is still on the board, or one
  per base) keeps its own under `track:pr:<repo>#<n>`, so their lanes, commits and logs never mix.
  When a merged PR's worktree is removed, its history moves to `track:pr:<repo>#<n>` and the
  worktree counts as gone for the rest of that tick, so the tick's lines land there too.

Worktrees with no PR yet appear too: `building` while their agent works, `needs-you` while it
waits for input, `idle` otherwise.

`tools/preview/` renders the view in a browser with sample data (`pnpm preview`), so the view
can be changed and checked without Orca.

## Decisions (2026-11-10)

- **Name:** Matriarch, id `matriarch`. No Orca plugin or agent tool uses it. "Pod" and
  "Superpod" collide with other tools; "Spyhop" is an existing Orca session-board project.
- **AI reviews on GitHub:** `publish: "github"` by default, as one combined comment review per
  round, plus inline comments for findings at or above `blockAt`.
  - Why: a record on the PR for people and other tools, it survives Orca restarts, and gives
    workers real threads to resolve.
  - `orca-only` keeps them local.
  - Posting as you only allows comment reviews, so the merge gate relies on Matriarch's own
    verdict, never on a GitHub approval from your account.
- **Merging:** both modes. `manual` stops at *Ready to merge*. `auto` is for unattended runs:
  the merge train, branch updates and conflict routing, with the supervisor settling what the
  workers cannot.

## Housekeeping

- **Superseded rounds.** A round still reviewing an older commit when the PR moves on is
  stopped, and its worktree removed. It does not use up a review round.
- **Failed rounds.** Their worktrees are kept for the 2-hour late-verdict window, then removed.
- **Pruning.** Storage is pruned at most hourly:
  - a PR's ledger, snapshot and review rounds go 7 days after Matriarch saw it merged or closed;
  - a worktree's history goes 7 days after the worktree was last seen.
- **Serial writes.** Polls and panel actions that change storage run one at a time, so
  neither overwrites the other.
- **Activity across restarts.** What each agent is doing is saved and restored on restart;
  anything older than 30 minutes is not trusted.
- **Unbuilt options.** Config options that are accepted but not built yet (`arbiter`,
  `onBaseRed: "revert"`) produce a warning.

## Safety

- Dry run is the default (`autopilot` setting off): the board shows what would happen. What still
  runs in dry run (reads, a review you start, a worker-limit refusal, mail to the supervisor
  when you save its settings) and what waits for autopilot are listed in the README's
  [Dry run and autopilot](README.md#dry-run-and-autopilot).
- Per-repo opt-in: only repositories that commit `.orca/matriarch.json` are touched.
- Only PRs whose head branch belongs to an Orca workspace and whose author is the signed-in
  `gh` (or, on GitLab, `glab`) user are managed.
- Merges are checked against the commit that was reviewed, never bypass branch protection, and
  stop for protected paths.
- Round caps on every loop.
- Pausing: **Pause autopilot** in the panel, or the palette command **Matriarch: Turn autopilot
  on or off**. The switch is re-read before every action, so a pause takes effect at once, even
  in the middle of a poll.
- A repository whose config has errors is watched only: no actions run there until it is fixed.
- Reviewers and the advisor are read-only by their own agent's enforcement (see Review crew,
  Lockdown), so they cannot push, commit or touch another worktree even if this plugin stops
  answering.
  Limits: your own Claude allow rules still apply to a Claude reviewer (the denylist covers the
  damaging ones and reads outside the worktree), a Codex reviewer can read outside the worktree
  (with no network). A session Orca resumes (after an account switch or a restart) skips the
  launch hook, so it would come back unlocked: the crew sees the resume line in the review
  worktree, closes that terminal and starts the reviewer again locked down (twice at most per
  round). It does the same for a reviewer whose agent quit, such as Codex after an update.
- A reviewer that hits its account's usage limit, or a rate-limit menu, shows as **Needs you**
  with **Open** and **Restart**: switch the account or add credits, then restart it. The other
  reviewers keep their verdicts.
- When Orca's worker list or the forge cannot be read, nothing is sent to workers, nothing is
  escalated as orphaned, and the timeline keeps its last known state.

## Orca integration

- **Host API:**
  - workspace: `workspace.list`
  - agents: `agents.list`
  - UI: `notifications.show`, `statusBar.update`
  - plugin data: `storage.*`, `settings.*`, `secrets.*` (the away-alert webhook URL)
- **Events:** `agent.status.changed`, `workspace.created`, `workspace.removed`.
- **Hooks:**
  - `agent.launch.before`: reviewers and the advisor start locked down in their agent's own
    read-only mode;
  - `agent.tool.before`: the second, read-only guard for Claude reviewers and a Claude advisor,
    and the worker-limit refusal for a Claude Code supervisor or worker in a terminal.

  The PR contract reaches workers through the supervisor's task specs, not a hook.
- **CLI (child processes):**
  - `orca orchestration worker-list | run-list | run-show | send | check | worker-stop`
  - `orca agent launch`, `orca worktree create | set | rm`, `orca terminal create | list | show |
    read | switch | close`, `orca repo list`
  - `gh api graphql`, `gh api -X HEAD -i` (change probes), `gh api` REST for logs, annotations,
    re-runs, compare, issues and reviews, `gh pr merge | update-branch | edit`
  - `glab auth status --hostname`, `glab api --hostname <host> graphql | projects/… | users/…`
    (see Forges)

The plugin runs `orca`, `gh`, `glab` and `git` with your user's access, so a person approves it as
a full-access plugin. The README's [What it runs](README.md#what-it-runs-on-your-machine) lists
every command, with when it runs.

### Orca sources read

Some of how Matriarch works around Orca rests on reading Orca 1.4.257's own source, not on a
documented API, and should be checked again on each new Orca:

- `agent.tool.before` is waited on only for Claude Code; other agents' tool calls are only
  reported (`agent-tool-plugin-hooks.ts`).
- A chat session's agent starts with its pane identity removed
  (`structured-session-child-env.ts`), and plugins see only tool calls from a pane, so no hook
  sees a supervisor in a chat.
- A tool event's `terminalId` is Orca's terminal handle (`getTerminalHandleForPaneKey`), and
  `worker-list --full` rows carry `agentTerminalHandle`: that is how the limits tell the
  supervisor's and its workers' calls from the person's.
- A message's sender is stored as its caller's address (`from_handle`): `orca_session_id:<id>` for
  a chat, the terminal handle for a terminal agent; `check` takes `--full` like every
  orchestration command (`withFullRecordFlag`).

### Verified live (Orca 1.4.255, 2026-11-10)

- Workspace discovery, the opt-in config, and `gh` GraphQL from inside the plugin worker. `gh` is
  on Orca's PATH; a poll costs 1 point.
- Two Orca facts the code now handles: worktree branches arrive as `refs/heads/<name>`, and this
  machine's workspaces carry `hostId: "local"`.
- `worker-list --json` answers `{ workers, scope }`.
- A review round on a real PR:
  - the worktree is created at the PR head;
  - a Claude reviewer (`claude-opus-5-5`) and a Codex reviewer (`gpt-6-astra`) are launched with `--model`;
  - Codex wrote a valid verdict file and left the worktree untouched.
- The read-only hook (`orca plugin dev hook`) refuses an Edit and `git push` in the review
  worktree, and allows the verdict file.
- Gotcha: a new worktree's workspace id can be missing from `workspace.list` for a moment. The
  crew reads it from the create receipt, retries on every poll, and also matches
  `<repoId>::<path>` ids.

- Codex reviewed PR #51 and approved it with no findings. It stayed within the brief: a static
  review, nothing built or run.
- **Claude reviewers stop at Claude Code's one-time "Bypass Permissions mode" warning.** Orca
  launches Claude with `--dangerously-skip-permissions`, and the account Orca used had not
  accepted that warning yet.
  - The crew now reads a quiet reviewer's terminal and recognises this and other prompts that
    wait on a person.
  - The PR goes to **Needs you** with the reason, and the reviewer is not timed out, so the round
    completes once someone answers.
  - Matriarch never answers such prompts itself.
- A board field that is `undefined` is not JSON, and Orca refuses the whole reply. The worker
  now strips such fields before it posts or answers.

### Resolved: Claude reviewers and bypass mode

Reviewers no longer start in bypass mode, so the one-time warning never appears for them. The
lockdown was checked live (2026-11-10, Claude Code 2.1.322, Codex 0.167.0):

- In a scratch repo, Claude in `dontAsk` with the allowlist read the worktree, ran `git log` and
  a pipe, and wrote the verdict file. It was refused `touch`, a write elsewhere, a read outside
  the worktree, `git diff --output=...` and `git commit`. Two gotchas came up. The tool lists
  take several values, so the prompt must never follow them. And path rules must be `Edit(...)`,
  which covers Write too.
- Codex in the workspace sandbox with the overrides wrote the verdict file and ran `git diff` and
  `rg`. Writes outside the worktree and to `/tmp`, `git commit` and network calls all failed.
- On PR #51 in Orca the hook rewrote both launches. The live processes run with
  `--permission-mode dontAsk --setting-sources user --strict-mcp-config` (Claude, whose footer
  reads "don't ask on") and `--sandbox workspace-write --ask-for-approval never` (Codex). No
  bypass flag was left, and no trust or permission prompt appeared. Both wrote their verdicts:
  Codex approved, and Claude asked for changes (9 findings, 1 major). The round settled, and the
  worktree and branch were removed.
- That round also caught a guard false positive. `cd rust/crates/x/src && grep -n '/// ...'
  ../tests/x.rs` was refused: the guard read the grep pattern as an absolute path and ignored
  the `cd`. Both are fixed, with that command as a test.
- In `dontAsk` mode a tool with no allow rule is not offered at all. So the search tools get
  path rules, `Grep(./**)` and `Glob(./**)`: inside the worktree they work, outside they are
  refused (checked in the scratch repo).
- The read-confinement rules were checked in a scratch repo with the exact generated flags.
  `cat "/etc/hosts"`, `cat '/etc/hosts'`, `cat </etc/hosts`, `grep --file=/etc/hosts`,
  `cat "../x"`, `cat ~/x`, `cat $HOME/x` and `cat src/../../x` were refused. `grep -rn`,
  `git log`, a pipe and the verdict write ran. Claude parsed all 39 deny rules without a warning.
  (The 31 `glab` rules added with GitLab support have not been run through Claude yet.)

### Tuned after the first long run on a real project (2026-11-12)

- **No CI, no wait.** With no checks on the default branch's head and none ever on the PR, a
  push is reviewed at once instead of after the 3-minute grace for checks to register.
- **Only rounds that reached someone count.** A round that asked for changes, whose findings were
  neither delivered nor posted before the PR moved to a new commit, no longer uses up one of the
  PR's `maxRounds` (the next round still checks its findings).
- **Cheaper follow-ups** (`review.followUp`, default `focused`): rounds after the first read
  `git diff <last reviewed>..HEAD` and check the earlier findings, instead of the whole PR.
- **A fallback reviewer** (`review.fallback`, optional): a reviewer stuck at its account's usage
  limit is started again, once, on this agent and model, locked down as before.
- **Merged worktrees go** (`merge.removeWorktree`, default on): once a PR is merged, its worktree
  is removed when no worker is live there and `git status` shows nothing at all; otherwise it is
  kept, with the reason on the board, and tried again each check for a week.
- **A quieter board:** worktrees with no PR and nothing running fold into one line; the project's
  own checkout shows as **Supervisor** while it works.
- **Reload-safe lockdown:** launch records are kept in plugin storage too, so a reviewer launched
  while the plugin reloads is still confirmed rather than stopped.
- **A full disk shows.** Under 10 GB free on the disk with a project (now `limits.minFreeDiskGB`,
  which also stops new workers, and 0 turns off), the board's "Needs you" says so; a check that fails because the disk is full puts that on the board and the status bar
  instead of only in the log. (That run stalled once on a full disk with nothing on screen.)
- **The supervisor cleans up its own worktrees:** the brief has it remove worktrees that never
  become a PR (gates, audits, spikes) once their result is recorded; Matriarch removes PR
  worktrees on merge.

### Orca 1.4.257 orchestration rules (found on that run, 2026-11-12)

- **A sender needs a terminal.** `orchestration send` from no terminal is refused
  (`no_active_sender_terminal`). Matriarch sends from a "Matriarch mailbox" terminal of its own in
  each project's main checkout; it runs `cat > /dev/null`, so mail typed into it is swallowed.
- **Only the Run's coordinator can wake a finished worker.** Mail to a finished Dispatch starts a
  follow-up worker, which Orca allows only for the coordinator or an active worker in the Run.
  So work for a finished worker (findings, CI failures, a rebase) goes to the supervisor, with
  the worktree and branch, and it starts the follow-up.
- **`--type escalation` is for workers.** From anyone else Orca rejects it ("No active Dispatch
  belongs to this message sender"); Matriarch's escalations go as plain mail titled "Escalation:".
  (Orca forwards a rejected escalation to the coordinator with its body, which is how the first
  findings still reached the workers on this run.)
- **Workers:** `worker-list` needs `--full` for each worker's Run and worktree; Orca names a
  worktree by identity in its workspace list and as `<repoId>::<path>` in orchestration and agent
  events, so Matriarch matches them by path; `--worktree new-child` with `--model` is refused for
  OpenCode, so workers start in a worktree created first; Orca checks `--effort` against its own
  model list, which can lag behind the agent's.

### Polling GitHub cheaply

- Each tick, per repository, conditional `HEAD` requests (`If-None-Match` with the last ETag)
  ask whether anything changed:
  - the newest PR update (`pulls?state=all&sort=updated&per_page=1`), which catches pushes,
    new, closed and merged PRs, comments and reviews;
  - the default branch ref, and its check runs and status;
  - the check runs and status of each PR Matriarch follows.
- A `304` costs no rate limit (checked live). A `HEAD` that did change costs 1 point and
  downloads no body.
- Only when something changed, or after 5 quiet minutes, is the open-PR list read over GraphQL.
  A probe that cannot tell counts as a change, so nothing is missed.
- A PR's detail is read again when its head, update time or rollup changed, when the default
  branch moved (mergeability), or, while CI is failing, when any of its checks moved (the
  planner waits for the rest to finish). Otherwise it is read at most every 10 minutes.
- Live on ctxmesh: an idle tick is 6 probes, ~0.8 s, no GraphQL, no rate limit. The old poller
  spent a GraphQL list every 45 s (80 an hour per repository) plus every PR's detail every 5
  minutes.
- GitLab has no such free check: see [Forges](#forges-github-and-gitlab).

### Not yet run live

Everything below is built and covered by tests against stand-ins for Orca, GitHub and GitLab,
but has not run on a real project or a live Orca yet:

- **The advisor's mailbox.** That `orchestration check --terminal <mailbox> --peek --full --json`
  works from the plugin's worker with the mailbox named, answers `{messages: [{id, from_handle,
  subject, body, …}], count}`, and that a plain `check --full` marks that batch read for a plain
  terminal; that a supervisor chat's `send --to <terminal handle>` is stored for the mailbox, not
  only typed into it; that its `from_handle` is `orca_session_id:<id>` with the id the chat's
  launch receipt gave, still after `/clear`; that a terminal supervisor's sender is its handle,
  equal to the Run's `coordinator_handle` from `run-show --full` (also after a restart re-issues
  it); and whether any other caller can send as the supervisor's session.
- **Worker limits.** That `agent.tool.before` never fires for a supervisor in a chat (read from
  Orca's source, above), and that `worker-stop` on a live dispatch stops it and keeps its
  worktree.
- **Away alerts.** Orca's `secrets` with `secrets.protection` set to `os-keyring`, and a real
  post to each format.
- **Stacked PRs, flaky checks, light review and issues** against a real repository: the GitHub
  calls each makes (`gh pr edit --base`, the job and workflow re-runs, check-run annotations,
  compare, the issue list and label events, the collaborator permission, issue comments; only the
  GraphQL queries were run, read-only, against github.com), and the GitLab calls listed under
  [Forges](#gitlab-through-glab).
- **The activity log and the Alerts page** on screen inside Orca, rather than in the preview.

## Roadmap

1. **Engine core (built, live):** config, forge snapshots, planner, ledger, CLI adapter, board
   panel, dry run.
2. **Fix loops (built, live):** CI, conflict and comment messages with failed-log excerpts;
   escalation to the supervisor and to you.
3. **Review crew (built, live):** throwaway worktrees, parallel reviewers on their own models,
   verdict parsing, aggregation by policy, publishing, prompt detection, on-demand rounds, and
   reviewers locked down at launch by their own agent. Not built yet: the arbiter.
4. **Supervisor (built, live):** the brief, finding its Run, escalations, worker settings and
   limits told to a running supervisor. Built, offline only: the advisor, issues as objectives,
   and worker limits.
5. **Merge train (built):** auto merge pinned to the reviewed commit, branch updates, the
   base-red pause, cleanup after a merge, and stacked PRs (offline only). Next: merge queues, and
   `onBaseRed: "revert"` opening the revert PR itself.
6. **Seeing the work (built):** timeline, board, Needs you, the activity log and away alerts (the
   last two offline only).
7. **Next:** run every offline-only part on a real project and a live Orca, then publish to the
   community catalog.
