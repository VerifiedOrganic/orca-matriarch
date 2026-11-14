# Matriarch

<img src="docs/sidebar.png" width="400" align="right" alt="Matriarch's sidebar: a running supervisor, PR counts by state, and a timeline with one row per worktree or PR.">

A supervisor for your pod of coding agents in [Orca](https://www.onorca.dev). You tell a
supervisor agent what to build; it plans the work and starts workers, each in its own worktree,
on the agents and models you picked. Matriarch then drives every PR they open (a merge request,
on GitLab) through CI, review comments, conflicts, an AI review by a crew of reviewers on several
providers, fixes, and merge, and shows all of it on one timeline. Projects can be on GitHub or,
**experimentally**, on gitlab.com or a GitLab of your own (see [Known limitations](#known-limitations)).

It starts in **dry run**: it reads and shows what it would do, and acts only once you turn on
autopilot. [Dry run and autopilot](#dry-run-and-autopilot) lists what runs in each.

<br clear="right">

## How a PR moves

1. **Plan.** You describe the work in the project's supervisor chat. The supervisor shows you a
   plan, and once you agree it creates tasks and starts a worker for each, in its own worktree.
   A [labeled issue](#issues-as-objectives) can hand it an objective too; the label is the
   go-ahead, so that plan does not wait for you.
2. **Build.** Workers push branches and open PRs.
3. **CI, comments, conflicts.** A failing check, an unresolved review comment or a conflict goes
   back to the worker that owns the branch, with the details. A check that failed on the
   infrastructure rather than the code is [run again once](#flaky-checks) first. A branch that
   falls behind its base is updated.
4. **AI review.** When CI passes, a review crew reads the PR in a throwaway worktree: several
   reviewers, each on its own agent and model, each with its own focus. Their verdicts are
   combined by your rule (every must-approve reviewer approves, a majority, or no blockers).
   Findings go to the worker; later rounds check only what changed. A PR that changes only docs
   gets a [lighter review](#light-review).
5. **Merge.** Matriarch marks the PR ready for you to merge, or merges the reviewed commit itself
   if the project allows it. A PR [stacked](#stacked-prs) on another of yours waits for that one.

Anything that needs a decision goes to the supervisor first, then to you if it is not settled
after a while (30 minutes by default). The supervisor can ask an [advisor](#advisor) for a second
opinion. Matriarch never answers an agent's permission prompt for you: those show as **Needs you**.

## Requirements

- Orca **1.4.257** or newer, with orchestration turned on (Settings → Experimental), so the
  supervisor can start and message workers.
- For projects on GitHub: the GitHub CLI, `gh`, signed in. Only github.com (not GitHub Enterprise).
- **Experimental:** for projects on GitLab, gitlab.com or self-hosted: the GitLab CLI, `glab`,
  signed in to that host (`glab auth login --hostname <host>`). glab keeps the token; Matriarch
  never sees it.
- The agents you want to use, installed and signed in. Any agent Orca can start works as the
  supervisor or a worker; reviewers and the advisor start read-only only on **Claude Code** and
  **Codex**.
  - Orca starts a worker on the thinking level you pick for Claude Code, Codex, Cursor,
    Antigravity, Grok, Muse and **Oh My Pi**. OpenCode workers get the model you pick but run at
    OpenCode's own default thinking level until Orca can pass one
    ([orca#19980](https://github.com/stablyai/orca/issues/19980)). For DeepSeek, Ollama or another
    provider at a chosen thinking level, use Oh My Pi.
- `git`, and `sqlite3` to read your Orca settings (macOS includes it).

Matriarch has been run on macOS. It should work wherever Orca and these tools do, but Linux and
Windows are untested.

## Install

**From GitHub:**

```sh
orca plugin install VerifiedOrganic/orca-matriarch
```

Orca installs the newest version tag, or `main` while there is none, pinned to that commit. It
shows what Matriarch asks for (see [Permissions](#permissions)) and asks you to approve it.
Matriarch is not in Orca's plugin directory yet.

**From a clone,** to change it: see [Develop](#develop).

## Get started

1. Open the **Matriarch** panel in the right sidebar, or run **Matriarch: Show board**.
2. Click **+ Add project**, then **Turn on** for a project open in Orca. Its origin must be on
   github.com, or on a GitLab host glab is signed in to, and it needs at least one commit; the
   list says when it does not, and what to run.
3. In **Settings**, under **Who does the work**, pick the agent, model and thinking level for the
   supervisor, the workers (plus any worker tiers, such as a cheaper one for small tasks), each
   reviewer and, if you want one, the advisor. Then **Save**. The agents offered are the ones
   turned on in your Orca settings and installed; the model box searches the models each agent
   offers you now.
4. Click **Open supervisor chat** and tell it what to build.
5. Watch the timeline in dry run. When you are happy with what it would do, **Turn on autopilot**.

Matriarch finds the forge from the project's origin. For a GitLab behind an ssh alias, or one glab
is not signed in to yet, pick it in Settings under **Project → Where it lives**.

A project's settings are saved in its `.orca/matriarch.json`, so you can commit them to share with
your team. Nobody has to edit that file: every project setting is in **Settings**, and
[DESIGN.md](DESIGN.md#roles-and-config) shows its fields. Two kinds of setting are not in it:
autopilot and the poll interval (default 45 seconds) are Orca plugin settings, and
[away alerts](#away-alerts) belong to this machine. **Turn Matriarch off here**, at the bottom of
Settings, keeps a project's settings for later.

Matriarch manages only PRs you opened from a branch that belongs to an Orca workspace.

<img src="docs/picker.png" width="400" alt="Settings: picking a worker's model on OpenCode, with the list filtered as you type and grouped by provider.">

## What you see

![The board: PR cards grouped by state, each with its agent and model, CI, rounds used, and what dry run would do next.](docs/board.png)

- **Projects:** a chip per project, **All** for every project on one timeline, and **+ Add
  project**. The panel follows the workspace you focus in Orca.
- **Timeline:** one row per worktree or PR, colored by state: working, awaiting CI, fixing, AI
  review, needs you, ready, merged. Dots mark pushes, messages, reviews, escalations and merges.
  Worktrees with no PR and nothing running fold into one line.
- **Board:** cards by state with the agent and model, CI, comments and rounds used, and in dry
  run what Matriarch would do next. **Run AI review now** on any card runs the crew on that
  commit, in dry run too.
- **What Matriarch did:** click a timeline row, or open **What Matriarch did** on a card, for
  that PR's log, newest first: each lane it entered and why, new commits, finished reviews, and
  every message it sent (to the worker, the supervisor or you, with its subject), branch update,
  merge and cleanup, including what failed and why. It holds only what Matriarch did; dry run's
  plans stay in **Would do next**. An action that fails on every poll is one line with a count
  (`×12, last 14:05`), and each PR keeps its own log. Kept for a week.
- **Supervisor:** each project's chat, with the Run it coordinates, how many of its workers are
  running against the project's limit, the labeled issues it took or that wait, and its advisor:
  the question it is answering, or the last one it answered.
- **Needs you:** a reviewer or advisor waiting on a prompt, an escalation that reached you, a PR
  that needs your merge, a nearly full disk, a supervisor over its worker limits. The status bar
  shows the same at a glance, and [away alerts](#away-alerts) can carry the first three to you
  away from Orca.
- **Full tab:** tab bar **+** → **Matriarch board**.

## Options

Each of these has a default that suits most projects, and a setting that turns it off.

### Advisor

A project can have an advisor above the supervisor, on its own agent, model and thinking level
(Claude on Fable at max, say). The supervisor asks it for a second opinion when it chooses to: a
risky plan, a reviewer and a worker who disagree, being stuck, a step that is hard to undo. It
sees only what the supervisor sends it.

- **Setting:** the **Advisor** card under **Who does the work**, **Use an advisor**. Off by
  default.
- **How it runs:** Matriarch starts it read-only in a throwaway worktree of the default branch,
  locked down like a reviewer, and mails its answer back to the supervisor's chat. Then the
  worktree is removed. Only Claude Code and Codex start read-only; any other agent is refused
  unless you mark it **Run it without the read-only lockdown**.
- **One at a time:** one question per project, up to 10 waiting. One that gets no answer (quiet
  for 30 minutes, or running over 2 hours) is ended, and the supervisor is told.
- **Who may ask:** only the supervisor Matriarch opened with **Open supervisor chat**. Anything
  else that reaches Matriarch's mailbox is dropped, and the board counts what was dropped. A
  supervisor chat you start by hand is not offered the advisor at all, since Matriarch could not
  tell its questions from anyone else's; the board says so. A follow-up is a new `Advice:`
  message; a reply to an answer is read and not answered again.
- **When:** answers only with autopilot on. In dry run questions wait, and the board says so.
- **Cost:** nothing until the supervisor asks, then one agent session per question.

### Issues as objectives

Turn on **Hand labeled issues to the supervisor** under **Settings → Issues**, then label an open
issue `matriarch` (or the label you pick there). With autopilot on, Matriarch hands it to the
running supervisor as a new objective, and the PR that does it says `Closes #<n>`.

- **The label is the go-ahead.** The supervisor posts its plan in its chat and starts the work
  without waiting for you to agree, so label only issues you would give an agent to do. Each time
  the label is added counts once: to hand an issue over again, remove the label and add it back.
- **Who can hand work over:** an issue goes over only when the label was last added by a person,
  not a bot, with triage access (GitHub: a collaborator whose role is triage, write, maintain or
  admin) or Reporter and above (GitLab, counting group membership), and its title and text were
  not edited after that. So a label an issue template adds counts only if the issue's author has
  that access, and an issue its author edits after you labeled it waits; an edit after the
  handoff changes nothing. An issue that fails this stays on the board with the reason until
  someone with access adds the label again. The issue's title and text go to the supervisor as
  written, fenced and marked as the issue's, not yours.
- **Timing:** the labeled issues are read every 5 minutes, so a newly labeled issue goes over
  within about that; at most 5 are handed over per poll, and Matriarch reads up to 500, oldest
  first (the board says when there are more). With no supervisor running, **Needs you** says the
  issue waits for one; in dry run the board says it would hand it over. If Matriarch is cut off
  while handing an issue over, the board says it may not have arrived, and it is not sent again
  by itself.
- **Comment on the issue** (off by default) posts one short comment, as you, right after
  Matriarch hands the issue over.
- **Label names:** without commas, up to 100 characters. `any`, `none` and `no label` are
  refused, since GitLab reads them as filters.

### Stacked PRs

A PR stacked on another of yours (its base is that PR's branch) goes through CI and review as
usual but waits at the merge step until its parent has merged. Then:

1. it is moved onto the branch its parent merged into, if the forge left it on the parent's
   branch;
2. unless that branch kept the parent's commits as they were (a merge commit or a fast-forward),
   its worker is asked to rebase it off them, and it waits for that push;
3. it merges like any other PR: marked ready for you, or merged by Matriarch when the project
   lets it.

If the parent closes without merging, the PR needs you. There is no switch: Matriarch never
merges a PR into the branch of another PR of yours that it follows. Some PRs are never parents,
so PRs into their branch merge there as they ask: one from the default branch, a long-lived
branch (develop, `release/*`, a version, …) or a fork, and one Matriarch does not follow
(someone else's, or one with no worktree here). When the forge lists more open PRs than Matriarch
reads, a PR into a branch with a worktree here may be stacked on one left out, so it waits for
you instead of merging.

### Flaky checks

A check that failed on the infrastructure rather than the code is run again once, on that
commit, before its failure goes to the worker. That is a runner that went away, one of GitLab's
own failure reasons around a job, a package registry or git remote out of reach, or a container
registry or GitHub API rate limit, each read from the error line its tool prints.

- **Setting:** **Re-run flaky checks once** under **Fixes and escalation**. On by default.
- **What it covers:** GitHub Actions jobs and GitLab jobs. A check another app posts (CircleCI,
  Buildkite) is never re-run. Several flaky jobs of one GitHub workflow run go again together,
  which re-runs that run's other failed jobs too.
- **Once:** a second failure, or a re-run the forge refuses, goes to the worker as usual.

### Light review

A PR that changes only docs gets a lighter AI review.

- **Settings:** **Light changes** under **Review** (default `**/*.md`, `**/*.rst`, `**/*.adoc`)
  and **A light change gets**: one reviewer (the first that must approve), or no AI review.
  Leave **Light changes** empty to review every PR in full.
- **Always the full crew:** what steers an agent once merged, even when it matches, in any case
  (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `CONVENTIONS.md`, `*.prompt.md`,
  `copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.aider*`, and
  anything in a `.claude`, `.cursor`, `.github`, `.agents`, `.codex`, `.omp`, `.opencode`,
  `.orca`, `.gemini`, `.windsurf`, `.continue`, `.roo`, `.kiro`, `.junie` or `.clinerules`
  folder; `claude.md` counts as `CLAUDE.md`, as it does on a Mac's disk); a PR that renames or copies a file, or whose old paths
  are not light; a file list the forge cut short. GitLab's file list does not say what was
  renamed, so a merge request that looks light is read file by file, once per commit, and gets
  the full crew when that read fails.
- A round already on the commit (running, or asking for changes) still decides, and **Run AI
  review now** always runs the full crew.

### Away alerts

What reaches you in Orca's notifications can also go to a webhook, so you hear about it away from
your desk. Open **Alerts** (next to **+ Add project**), paste the webhook URL, pick what to send,
and **Send a test**. It applies to every project, on this machine; **Remove** turns it off.

- **Where:** a Slack incoming webhook, a Discord channel webhook, ntfy (ntfy.sh, or your own
  server: pick **ntfy** by hand), or any URL that takes a JSON POST with `kind`, `title`, `body`,
  `repo`, `number` and `url`. Slack, Discord and ntfy.sh are told apart by their address. A server
  that wants a password can take it in the URL (`https://user:pass@ntfy.example.com/topic`): it is
  sent as a Basic `Authorization` header and never shown. `http://` is accepted for a server on
  your network.
- **What:** **Needs you** (an escalation that reached you, a reviewer or advisor stuck on a
  prompt, a PR that needs your merge or is blocked) and **Ready to merge** are on by default, and
  go alongside Orca's own notification. **Merged** (a PR Matriarch follows merged, by it or by
  anyone) is off by default and goes to the webhook only: Orca has no notification for it. A
  nearly full disk and a supervisor over its limits stay on the board.
- **When:** while autopilot is on, like everything else Matriarch sends. In dry run only a
  reviewer stuck on a prompt (in a review you started) is sent, as Orca notifies you of it too.
- **How:** each alert is posted once, with a 10-second limit, and never retried or redirected.
  Four go at a time and twenty more wait their turn; past that, the rest go as one "and N more"
  post. A post that fails shows on the Alerts page, without blocking anything else.
- **The URL is a secret:** anyone who has a Slack or Discord webhook URL can post to that channel.
  Matriarch keeps it in Orca's encrypted secrets (your OS key store), not in plugin storage or a
  project's settings, and shows and logs only its host. Where Orca has no OS key store, it does
  not keep one.

## Cost and limits

Matriarch runs agents on **your** accounts, and each one uses your plan or API credit: the
supervisor chat, one worker per task, every reviewer on every review round, the fix rounds after
it, and the advisor's answers. A PR that needs several rounds costs several reviews. To keep it in
hand:

- choose cheaper models for worker tiers and for some reviewers;
- **Review rounds per PR** (default 3) caps the rounds before it asks someone instead;
- later rounds check only what changed (**Later rounds**: check the fixes);
- reviewers on the same agent as the PR's author sit it out (**Skip the author's agent**);
- a PR that changes only docs gets a [lighter review](#light-review);
- **Reviews at once** (default 2) limits how many review crews run together in a project;
- the worker and disk limits below cap what the supervisor starts.

When a reviewer's account hits its usage limit, Matriarch can restart it once on a
**Usage-limit fallback** model you choose; otherwise it shows the reviewer as **Needs you**.

### Worker and disk limits

Under **Settings → Limits**: **Workers at once** (default 4), **Worker starts a day** (counted from
midnight, default no limit) and **Disk floor** (default 10 GB: below it no new worker starts, and
**Needs you** says the disk is nearly full). 0 turns each off. The supervisor's brief states them,
and a running supervisor is told when you change them. They are held two ways:

- **Before a start,** when the supervisor or one of its workers is Claude Code in a terminal: its
  worker start (`orca orchestration worker-start` or `dispatch`, or `orca agent launch`) over a
  limit is refused, with what to do instead (wait for a worker to finish, for tomorrow, or for
  space). A command that starts workers in a loop is refused while a count limit is set, since
  how many it starts cannot be known. This holds in dry run too. Orca honours this refusal only
  for Claude Code, and reports no tool calls at all for an agent in a chat, which is how the
  supervisor opens.
- **Right after a start,** for every other case: with autopilot on, a worker whose start put the
  project over a limit is stopped (`orca orchestration worker-stop`) on the next poll, and the
  supervisor is told to start it again when there is room. Its worktree is kept for that task:
  the finished-worktree cleanup leaves it until a newer worker has run there, or for a week. In
  dry run the board says it would.

Only a start is judged. Workers already running when Matriarch first looks, or when you lower a
limit, are never stopped; **Needs you** says the project is over instead. Your own sessions are
never judged. These limits keep cost and disk in hand; they are not a security boundary.

## Dry run and autopilot

Dry run is the default. Turning autopilot on takes a second, confirming click, and **Pause
autopilot** (or **Matriarch: Turn autopilot on or off**) stops it at once, even in the middle of
a poll.

**In dry run too,** Matriarch:

- reads your PRs, their checks and review threads, failed jobs' logs and annotations (to tell a
  flaky failure from a real one), whether a merged parent's commits are on its base, a GitLab
  merge request's file moves, and the labeled issues with who labeled them;
- shows on each card what it would do next;
- runs an AI review when you click **Run AI review now**, and notifies you (in Orca and by
  webhook) of a reviewer stuck on a prompt in it;
- refuses a worker start over a limit, from a supervisor or worker that is Claude Code in a
  terminal;
- tells a running supervisor what you changed in Settings: the worker settings, the limits, the
  advisor turned on, changed or off, and that Matriarch was turned off for the project (with
  any questions that were waiting). Those notices only say how Matriarch is set up, and you made
  the change, so they go whatever autopilot says;
- keeps the supervisor's questions to the advisor, read from its mailbox, until autopilot is on.

**Only with autopilot on,** Matriarch:

- sends CI failures, comments, AI findings, rebase and update requests to workers, and
  escalations to the supervisor and to you;
- starts automatic AI reviews and posts them on the PR (when **Where reviews go** says so);
- updates branches, moves stacked PRs onto their new base, re-runs flaky checks, and merges (when
  the project lets it);
- stops workers that started over a limit;
- hands labeled issues to the supervisor and comments on them;
- runs the advisor and mails its answers;
- removes merged and finished worktrees;
- sends away alerts, except the one above.

A project whose settings have errors is only watched, autopilot or not, until they are fixed.

## Permissions

Matriarch is a **full-access** plugin (`trusted-worker`): its worker runs as you, on your
machine, so Orca asks you to approve it on install. It needs that to run `git`, `gh`, `glab` and
`orca`, start agents and read their state. It asks Orca for these capabilities:

- **Read workspaces** (`workspace:read`): lists your projects and worktrees, finds the workspace
  you have focused, and hears when workspaces are created or removed.
- **Open workspaces** (`workspace:write`): opens a project or a worktree when you click it, and
  runs Orca's own command to show the sidebar.
- **Read agents** (`agent:read`): which agents are running, working or waiting, in which
  workspace.
- **Show notifications** (`notifications:show`): tells you when something needs you while Orca
  is in the background.
- **Own storage** (`storage:own`): each PR's history, activity log and review state, the alert
  settings (but not the URL), the worker and start counts behind the limits, and which issues it
  handed over, in the plugin's own storage.
- **Own settings** (`settings:own`): autopilot on or off, and how often it checks GitHub and GitLab.
- **Own secrets** (`secrets:own`): the [away-alert](#away-alerts) webhook URL, when you set one, in
  Orca's encrypted secrets.

It also adds two **hooks**:

- **Before an agent launches** (`agent.launch.before`): a reviewer's or the advisor's command is
  rewritten so it starts read-only, whatever permission mode you chose in Orca. Every other
  launch passes unchanged.
  - Claude Code: `--dangerously-skip-permissions` and any other permission mode are removed, and
    `--permission-mode dontAsk` is set with an allowlist (read and search inside the worktree,
    read-only `git` and shell commands, and writing only its own notes under
    `.matriarch/review/`) and a denylist (paths outside the worktree, `git push`/`commit`, `gh`
    and `glab` writes, `gh api`, `glab api`, `rm`, web fetches, and flags that run a program),
    plus `--setting-sources user --strict-mcp-config`.
  - Codex: the bypass flags are removed and it runs with `--sandbox workspace-write
    --ask-for-approval never`, no network, no extra writable folders and no MCP servers.
  - Any other agent is refused as a reviewer or advisor unless you mark it **Run it without the
    read-only lockdown**.
- **Before an agent uses a tool** (`agent.tool.before`):
  - in a review or advisor worktree, a tool call that would write outside its notes, or run a
    command that is not read-only, is blocked;
  - a worker start over the project's [limits](#worker-and-disk-limits), from the supervisor's
    own terminal or one of its workers', is refused (Claude Code only).

  Your own sessions are never judged.

A reviewer that did not start locked down is stopped and started again, or shown as failed; an
advisor is stopped and the supervisor is told there is no answer.

## What it runs on your machine

It never passes `--admin` and never bypasses branch protection or GitLab's merge checks.

### Orca and git

| Command | When |
|---|---|
| `git -C <workspace> rev-parse …`, `git config --get remote.origin.url` | find the repository behind each workspace, and whether it has a commit yet |
| `orca repo list` | **+ Add project**: the projects open in Orca |
| `git -C <root> symbolic-ref --short refs/remotes/origin/HEAD` | **Open supervisor chat**: the branch PRs target |
| `orca agent launch --surface chat …` | **Open supervisor chat**: the supervisor, on your model, with its brief |
| `orca terminal create` | once per project: a terminal titled "Matriarch mailbox" (`cat > /dev/null`), which Orca requires as the sender of Matriarch's messages |
| `orca terminal list`, `orca terminal show` | tell two projects' checkouts apart when both are "main" |
| `orca terminal switch` | **Open it** under Needs you, and the status bar item: bring that terminal to the front |
| `orca orchestration worker-list --full`, `run-list` | find the worker that owns each branch, and the supervisor's Run |
| `orca orchestration send --from <mailbox>` | autopilot: CI failures, comments, AI findings and update requests to a worker; escalations, labeled issues, stopped workers and the advisor's answers to the supervisor |
| `orca orchestration check --terminal <mailbox> --peek --full`, then `check --terminal <mailbox> --full` | with an advisor: read the questions sent to Matriarch's mailbox, with their senders, then mark them read |
| `orca orchestration run-show --id <run> --full` | with an advisor, when a question came: the handle the supervisor's Run is bound to, to tell its questions from anyone else's |
| `orca orchestration worker-stop --dispatch <id>` | autopilot: stop a supervisor's worker that started over the project's worker limits (its worktree is kept) |
| `git fetch origin …`, `orca worktree create`, `orca worktree set`, `orca agent launch --model …`, `orca worktree rm` | a review round: a throwaway worktree at the PR head, named for it in Orca's sidebar, one agent per reviewer, removed afterwards |
| `git fetch origin <default branch>`, `orca worktree create`, `orca worktree set`, `orca agent launch --model …`, `orca worktree rm` | autopilot, with an advisor: one throwaway worktree of the default branch per question, the advisor in it, removed once it answers |
| `orca terminal read` | a reviewer or the advisor: whether it waits on a prompt, or came back without its lockdown |
| `orca terminal close` | a reviewer or advisor that started without its lockdown is stopped |
| `orca worktree set --unread --comment` | a reviewer stuck on a prompt: mark its worktree in Orca's sidebar, with why |
| `git -C <worktree> status --porcelain`, `symbolic-ref -q HEAD`, `rev-list --count HEAD --not --remotes`, `orca worktree rm` | autopilot: remove a merged PR's worktree (and its branch) when nothing runs there and nothing is uncommitted, or a finished worktree that never became a PR when nothing in it is uncommitted or unpushed |
| `sqlite3 'file:…?mode=ro'` | read your Orca settings ([below](#what-it-reads-from-orcas-own-files)), read-only |
| `opencode api model.list` (or `opencode models`), `omp models ls --json` | **Settings**: the models OpenCode and Oh My Pi offer you now |
| `orca --version` | **Settings**: say when this Orca is not the one Matriarch was tested with |

### GitHub

| Command | When |
|---|---|
| `gh api -X HEAD -i -H 'If-None-Match: …'` | each poll: ask GitHub whether PRs, the default branch or followed checks changed (free when nothing did) |
| `gh api graphql` | read open PRs, CI checks and review threads, when something changed |
| `gh api repos/<repo>/actions/jobs/<id>/logs` | autopilot: the tail of a failed job's log, for the worker |
| `gh api repos/<repo>/check-runs/<id>/annotations`, `…/actions/jobs/<id>/logs` | once per failed check and commit: whether it failed on the infrastructure rather than the code |
| `gh api -X POST repos/<repo>/actions/jobs/<id>/rerun`, `…/actions/runs/<id>/rerun-failed-jobs` | autopilot: re-run, once, a job that failed on the infrastructure (several of one workflow run together) |
| `gh api repos/<repo>/pulls/<n>/reviews` | autopilot, when **Where reviews go** includes the PR: one comment review per round |
| `gh pr update-branch` | autopilot: update a branch that is behind its base |
| `gh api repos/<repo>/compare/<sha>...<branch>` | once when a stacked PR's parent merged: whether the base kept the commit the PR was built on |
| `gh pr edit <n> --base <branch>` | autopilot: move a stacked PR to where its parent merged, when GitHub left it on the parent's branch |
| `gh pr merge --match-head-commit <sha>` | autopilot, when the project lets Matriarch merge: merge exactly the reviewed commit |
| `gh api repos/<repo>/issues?state=open&labels=<label>&page=<n>` | with **Issues** on, every 5 minutes: the open issues with the label |
| `gh api graphql` (an issue's label and title events and last edit), `gh api repos/<repo>/collaborators/<login>/permission` | with **Issues** on, once per new or changed labeled issue: who added the label, and whether it changed since |
| `gh api -X POST repos/<repo>/issues/<n>/comments` | autopilot, with **Comment on the issue**: one comment when Matriarch hands an issue over |

### GitLab

| Command | When |
|---|---|
| `glab auth status --hostname <host>` | an origin on a host other than github.com: whether it is a GitLab glab is signed in to (only the exit code is read) |
| `glab api --hostname <host> graphql` | each poll: the open merge requests with their pipeline status and the default branch's; a merge request's jobs, threads, files and approvals when it changed |
| `glab api --hostname <host> projects/<project>/merge_requests/<n>` | only while GitLab has not worked out whether a merge request can merge, which this read asks it to |
| `glab api --hostname <host> projects/<project>/jobs/<id>/trace` | autopilot: the tail of a failed job's log, for the worker |
| `glab api --hostname <host> projects/<project>/jobs/<id>`, `…/trace` | once per failed job and commit: its failure reason and log, whether it failed on the infrastructure |
| `glab api --hostname <host> -X POST …/jobs/<id>/retry` | autopilot: retry, once, a job that failed on the infrastructure |
| `glab api --hostname <host> -i …/merge_requests/<n>/diffs?per_page=100&page=<p>` | once per commit, only for a merge request whose files all look light: which files it renamed, and their old paths (`…/changes` on a GitLab older than 15.7) |
| `glab api --hostname <host> -X POST …/merge_requests/<n>/notes` | autopilot, when **Where reviews go** includes the PR: one note per round |
| `glab api --hostname <host> -X PUT …/merge_requests/<n>/rebase` | autopilot: rebase a merge request that is behind its base |
| `glab api --hostname <host> …/repository/merge_base?refs[]=<sha>&refs[]=<branch>` | once when a stacked merge request's parent merged: whether the base kept the commit it was built on |
| `glab api --hostname <host> -X PUT …/merge_requests/<n> -f target_branch=<branch>` | autopilot: move a stacked merge request to where its parent merged |
| `glab api --hostname <host> -X PUT …/merge_requests/<n>/merge -f sha=<sha>` | autopilot, when the project lets Matriarch merge: merge exactly the reviewed commit |
| `glab api --hostname <host> projects/<project>/issues?state=opened&labels=<label>&page=<n>` | with **Issues** on, every 5 minutes: the open issues with the label |
| `glab api --hostname <host> …/issues/<n>/resource_label_events`, `…/members/all/<id>`, `users/<id>`, `graphql` (its last edit) | with **Issues** on, once per new or changed labeled issue: who added the label, whether they are a bot, and whether it changed since |
| `glab api --hostname <host> -X POST …/issues/<n>/notes` | autopilot, with **Comment on the issue**: one note when Matriarch hands an issue over |

### What it reads from Orca's own files

Orca's plugin API does not yet tell plugins which agents you turned off, the commands you set for
them, the workspace you focused, or the models each agent offers. Matriarch reads these from
Orca's data folder, read-only, and nothing else in it:

- `orca-profile-index.json`: which profile is active.
- `profiles/<id>/profile-state.db`: three fields, `disabledTuiAgents`, `agentCmdOverrides` and
  the focused workspace.
- `agent-model-catalog.db`: the models Orca discovered for each agent.

These are Orca's internal files and may change in a later Orca. When Matriarch cannot read them,
**Settings** says so and it falls back: every installed agent is offered, and a model id can be
typed. [docs/orca-api-requests.md](docs/orca-api-requests.md) lists the plugin APIs that would
replace them, and Matriarch's other workarounds.

### Network and data

Matriarch talks to the network only through `gh`, to GitHub, and `glab`, to the GitLab hosts your
projects are on, and, when you set one, to your [away-alert](#away-alerts) webhook, which the
plugin posts to directly: the title and text of each alert you switched on, with the PR's
project, number and link. It sends nothing anywhere else and has no telemetry.

Each PR's history and review state stay in the plugin's own storage on your machine, the webhook
URL in Orca's encrypted secrets, and each project's settings in its `.orca/matriarch.json`.
Reviewers' notes and the advisor's answers are written in their throwaway worktree and removed
with it. No issue text is stored.

## Known limitations

- GitHub (github.com) and GitLab (gitlab.com or self-hosted), and only PRs you opened from an Orca
  workspace's branch.
- On GitLab (**experimental**):
  - every poll reads the open merge requests: GitLab has no free "nothing changed" answer, and
    counts a 304 against its rate limit like any request;
  - **Merge method** decides only whether to squash; the project's merge method in GitLab decides
    the rest;
  - GitLab cannot merge the base into a branch for Matriarch, so with **merge the base into it**
    the worker is asked to;
  - threads you start yourself count as notes to yourself, not as review feedback;
  - reading merge requests was checked against gitlab.com's API. Merging, rebasing, notes and
    approvals have not been run on a real project yet, nor anything on a self-hosted GitLab
    (which needs one recent enough to have the GraphQL fields Matriarch reads; DESIGN.md lists
    them). Nor have the GitLab calls of the options above: the issue list and label checks,
    merge request diffs, moving a merge request's target branch, job retries and merge bases.
- The [options](#options) and the [worker and disk limits](#worker-and-disk-limits) are new: so
  far they have run only in Matriarch's tests, against stand-ins for Orca, GitHub and GitLab, not
  on a real project or a live Orca. The advisor's mailbox, and how Orca names the sender of a
  question, depend most on Orca's behaving as its 1.4.257 source reads.
- The advisor answers only the supervisor's questions by matching the address Orca stored for
  the sender. Orca does not authenticate senders, so another agent on your machine that learned
  the supervisor's address could ask as it; see [SECURITY.md](SECURITY.md) for what that allows.
- Read-only reviewers and advisor on Claude Code and Codex only.
- The worker-start refusal works only for Claude Code in a terminal; every other case relies on
  stopping the worker after it started.
- It relies on Orca's orchestration behaving as it does in 1.4.257, and on the files above.
  Settings says when you run a different Orca.
- Orca tells plugins only a workspace's name and branch, so when two projects' own checkouts are
  both "main" with no terminal open, the panel asks you to pick the project.

## Develop

```sh
pnpm install            # TypeScript, and Node's typings
pnpm types              # Orca's plugin typings, into .orca/ (from Orca, or from GitHub without it)
pnpm verify             # typecheck, orca plugin test, orca plugin validate, binary check
pnpm preview            # the panel with sample data at http://127.0.0.1:8765
orca plugin dev load .  # run it in Orca; it reloads as you edit
```

The repository root is the plugin, and Orca installs every tracked file in it. `node_modules`
is flat with no symlinks (`pnpm-workspace.yaml`), because Orca refuses to load a folder that
holds one. [DESIGN.md](DESIGN.md) explains how it works and why.

CI runs the same checks on every push and pull request, with the Orca CLI from the Linux package
of the Orca in `config.orcaVersion`. Every Monday it runs them on Orca's newest release too, and
the Actions tab can run both by hand.

## Releasing

1. Raise `version` in `orca-plugin.json` and `PLUGIN_VERSION` in `src/worker.ts` (a test keeps
   them equal), and add the version to `CHANGELOG.md`. When moving to a newer Orca, raise
   `config.orcaVersion` in `package.json`, `TESTED_ORCA` and `engines.orca` together, and set
   `config.orcaDebSha512` to the sha512 that release's `latest-linux.yml` gives
   `orca-ide_<version>_amd64.deb` (`gh release download v<version> -R stablyai/orca -p
   latest-linux.yml -O -`).
2. `pnpm verify`, then commit.
3. Tag the commit and push the tag:

   ```sh
   git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0
   ```

Orca's plugin directory lists a repository with the `orca-plugin` topic at its newest `vX.Y.Z`
tag, pinned to its commit and file hash. This one has no topic yet, so it is not listed. Once it
is, a listed version never changes, and its tag cannot be moved.

### Screenshots and listing art

`docs/*.png` and `assets/screenshot-1.png`, `-2.png` are the panel drawn by `pnpm preview` with
`?clean=1` (no sample warnings): `?width=400` for the sidebar, `?view=board`, `?page=all`,
`?page=settings`. `assets/icon.png` (256×256), `assets/cover.png` (1600×1000) and
`assets/screenshot-3.png` (1280×800) are drawn from `art/*.html`: open each at that size and save
it as PNG. The plugin page shows only the middle band of the cover (about y 380 to 620), so the
name and tagline stay inside it.

## License

[MIT](LICENSE)
