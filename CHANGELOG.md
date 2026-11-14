# Changelog

## 0.1.0

The first release.

- A **supervisor** chat per project, on the agent and model you choose, plans the work, starts
  workers in their own worktrees on your worker tiers, answers their questions and handles
  escalations, so a run keeps going while you are away. Changing the worker settings or limits
  tells a running supervisor.
  - An optional **advisor** gives the supervisor a second opinion when it asks, on its own agent,
    model and thinking level (Claude on Fable 5.2, say): one question at a time, read-only, in a
    throwaway worktree, only from the supervisor Matriarch opened, and only with autopilot on.
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
    the parent's commits, its worker is asked to rebase off them before it merges.
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
