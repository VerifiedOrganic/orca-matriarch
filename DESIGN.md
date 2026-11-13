# Matriarch: design

An orca pod is led by its matriarch. This plugin is the supervisor for a pod of coding
agents in Orca:

- a **supervisor** agent plans and delegates;
- **workers** build each piece in their own worktree and open PRs;
- a **review crew** of several reviewers, each on its own provider and model, reviews every PR;
- a deterministic **engine** drives every PR through CI, review, fixes, conflicts and merge, on
  GitHub or GitLab (gitlab.com or self-hosted), where a PR is a merge request.

It can run unattended.

Status: the engine, timeline and review crew work live. The supervisor launcher and the merge train are built and tested offline. See [Roadmap](#roadmap).

## Goals

1. Each role (supervisor, worker tiers, every reviewer, arbiter) picks its own agent, model and
   effort level.
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
simple values, so the role setup lives in the repo and is versioned with it. Defaults (see
`src/config.ts`):

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
  "review": { "enabled": true, "trigger": "ci-green", "pass": "all-blocking-approve", "blockAt": "major",
              "differentProviderThanAuthor": true, "maxRounds": 3, "publish": "github" }, // "github": on the PR, GitLab too
  "fix": { "ci": { "enabled": true, "maxRounds": 3 }, "comments": { "enabled": true, "maxRounds": 3 },
           "conflicts": { "enabled": true, "maxRounds": 2 } },
  "merge": { "mode": "manual", "method": "squash", "requireHuman": [], "updateBranch": "rebase",
             "onBaseRed": "pause", "deleteBranch": true },
  "escalation": { "supervisorFirst": true, "humanAfterMinutes": 30 },
  "limits": { "maxConcurrentReviews": 2 }
}
```

`model` reaches the agent through `--model` for Claude, Codex, Cursor, Antigravity, Grok and
Muse (Orca 1.4.255). Any other agent runs its default model, and the config check warns about it.

Reviewers are read-only. Claude and Codex reviewers are locked down by their own agent (see
Review crew). Matriarch cannot lock down any other agent, so such a reviewer is not started
unless it has `"readOnly": false`. With that set, it runs with your usual permissions for that
agent in the throwaway worktree.

## Architecture

```
            ┌─────────────── Orca desktop ───────────────┐
 you ──▶ Matriarch panel ──▶ engine (plugin worker, always on via status bar item)
            │            │      ├─ forge per project: GitHub (ETag probes; GraphQL list + detail
            │            │      │   on change) or GitLab (GraphQL list each tick; detail on change)
            │            │      ├─ owner index: PR branch → workspace → orchestration dispatch
            │            │      ├─ planner (pure): lane + next actions per PR
            │            │      ├─ ledger (plugin storage): what was done, rounds used
            │            │      └─ executor: orca CLI / gh or glab CLI / notifications
            │            ▼
            │     supervisor agent ── orca orchestration worker-start ──▶ workers (own worktrees)
            │            ▲                                                      │ push + PR
            │            └── escalations (send --to run:<id>) ◀── engine ◀─────┘
            └── review crew: throwaway worktree per PR head, one agent per reviewer
