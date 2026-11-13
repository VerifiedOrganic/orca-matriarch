# Security policy

Matriarch is a full-access Orca plugin. Its worker runs as you, starts coding agents on your
accounts, changes how reviewer agents launch, and with autopilot on it messages agents, updates
branches and can merge pull requests. The [README](README.md#permissions) lists everything it is
meant to do. Please report anything that lets it do more than that, for example:

- a reviewer that can write outside its review notes, push, or reach the network despite the
  read-only lockdown;
- a merge, branch update or message that happens in dry run, or that the project's settings do
  not allow;
- a crafted PR, review comment, CI log or agent output that makes Matriarch run a command or
  send something it should not.

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/VerifiedOrganic/orca-matriarch/security/advisories/new),
not in a public issue. Include the Matriarch and Orca versions, what an attacker controls, and
what it leads to.

You should get an answer within a week. Fixes ship as a new version, which Orca installs as an
update.

## Supported versions

Only the newest released version gets security fixes.
