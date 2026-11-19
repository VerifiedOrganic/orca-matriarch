# Changelog

## 0.1.1

Tested with Orca 1.4.263, which it now needs. Fixes from an independent review of 0.1.0.

- **A merged PR's worktree is removed only while it holds just that PR.** Before, a later worker
  that took the worktree over, committed without pushing and finished could lose that work when
  Matriarch removed the worktree and its branch. Now git in the worktree must say it is still on
  the PR's branch with no commits the PR did not have; one moved to another branch is left alone.
  A worker Orca cannot vouch for (just started, or restored after a restart) counts as running
  there, and nothing is removed while Orca's worker list cannot be read.
- **Every reviewer runs.** With **Keep reviewers off the author's agent** (on by default), a
  reviewer on the agent that wrote the PR now reviews on another reviewer's agent and model,
  keeping its focus; before, it sat the round out, so the default crew (Codex workers, a Codex
  security reviewer) reviewed every PR with one reviewer.
- **A failed check says so.** The board shows that the last check failed, why, and how old what
  it shows is, and the status bar says **check failed**, until a good check replaces it.
- **An Orca worker list Matriarch cannot read is not taken as "no workers".** It says it cannot
  see Orca's workers, and sends nothing to workers, removes no PR's worktree and leaves its mail
  in Orca until it can.
- **The supervisor is told when a PR its workers built merges** or is closed without merging, so
  work that waited on it starts then: with autopilot on, including one that closed while it was
  off or before the supervisor was found, and tried again if the send fails, for up to a day. Its
  brief says so, and not to write loops that wait for a merge: one such loop, written for bash,
  polled forever in zsh, which does not split an unquoted variable into words. A Claude Code
  supervisor's brief names the shell its commands run in, and every brief asks for a time limit
  and a line of output on any wait.
- **Restarting a reviewer** keeps it on the agent the round chose for it.
- **The status bar** no longer stops updating when its text runs past Orca's 64 characters or
  its tooltip past 256.
- **Safer defaults:** **Worker starts a day** is 20 (was no limit), and reviews stay in Orca
  unless a project posts them on the PR (**Where reviews go**), since a Codex reviewer can read
  files outside its worktree.
- The README starts with a quick start and says plainly what is new; building and releasing moved
  to CONTRIBUTING.md.

**Upgrading from 0.1.0:** turning a project on wrote every setting into its
`.orca/matriarch.json`, the old defaults included, so the new defaults do not reach it by
themselves. In each project's Settings, check **Where reviews go** (it was "also posted on the
PR") and **Worker starts a day** (it was 0, no limit).

## 0.1.0

The first release.

- A **supervisor** chat per project, on the agent and model you choose, plans the work, starts
  workers in their own worktrees on your worker tiers, answers their questions and handles
  escalations, so a run keeps going while you are away. Changing the worker settings or limits
  tells a running supervisor. Matriarch reads what comes back to its mail: each reply shows in
  its PR's log, and the supervisor's or a worker's on its card. An escalation the supervisor
  answered gives it that long again before you are told, with its answer; CI red on the base is
  one escalation for the whole repository. A reply counts as the supervisor's only from an
  address known to be its (an address match: Orca does not authenticate senders).
  - An optional **advisor** gives the supervisor a second opinion when it asks, on its own agent,
    model and thinking level (Claude on Fable 5.2, say): one question at a time, read-only, in a
    throwaway worktree, only from the supervisor (known from its chat's launch, the handle its Run
    is bound to, or the first chat to reply to Matriarch's mail to its Run), and only with
    autopilot on.
  - **Worker and disk limits** per project: workers at once, worker starts a day, and a disk
    floor. The supervisor's brief states them; a Claude Code supervisor or worker in a terminal
    has a start over a limit refused, and with autopilot on, any other worker that starts over a
    limit is stopped right after, keeping its worktree.
  - **Issues as objectives,** off by default: with autopilot on, an issue labeled by a person with
    triage access (Reporter and above on GitLab), and not edited since, goes to the supervisor
    once as an objective, and its PR closes it.
- Each PR is driven through **CI, review comments, conflicts, an AI review and merge**: failures
  and findings go back to the worker that owns the branch, or to the supervisor once that worker
  has finished. A draft nobody works on gets the supervisor asked, once per commit, whether it is
  ready.
  - A check that failed on the **infrastructure** (a lost runner, a registry or git remote out of
    reach, a rate limit) is run again once before a worker is asked to fix it: GitHub Actions and
    GitLab jobs only.
  - **Stacked PRs** merge in order: a PR on another of your PRs' branch waits until that one
    merges, is moved onto its base if the forge did not move it, and, when the base did not keep
    the parent's commits, its worker is asked to rebase off them before it merges. A merged
    branch other PRs are based on is kept until they have moved off it, then deleted.
- A **review crew** of several reviewers, each on its own agent and model, in a throwaway
  worktree. Claude and Codex reviewers start **read-only** (Claude in `dontAsk` mode with an
  allowlist, Codex in its sandbox with no network). Later rounds check only what changed; a
  reviewer that hits its usage limit can move to a fallback model. A PR that changes only docs
  gets a **lighter review**: one reviewer, or none if you choose; agents' instructions, tools'
  config and renamed files always get the full crew.
- **GitHub and, experimentally, GitLab** (gitlab.com or self-hosted, through `glab`). On GitLab,
  reading merge requests is checked against gitlab.com; merging, rebasing and notes have not yet
  run on a real project.
- **Dry run by default:** it shows what it would do until you turn on autopilot. Merging is
  yours unless a project's settings let Matriarch merge.
- **Timeline and board** across projects, with every lane always shown: a PR shows as Working
  while it is built, Fixing (CI, conflicts, review, or after its first version) while it is
  changed, and stays in Merged / closed for six hours. Matriarch's colors read the same in every
  Orca theme.
  - **What Matriarch did:** each PR's log of the lanes it entered and why, and every message,
    review, update and merge, from a timeline row or a card.
- A status bar summary, and **Needs you** for anything that waits on a person, including a nearly
  full disk.
  - **Away alerts** send what needs you, what is ready and (if you like) what merged to Slack,
    Discord, ntfy or any webhook, while autopilot is on. The URL is kept in Orca's encrypted
    secrets.
- **Settings in the panel** for each project: who does the work first (agent, model and thinking
  level per role, with the models each agent offers now, Oh My Pi's included), then the review,
  fix, merge, limit, issue and cleanup rules, folded behind one-line summaries. Nothing needs a
  config file.
- GitHub is polled with **conditional requests** that cost no rate limit when nothing changed.
- **Cleanup:** a merged PR's worktree is removed once nothing runs there and nothing is
  uncommitted, and a worktree the supervisor's workers finished in that never became a PR (a
  review gate, say) an hour after, when nothing in it is uncommitted or unpushed.
