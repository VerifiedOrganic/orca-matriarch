# Matriarch

<img src="docs/sidebar.png" width="400" align="right" alt="Matriarch's sidebar: a running supervisor, PR counts by state, and a timeline with one row per worktree or PR.">

A supervisor for your pod of coding agents in [Orca](https://www.onorca.dev). You tell a
supervisor agent what to build; it plans the work and starts workers, each in its own worktree,
on the agents and models you picked. Matriarch then drives every PR they open (a merge request,
on GitLab) through CI, review comments, conflicts, an AI review by a crew of reviewers on several
providers, fixes, and merge, and shows all of it on one timeline. Projects can be on GitHub or,
**experimentally**, on gitlab.com or a GitLab of your own (see [Limits](#limits)).

It starts in **dry run**: it watches and shows what it would do until you turn on autopilot.

<br clear="right">

## How a PR moves

1. **Plan.** You describe the work in the project's supervisor chat. The supervisor shows you a
   plan, and once you agree it creates tasks and starts a worker for each, in its own worktree.
2. **Build.** Workers push branches and open PRs.
3. **CI, comments, conflicts.** A failing check, an unresolved review comment or a conflict goes
   back to the worker that owns the branch, with the details. A check that failed on the
   infrastructure (its runner went away, a registry or git remote was out of reach) is re-run
   once first. A branch that
   falls behind its base is updated.
4. **AI review.** When CI passes, a review crew reads the PR in a throwaway worktree: several
   reviewers, each on its own agent and model, each with its own focus. Their verdicts are combined
   by your rule (every must-approve reviewer approves, a majority, or no blockers). Findings go to
   the worker; later rounds check only what changed.
5. **Merge.** Matriarch marks the PR ready for you to merge, or merges the reviewed commit itself
   if the project allows it.

A PR **stacked** on another of yours, whose base is that PR's feature branch, goes through CI and
review as usual but waits to merge until its parent has. Then it is moved to where its parent
merged (when the forge left it on the parent's branch) and, unless the base kept the parent's
commits as they were, its worker is asked to rebase it off them; it merges once that is pushed. If
the parent closes without merging, it needs you. A PR into the default branch, a long-lived branch
(develop, `release/*`, …) or a fork's branch is never held this way.

Anything that needs a decision goes to the supervisor first, then to you after a while. The
supervisor is told to keep the run moving without you, and Matriarch never answers an agent's
permission prompt for you: those show as **Needs you**.

**Advisor (optional).** A project can have an advisor above the supervisor, on its own agent and
model (Claude on Fable at max effort, say). The supervisor asks it for a second opinion when it
chooses to: a risky plan, a reviewer and a worker who disagree, being stuck, a step that is hard
to undo. Matriarch runs it read-only in a throwaway worktree of the main branch, locked down like
a reviewer, and mails its answer back to the supervisor's chat. It answers one question at a time,
only with autopilot on, and costs nothing until the supervisor asks.

## Requirements

- Orca **1.4.257** or newer, with orchestration turned on (Settings → Experimental), so the
  supervisor can start and message workers.
- For projects on GitHub: the GitHub CLI, `gh`, signed in. Only github.com (not GitHub Enterprise).
- **Experimental:** for projects on GitLab, gitlab.com or self-hosted: the GitLab CLI, `glab`, signed in to that
  host (`glab auth login --hostname <host>`). glab keeps the token; Matriarch never sees it.
- The agents you want to use, installed and signed in. Any agent Orca can start works as the
  supervisor or a worker; reviewers start read-only only on **Claude Code** and **Codex**.
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
   github.com, or on a GitLab host glab is signed in to, and it needs at least one commit on its
   main branch; the list says when it does not, and what to run.
3. In **Settings**, pick the agent, model and effort for the supervisor, the workers (plus any
   worker tiers, such as a cheaper one for small tasks), each reviewer and, if you want one, the
   advisor. Then **Save**. The
   agents offered are the ones turned on in your Orca settings and installed; the model box
   searches the models each agent offers you now.
4. Click **Open supervisor chat** and tell it what to build.
5. Watch the timeline in dry run. When you are happy with what it would do, **Turn on autopilot**.

Matriarch finds the forge from the project's origin. For a GitLab behind an ssh alias, or one glab
is not signed in to yet, pick it under **Forge** in Settings.

### Issues as objectives

Turn on **Hand labeled issues to the supervisor** under **Settings → Issues**. Then label an open
issue `matriarch` (or the label you pick there). With autopilot on, Matriarch hands it to the
running supervisor as a new objective: the label is the go-ahead, each time it is added goes over
once, and the PR that does it says `Closes #<n>`. To hand an issue over again, remove the label and
add it back. Matriarch reads the labeled issues every 5 minutes (500 at most, oldest
first; the board says when there are more). With no supervisor running, **Needs you** says the
issue waits for one; in dry run the board says it would hand it over. **Comment on the issue**
posts one short comment when the supervisor takes it up.

An issue goes over only when both hold:

- **the label was last added by someone allowed to triage issues**: on GitHub, a collaborator
  whose role is triage, write, maintain or admin (a bot or app never counts); on GitLab, a project
  member from Reporter up, counting group membership;
- **neither its title nor its text changed after that**: on GitHub, no title change and no body
  edit after the label was added; on GitLab, no edit of the title or description after it.

So a label an issue template adds counts only if the issue's author has that access, and an
issue its author edits after you labeled it waits (an edit after the handoff changes nothing).
If Matriarch is cut off while handing an issue over, the board says it may not have arrived, and
it is not sent again by itself. Such an issue stays on the board with the
reason, until someone with access adds the label again (remove it, then add it). The issue's
title and text go to the supervisor as written, inside a fence and marked as the issue's, not
yours, so label only issues you would give an agent to do. Labels named `any` or `none` are
refused: GitLab reads them as filters.

Settings are saved in the project's `.orca/matriarch.json`, so you can commit them to share with
your team. Nobody has to edit that file: every setting Matriarch uses is in **Settings**, and
[DESIGN.md](DESIGN.md#roles-and-config) describes each field. **Turn Matriarch off here**, at the bottom of Settings, keeps them for later. Matriarch
manages only PRs you opened from a branch that belongs to an Orca workspace.

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
  merge and cleanup, including what failed and why. Only what it did: dry run's plans stay in
  **Would do next**. Something that fails every check is one line with a count (`×12, last
  14:05`). Each PR has its own log, even two from one branch. Kept for a week. Rows open with
  Enter or Space too.
- **Supervisor:** each project's chat, with the Run it coordinates, how many of its workers
  are running against the project's limit, the labeled issues it took or that wait, and its
  advisor: the question it is answering, or the last one it answered.
- **Needs you:** a reviewer waiting on a prompt, an escalation that reached you, a nearly full
  disk, a supervisor that went over its worker limits. The status bar shows the same at a glance.
- **Alerts:** the same notices on Slack, Discord, ntfy or any webhook, for when you are away. See
  [Away alerts](#away-alerts).
- **Full tab:** tab bar **+** → **Matriarch board**.

<img src="docs/picker.png" width="400" alt="Settings: picking a worker's model on OpenCode, with the list filtered as you type and grouped by provider.">

## Away alerts

What reaches you in Orca's notifications can also go to a webhook, so you hear about it away from
your desk. Open **Alerts** (next to **+ Add project**), paste the webhook URL, pick what to send, and
**Send a test**. It applies to every project.

- **Where:** a Slack incoming webhook, a Discord channel webhook, ntfy (ntfy.sh, or your own
  server: pick **ntfy** by hand), or any URL that takes a JSON POST with `kind`, `title`, `body`,
  `repo`, `number` and `url`. Slack, Discord and ntfy.sh are told apart by their address. A server
  that wants a password can take it in the URL (`https://user:pass@ntfy.example.com/topic`): it is
  sent as a Basic `Authorization` header and never shown.
- **What:** **Needs you** (an escalation that reached you, a reviewer stuck on a prompt, a PR that
  needs your merge or is blocked) and **Ready to merge** are on by default, and go alongside Orca's
  own notification. **Merged** (a PR Matriarch follows merged, by it or by anyone) is off by
  default and goes to the webhook only: Orca has no notification for it.
- **When:** while autopilot is on, like everything else Matriarch sends. In dry run only a
  reviewer stuck on a prompt (in a review you started) is sent, as Orca notifies you of it too.
- **How:** each alert is posted once, with a 10-second limit, and never retried or redirected.
  Four go at a time and twenty more wait their turn; past that, the rest go as one "and N more"
  post. A post that fails shows on the Alerts page, without blocking anything else.
- **The URL is a secret:** anyone who has a Slack or Discord webhook URL can post to that channel.
  Matriarch keeps it in Orca's encrypted secrets (your OS key store), not in plugin storage or a
  project's settings, and shows and logs only its host. Where Orca has no OS key store, it does
  not keep one.

## What it costs

Matriarch runs agents on **your** accounts, and each one uses your plan or API credit: the
supervisor chat, one worker per task, every reviewer on every review round, and the fix rounds
after it. A PR that needs several rounds costs several reviews. To keep it in hand:

- choose cheaper models for worker tiers and for some reviewers;
- **Review rounds per PR** (default 3) caps the rounds before it asks someone instead;
- later rounds check only what changed (**Later rounds: check the fixes**);
- reviewers on the same agent as the PR's author are skipped (you can turn that off);
- a PR that changes only docs (**Light changes**: `**/*.md`, `**/*.rst`, `**/*.adoc` by default)
  gets one reviewer, or none if you choose. Agents' instructions and tools' config always get the
  full crew, even when they match: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`,
  `*.prompt.md`, `copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, and anything in a
  `.claude`, `.cursor`, `.github`, `.agents`, `.codex`, `.omp` or `.opencode` folder. So does a PR
  that renames or copies a file, and on GitLab every merge request, since its file list does not
  say which files were renamed;
- **Reviews at once** (default 2) limits how many review crews run together.
- **Workers at once** (default 4) and **Worker starts a day** (default no limit) cap the
  supervisor's workers, and **Disk floor** (default 10 GB) stops new ones on a nearly full disk.
  The supervisor's brief states them, and a running supervisor is told when you change them.
  They are held two ways:
  - **Before a start**, when the supervisor or one of its workers is Claude Code in a terminal:
    its `worker-start` over a limit is refused, with what to do instead (wait for a worker to
    finish, for tomorrow, or for space). A command that starts workers in a loop is refused while
    a count limit is set, since how many it starts cannot be known. This holds in dry run too.
  - **Right after a start**, for every other case: Orca reports no tool calls for a session in a
    chat (the supervisor opens as one) and waits on none but Claude Code's. So with autopilot on,
    a worker whose start put the project over a limit is stopped (`orca orchestration
    worker-stop`, which keeps its worktree) as soon as Matriarch sees it, within a check, and the
    supervisor is told to start it again when there is room. In dry run the board says it would.

  Only a start is ever over a limit: workers already running when Matriarch first looks, or when
  you lower a limit, are never stopped, and **Needs you** says the project is over. Your own
  sessions are never refused.

When a reviewer's account hits its usage limit, Matriarch can restart it once on a fallback
model you choose; otherwise it shows the reviewer as **Needs you**.

An advisor runs only when the supervisor asks it something, once per question, so a strong model
there costs one agent session per question.

## Permissions

Matriarch is a **full-access** plugin (`trusted-worker`): its worker runs as you, on your
machine, so Orca asks you to approve it on install. It needs that to run `git`, `gh`, `glab` and `orca`,
start agents and read their state. It asks Orca for these capabilities:

- **Read workspaces** (`workspace:read`): lists your projects and worktrees, finds the workspace
  you have focused, and hears when workspaces are created or removed.
- **Open workspaces** (`workspace:write`): opens a project or a worktree when you click it, and
  runs Orca's own command to show the sidebar.
- **Read agents** (`agent:read`): which agents are running, working or waiting, in which
  workspace.
- **Show notifications** (`notifications:show`): tells you when something needs you while Orca
  is in the background.
- **Own storage** (`storage:own`): keeps each PR's history and review state in the plugin's own
  storage.
- **Own settings** (`settings:own`): autopilot on or off, and how often it checks GitHub and GitLab.
- **Own secrets** (`secrets:own`): keeps the [away-alert](#away-alerts) webhook URL, when you set
  one, in Orca's encrypted secrets.

It also adds two **hooks**. They change nothing for agents outside a review worktree (a review
round's, or the advisor's), except that a worker start (`orca orchestration worker-start` or
`dispatch`, `orca agent launch`) from the supervisor's own terminal or one of its workers' is
refused when it would go over the project's worker limits (see [What it costs](#what-it-costs)).
Your own sessions are never judged:

- **Before an agent launches** (`agent.launch.before`), a reviewer's command is rewritten so it
  starts read-only, whatever permission mode you chose in Orca:
  - Claude Code: `--dangerously-skip-permissions` and any other permission mode are removed, and
    `--permission-mode dontAsk` is set with an allowlist (read and search inside the worktree,
    read-only `git` and shell commands, and writing only its own notes under
    `.matriarch/review/`) and a denylist (paths outside the worktree, `git push`/`commit`, `gh`
    and `glab` writes, `gh api`, `glab api`, `rm`, web fetches), plus `--setting-sources user
    --strict-mcp-config`.
  - Codex: the bypass flags are removed and it runs with `--sandbox workspace-write
    --ask-for-approval never`, no network, no extra writable folders and no MCP servers.
  - Any other agent is refused as a reviewer or advisor unless you mark it **Run it without the
    read-only lockdown**.
- **Before an agent uses a tool** (`agent.tool.before`), a reviewer's tool call that would write
  outside its notes, or run a command that is not read-only, is blocked.

A reviewer that did not start locked down is stopped and started again, or shown as failed; an
advisor is stopped and the supervisor is told there is no answer. Supervisor and worker launches
are not changed.

## What it runs on your machine

| Command | When |
|---|---|
| `git -C <workspace> rev-parse …`, `git config --get remote.origin.url` | find the repository behind each workspace |
| `glab auth status --hostname <host>` | an origin on a host other than github.com: whether it is a GitLab glab is signed in to (only the exit code is read) |
| `gh api -X HEAD -i -H 'If-None-Match: …'` | each check: ask GitHub whether PRs, the default branch or followed checks changed (free when nothing did) |
| `gh api graphql` | read open PRs, CI checks and review threads, when something changed |
| `gh api repos/<repo>/actions/jobs/<id>/logs` | autopilot: the tail of a failed job's log, for the worker |
| `gh api repos/<repo>/check-runs/<id>/annotations`, `…/actions/jobs/<id>/logs` | once per failed check and commit: whether it failed on the infrastructure rather than the code |
| `gh api -X POST repos/<repo>/actions/jobs/<id>/rerun`, `…/actions/runs/<id>/rerun-failed-jobs` | autopilot: re-run, once, a job that failed on the infrastructure (several of one workflow run together) |
| `orca agent launch --surface chat …` | **Open supervisor chat**: the supervisor, on your model, with its brief |
| `orca terminal create` | once per project: a terminal titled "Matriarch mailbox" (`cat > /dev/null`), which Orca requires as the sender of Matriarch's messages |
| `orca orchestration worker-list`, `run-list` | find the worker that owns each branch, and the supervisor's Run |
| `orca orchestration send --from <mailbox>` | autopilot: CI failures, comments, AI findings and update requests to a worker; escalations, labeled issues and the advisor's answers to the supervisor |
| `orca orchestration check --terminal <mailbox> --peek`, then `check --terminal <mailbox>` | with an advisor: read the supervisor's questions sent to Matriarch's mailbox, then mark them read |
| `orca orchestration worker-stop --dispatch <id>` | autopilot: stop a supervisor's worker that started over the project's worker limits (its worktree is kept) |
| `git fetch origin …`, `orca worktree create`, `orca agent launch --model …`, `orca worktree rm` | a review round: a throwaway worktree at the PR head, one agent per reviewer, removed afterwards |
| `git fetch origin <main>`, `orca worktree create`, `orca agent launch --model …`, `orca worktree rm` | autopilot, with an advisor: one throwaway worktree of the main branch per question, the advisor in it, removed once it answers |
| `orca terminal close` | a reviewer or advisor that started without its lockdown is stopped |
| `gh api repos/<repo>/pulls/<n>/reviews` | autopilot, when **Where reviews go** includes the PR: one comment review per round |
| `gh pr update-branch` | autopilot: update a branch that is behind its base |
| `gh pr edit <n> --base <branch>` | autopilot: move a stacked PR to where its parent merged, when GitHub left it on the parent's branch |
| `gh api repos/<repo>/issues?state=open&labels=<label>&page=<n>` | with **Issues** on, every 5 minutes: the open issues with the label |
| `gh api graphql` (an issue's label and title events and last edit), `gh api repos/<repo>/collaborators/<login>/permission` | with **Issues** on, once per new or changed labeled issue: who added the label, and whether it changed since |
| `gh api -X POST repos/<repo>/issues/<n>/comments` | autopilot, with **Comment on the issue**: one comment when the supervisor takes an issue up |
| `gh api repos/<repo>/compare/<sha>...<branch>` | once when a stacked PR's parent merged: whether the base kept the commit the PR was built on |
| `gh pr merge --match-head-commit <sha>` | autopilot, when the project lets Matriarch merge: merge exactly the reviewed commit |
| `glab api --hostname <host> graphql` | GitLab: each check, the open merge requests with their pipeline status and the default branch's; a merge request's jobs, threads, files and approvals when it changed |
| `glab api --hostname <host> projects/<project>/merge_requests/<n>` | GitLab: only while it has not worked out whether a merge request can merge, which this read asks it to |
| `glab api --hostname <host> projects/<project>/jobs/<id>/trace` | GitLab, autopilot: the tail of a failed job's log, for the worker |
| `glab api --hostname <host> projects/<project>/jobs/<id>`, `…/trace` | GitLab, once per failed job and commit: its failure reason and log, whether it failed on the infrastructure |
| `glab api --hostname <host> -X POST …/jobs/<id>/retry` | GitLab, autopilot: retry, once, a job that failed on the infrastructure |
| `glab api --hostname <host> -X POST …/merge_requests/<n>/notes` | GitLab, autopilot, when **Where reviews go** includes the PR: one note per round |
| `glab api --hostname <host> -X PUT …/merge_requests/<n>/rebase` | GitLab, autopilot: rebase a merge request that is behind its base |
| `glab api --hostname <host> -X PUT …/merge_requests/<n> -f target_branch=<branch>` | GitLab, autopilot: move a stacked merge request to where its parent merged |
| `glab api --hostname <host> projects/<project>/issues?state=opened&labels=<label>&page=<n>` | GitLab, with **Issues** on, every 5 minutes: the open issues with the label |
| `glab api --hostname <host> …/issues/<n>/resource_label_events`, `…/members/all/<id>`, `graphql` (its last edit) | GitLab, with **Issues** on, once per new or changed labeled issue: who added the label, and whether it changed since |
| `glab api --hostname <host> -X POST …/issues/<n>/notes` | GitLab, autopilot, with **Comment on the issue**: one note when the supervisor takes an issue up |
| `glab api --hostname <host> …/repository/merge_base?refs[]=<sha>&refs[]=<branch>` | GitLab, once when a stacked merge request's parent merged: whether the base kept the commit it was built on |
| `glab api --hostname <host> -X PUT …/merge_requests/<n>/merge -f sha=<sha>` | GitLab, autopilot, when the project lets Matriarch merge: merge exactly the reviewed commit |
| `git -C <worktree> status --porcelain`, `orca worktree rm --delete-branch` | autopilot: remove a merged PR's worktree when nothing runs there and nothing is uncommitted |
| `sqlite3 'file:…?mode=ro'` | read your Orca settings (below), read-only |
| `opencode api model.list` | **Settings**: the models OpenCode offers you now, from every provider you signed in to |
| `orca --version` | **Settings**: say when this Orca is not the one Matriarch was tested with |

It never passes `--admin` and never bypasses branch protection or GitLab's merge checks.

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
replace them.

### Network and data

Matriarch talks to the network only through `gh`, to GitHub, and `glab`, to the GitLab hosts your
projects are on, and, when you set one, to your [away-alert](#away-alerts) webhook: it posts the
title and text of each alert you switched on, with the PR's project, number and link. It sends
nothing anywhere else and has no telemetry. Each PR's history and
review state stay in the plugin's own storage on your machine; each project's settings are in its
`.orca/matriarch.json`; reviewers' notes and the advisor's answers are written in their throwaway
worktree and removed with it.

## Limits

- GitHub (github.com) and GitLab (gitlab.com or self-hosted), and only PRs you opened from an Orca
  workspace's branch.
- On GitLab (**experimental**):
  - every check reads the open merge requests: GitLab has no free "nothing changed" answer, and
    counts a 304 against its rate limit like any request;
  - `merge.method` decides only whether to squash; the project's merge method in GitLab decides
    the rest;
  - GitLab cannot merge the base into a branch for Matriarch, so with **merge the base into it**
    the worker is asked to;
  - threads you start yourself count as notes to yourself, not as review feedback;
  - checked against gitlab.com's API. Merging, rebasing, notes and approvals have not been run on
    a real project yet, nor on a self-hosted GitLab (which needs one recent enough to have the
    GraphQL fields Matriarch reads; DESIGN.md lists them).
- Read-only reviewers and advisor on Claude Code and Codex only.
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
