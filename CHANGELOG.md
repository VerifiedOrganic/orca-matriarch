# Changelog

## 0.1.0

The first release.

- A **supervisor** chat per project, on the agent and model you choose, plans the work, starts
  workers in their own worktrees on your worker tiers, answers their questions and handles
  escalations, so a run keeps going while you are away.
- Each PR is driven through **CI, review comments, conflicts, an AI review and merge**: failures
  and findings go back to the worker that owns the branch, or to the supervisor once that worker
  has finished.
- A **review crew** of several reviewers, each on its own agent and model, in a throwaway
  worktree. Claude and Codex reviewers start **read-only** (Claude in `dontAsk` mode with an
  allowlist, Codex in its sandbox with no network). Later rounds check only what changed; a
  reviewer that hits its usage limit can move to a fallback model.
- **Dry run by default:** it shows what it would do until you turn on autopilot. Merging is
  yours unless a project's settings let Matriarch merge.
- **Timeline and board** across projects, a status bar summary, and **Needs you** for anything
  that waits on a person, including a nearly full disk.
- **Settings in the panel** for each project: agents and models come from your Orca profile and
  the agents themselves, with a model search and each model's effort levels.
- GitHub is polled with **conditional requests** that cost no rate limit when nothing changed.
- Merged PRs' worktrees are removed once nothing runs there and nothing is uncommitted.