```

- **Engine.** A `trusted-worker` plugin. A contributed status bar item keeps its worker
  running. All its state lives in `orca.storage`, so restarts and reloads lose nothing. It
  never calls an LLM.
- **Supervisor.** An Orca agent started on its own provider and model with a generated brief:
  the role map, exact `worker-start` command templates per tier, and the PR contract below.
  It owns the orchestration Run. The engine raises judgment calls with it through
  `orca orchestration send --to run:<runId> --type escalation`.
- **Workers.** Supervised Orca orchestration workers. A worker must push its branch, open a PR
  that carries the `Matriarch-Task: <taskId>` trailer, and report `worker_done` with the PR
  URL. An `agent.prompt.before` hook appends this contract to every orchestration dispatch
  (phase 4).
- **Feedback.** `orca orchestration send --to dispatch:<id>` works from outside any Run, and a
  finished worker gets the message as a follow-up task.

## PR lifecycle

The planner (`src/plan.ts`) is pure. On each tick it reads the PR snapshot, the owning worker's
activity, the ledger and the config, and returns a lane, a reason and the next actions. It
evaluates in this order:

1. merged / closed / draft
2. merge already requested for this commit → `merging`
3. worker active → `working` (never interrupt a turn)
4. worker waiting for input → `needs-you`, escalated to the supervisor first
5. CI failing (after every check finished) → `fixing-ci`
6. merge conflict → `fixing-conflict`
7. unresolved human or bot review threads, or a human "changes requested" → `fixing-review`
8. CI pending or cancelled → `awaiting-ci`
9. AI review on this commit: not started → start; running → `ai-review`; changes requested → `fixing-review`
10. merge gate → `ready` (manual), or `merging` (auto, one merge at a time per base branch)

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

Code: `src/crew.ts` (rounds), `src/review.ts` (brief, verdicts, aggregation) and `reviewGuard` in
`src/worker.ts`. Rounds start from the planner when autopilot is on, or on demand. On-demand
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
    `cat`/`grep`/`rg`/`ls`, write only `.matriarch/review/**`) and a denylist (push, commit,
    reset, merge, `gh` and `glab` writes, `gh api`, `glab api`, `rm`, web). The denylist also refuses any command that
    reaches outside the worktree: absolute paths (quoted or not, after `=` or `<`), `~`, `$HOME`,
    and `..` out of it. So a reviewer cannot read your files into a verdict that gets posted.
    Also `--setting-sources user`, so a PR's own `.claude/settings.json` cannot widen it while
    Orca's hooks (in your user settings) still run, and `--strict-mcp-config`, so no MCP tools.
    Anything else is refused without a prompt.
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
- **Publishing** (`publish`).
  - `github` (recommended; the name predates GitLab and means "on the PR"): one combined comment
    review per round, with inline comments for findings at or above `blockAt`. On GitLab, one
    merge request note with those findings folded in. Each carries a `<!-- matriarch:... -->` marker so the engine
    can tell its own threads from human ones. It posts as you, so it can only be a comment
    review, never approve or request changes; orchestrator.inc has the same limit.
  - `orca-only`: findings stay in the panel and the worker message.
- **Re-review.** The next round gets the earlier findings plus the diff since the last reviewed
  commit, and checks that each finding was fixed.

## Supervisor (phase 4, launcher built)

`src/supervisor.ts`, and **Open supervisor chat** per repository in the panel.

- **Launch.** The supervisor is a conversation, so it opens as a native Orca chat; if the agent
  has no chat surface, as a terminal session. It uses the configured agent, model and effort, in
  the repository's main checkout, and starts with a brief that tells it to:
  - ask what to build;
  - propose a plan: the tasks, which files each touches, the tier for each;
  - start workers only after the user agrees.

  The brief also contains:
  - the Run to create, tagged `[matriarch:<repo>:<nonce>]`;
  - the exact `worker-start` command per tier;
  - the PR contract every task spec must end with;
  - the instruction to leave reviews and merges to Matriarch.
- **Escalations.** Matriarch finds the Run by its tag (`orchestration run-list`). Escalations then
  go to `run:<id>`, which wakes the supervisor.
- **Not yet run live.** Its workers push branches and open PRs, so the first run should be on a
  task you choose.

## Merging (phase 5)

- **Gate.** All of these must hold:
  - PR open and not a draft;
  - CI passing on the exact head commit;
  - review policy passed on that commit;
  - no unresolved human threads and no human "changes requested";
  - the forge reports it can merge;
  - no file matches `requireHuman`. If the file list was cut short, the gate assumes it does.
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
- **Base branch health (built).** The cheap list query also reads the default branch's CI
  rollup (GitLab: its latest pipeline, when that pipeline is for the branch's head). While it is red, auto merges pause and the supervisor is asked to fix it forward
  (or to find and revert the change, with `onBaseRed: "revert"`).
- **After each merge.**
  - The other PRs are polled again: newly conflicting ones are sent back, clean ones are updated.
  - With `onBaseRed: pause`, the train stops if CI on the base branch goes red. The supervisor
    then fixes forward, or with `revert` Matriarch opens a revert PR (GitHub `revertPullRequest`).
- **Cleanup.** The worker is released and its worktree removed (dirty worktrees are kept); the
  branch is deleted when `deleteBranch` is set.

## Forges: GitHub and GitLab

Code: `src/forge.ts` (the abstraction, each forge's names and agent commands, remote parsing),
`src/github.ts` and `src/gitlab.ts`. Detection is `detectForge` in `src/worker.ts`.

- **One snapshot.** Each forge reads a PR into the same `PrSnapshot`, so the planner never asks
  which one it reads. A merge request carries `forge: "gitlab"`, which only picks the words and
  commands in reasons, messages and briefs (`forgeTerms`).
- **The interface.** A `Forge` reads (`listOpen`, `detail`) and acts (`merge`, `updateBranch`,
  `publishReview`, `failedLogs`), and says which branch updates it can do itself (`updates`). The
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
  2. `forge: { kind: "gitlab", host? }` in `.orca/matriarch.json` (Settings → Forge) makes it GitLab
     on that host, or the origin's: for an ssh alias, or a host glab is not signed in to yet.
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
    branches, `diffHeadSha`, `updatedAt`, author and `headPipeline { status }`;
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
  - Hovering a bar or dot tells why. Clicking a row opens that worktree in Orca.
- **Board.** Cards grouped by lane: Needs you, Fixing, AI review, Working, Awaiting CI,
  Ready / merging, Idle, Merged / closed. In the sidebar the groups stack into one column. A
  card shows:
  - the PR and its worktree, the agent with its model and activity;
  - CI state and failing checks, open comments;
  - the reason for its lane and the rounds used;
  - in dry run, **Would do next**.
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
- **Naming.** Review worktrees are named `Matriarch review · #<n> · <sha>` and linked to their
  PR, so they read as Matriarch's at a glance.
- **Timing.** A reviewer is timed out only when it has been quiet for the whole limit: no
  verdict and no change in its terminal.
  - Change means new output lines, or the same lines redrawn: a thinking agent's timer moves,
    its line count doesn't.
  - Time spent waiting on a person never counts.
  - A round marked failed while its reviewer kept working goes back to running.
  - A verdict that arrives late is still adopted, for 2 hours, while the worktree is kept.

### Data behind it

The engine keeps each worktree's history in plugin storage (`track:<workspaceId>`), pruned to
7 days. The view never polls GitHub itself. It gets the board from the worker after every
tick (`board.changed`), and the board carries the last 24 hours of history.

- **Segments:** a lane plus from/to, recorded each time the planner's lane changes.
- **Marks:** point events.

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

- Dry run is the default (`autopilot` setting off): the board shows what would happen and nothing is sent.
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
- Reviewers are read-only by their own agent's enforcement (see Review crew, Lockdown), so a
  reviewer cannot push, commit or touch another worktree even if this plugin stops answering.
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
  - plugin data: `storage.*`, `settings.*`
- **Events:** `agent.status.changed`, `workspace.created`, `workspace.removed`.
- **Hooks:**
  - `agent.launch.before` (built): reviewers start locked down in their agent's own read-only mode;
  - `agent.tool.before` (built): the second, read-only guard for Claude reviewers;
  - `agent.prompt.before` (phase 4): PR contract.
- **CLI (child processes):**
  - `orca orchestration worker-list | send | run-create | worker-start`
  - `orca worktree create | rm`, `orca agent launch`
  - `gh api graphql`, `gh api -X HEAD -i` (change probes), `gh pr merge | update-branch`
  - `glab auth status --hostname`, `glab api --hostname <host> graphql | projects/…` (see Forges)

The plugin runs `orca`, `gh`, `glab` and `git` with your user's access, so a person approves it as
a full-access plugin. The README lists every command it runs.

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
- **A full disk shows.** Under 10 GB free on the disk with a project, the board's "Needs you" says
  so; a check that fails because the disk is full puts that on the board and the status bar
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

### Still unknown (needs a supervised worker)

1. **Feedback path.** That `orchestration send --to dispatch:<id>` from the plugin worker
   reaches a finished worker as a follow-up task.
2. **Worker list fields.** The per-row field names (`dispatchId`, `resource.worktreeId`)
   with a live worker.
3. **`--effort` per provider.**

## Roadmap

1. **Spike + engine core (this phase):**
   - config, GitHub snapshots, planner, ledger, CLI adapter, board panel;
   - dry run only, unit tests offline.
2. **Fix loops (built, needs a live worker).** CI, conflict and comment messages with
   failed-log excerpts; escalation to the supervisor and to you.
3. **Review crew (built, verified live).**
   - throwaway worktrees, parallel reviewers on their own models, verdict parsing;
   - aggregation by policy, GitHub publishing, the read-only hook;
   - prompt detection, and on-demand rounds.

   - reviewers locked down at launch by their own agent (Claude `dontAsk`, Codex sandbox).

   Not built yet: the arbiter.
4. **Supervisor (launcher built).** The brief, finding its Run, escalations. Next: check each
   worker's agent and model against the config, and run it live on a chosen task.
5. **Merge train (partly built).**
   - built: auto merge pinned to the reviewed commit, branch updates, the base-red pause;
   - next: cleanup after a merge;
   - stacked PRs and merge queues;
   - polish, then publish to the community catalog.
