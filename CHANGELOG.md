# Changelog

## 0.1.0

The first release.

- A **supervisor** chat per project, on the agent and model you choose, plans the work, starts
  workers in their own worktrees on your worker tiers, answers their questions and handles
  escalations, so a run keeps going while you are away. Changing the worker settings tells a
  running supervisor the new commands.
- Each PR is driven through **CI, review comments, conflicts, an AI review and merge**: failures
  and findings go back to the worker that owns the branch, or to the supervisor once that worker
  has finished. A draft nobody works on gets the supervisor asked, once per commit, whether it is
  ready.
- A **review crew** of several reviewers, each on its own agent and model, in a throwaway
  worktree. Claude and Codex reviewers start **read-only** (Claude in `dontAsk` mode with an
  allowlist, Codex in its sandbox with no network). Later rounds check only what changed; a
  reviewer that hits its usage limit can move to a fallback model.
- **GitHub and, experimentally, GitLab** (gitlab.com or self-hosted, through `glab`). On GitLab,
  reading merge requests is checked against gitlab.com; merging, rebasing and notes have not yet
  run on a real project.
- **Dry run by default:** it shows what it would do until you turn on autopilot. Merging is
  yours unless a project's settings let Matriarch merge.
- **Timeline and board** across projects, with every lane always shown: a PR shows as Working
  while it is built, Fixing (CI, conflicts, review, or after its first version) while it is
  changed, and stays in Merged / closed for six hours. A status bar summary, and **Needs you**
  for anything that waits on a person, including a nearly full disk. Matriarch's colors read the
  same in every Orca theme.
- **Settings in the panel** for each project: who does the work first (agent, model and thinking
  level per role, with the models each agent offers now, Oh My Pi's included), then the review,
  fix, merge and cleanup rules, folded behind one-line summaries. Nothing needs a config file.
- GitHub is polled with **conditional requests** that cost no rate limit when nothing changed.
- **Cleanup:** a merged PR's worktree is removed once nothing runs there and nothing is
  uncommitted, and a worktree the supervisor's workers finished in that never became a PR (a
  review gate, say) an hour after, when nothing in it is uncommitted or unpushed.
