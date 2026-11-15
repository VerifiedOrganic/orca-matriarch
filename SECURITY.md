# Security policy

Matriarch is a full-access Orca plugin. Its worker runs as you, starts coding agents on your
accounts, changes how reviewer and advisor agents launch, and with autopilot on it messages
agents, updates branches, stops workers and can merge pull requests. The
[README](README.md#permissions) lists everything it is meant to do, and
[Dry run and autopilot](README.md#dry-run-and-autopilot) what runs in each. Please report
anything that lets it do more than that, for example:

- a reviewer or the advisor that can write outside its notes, push, or reach the network despite
  the read-only lockdown;
- anything that happens in dry run that the dry-run list does not name, or a merge, branch update
  or message that the project's settings do not allow;
- a crafted PR, review comment, CI log, issue or agent output that makes Matriarch run a command
  or send something it should not;
- an issue that reaches the supervisor when the [label rule](README.md#issues-as-objectives) says
  it should not, or whose title or text Matriarch passes on as its own words or the user's;
- a question that reaches the advisor from an address that is not one of the supervisor's (see
  below for what the check is);
- the [away-alert](README.md#away-alerts) webhook URL kept anywhere but Orca's secrets, or shown
  or logged beyond its host.

Not vulnerabilities in Matriarch:

- what a labeled issue asks the pod to do, when the label rule held: that is up to the people you
  let label issues, and to any automation that labels issues with one of their tokens, which
  counts as them;
- a supervisor going over its worker limits: they keep cost and disk in hand and are not a
  security boundary (the refusal before a start works only for Claude Code in a terminal);
- what the advisor advises: it only reads, and the supervisor weighs its answer;
- another agent on your machine posing as the supervisor. Every sender check is an address
  match, and Orca does not authenticate senders: any caller can reply to any message, and its
  reply is filed under that message's Run. Matriarch takes a message as the supervisor's only
  from an address known to be the supervisor's: its chat's session from the launch, the handle
  its Run is bound to, or the first chat session (not one of the Run's workers) that replied to
  Matriarch's mail to that Run while no supervisor address was known. Learning that first
  address trusts that the supervisor answers Matriarch before another chat does; a different
  chat replying later is not learned, and the board says so. An agent that learned a supervisor
  address can send as it. What that allows is limited: the advisor runs read-only, so the cost
  is one agent session per question, and its text reaches the supervisor framed as a second
  opinion, which the supervisor weighs and does not obey; a reply posing as the supervisor can
  give an escalation one more window before it reaches you, and then reaches you all the same.

## Reporting a vulnerability

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/VerifiedOrganic/orca-matriarch/security/advisories/new),
not in a public issue. Include the Matriarch and Orca versions, what an attacker controls, and
what it leads to.

You should get an answer within a week. Fixes ship as a new version, which Orca installs as an
update.

## Supported versions

Only the newest released version gets security fixes.
