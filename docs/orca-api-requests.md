# What Matriarch works around in Orca

Matriarch is built on Orca 1.4.257. Where Orca's plugin API does not yet give a plugin what it
needs, Matriarch works around it, and each workaround can break when Orca changes. This lists
them, with the API that would replace each, so they can be raised with Orca's maintainers.

## Reading Orca's own files

| Matriarch needs | Today it reads | An API that would replace it |
|---|---|---|
| The agents the person turned off, and the commands they set for agents, to offer the same agents as Orca's own picker | `profiles/<id>/profile-state.db`: `settings.disabledTuiAgents`, `settings.agentCmdOverrides` | `agents.catalog`: the agents Orca can launch, with enabled, installed and command |
| The workspace focused in Orca, when two projects' checkouts are both "main" and the context Orca gives plugins cannot tell them apart | `profiles/<id>/profile-state.db`: `workspaceSession.activeWorktreeId` | the focused workspace's id (and repository) in `workspace.readContext` and `workspace.changed` |
| The models each agent offers, with their effort levels and the person's default | `agent-model-catalog.db` | `agents.models(agent)`: Orca's discovered catalog |

These are read with `sqlite3` in read-only mode, three fields and one table. When they cannot be
read, Settings says so and Matriarch falls back (every installed agent, typed model ids).

## Orchestration

| Matriarch needs | What it does today | What would remove the workaround |
|---|---|---|
| To send a message to a worker or a Run | Orca refuses `orchestration send` without a sender terminal (`no_active_sender_terminal`), so Matriarch keeps a terminal titled "Matriarch mailbox" running `cat > /dev/null` per project and sends `--from` it | a plugin identity as a sender, or `orchestration.send` in the host API |
| To give follow-up work to a worker that has finished | Only the Run's coordinator may restart a finished worker, so Matriarch sends it to the supervisor, which does | letting a plugin with the right capability address a Run's workers |
| To escalate | `--type escalation` is accepted only from a worker, so escalations go as plain messages headed "Escalation:" | an escalation type a plugin may send |
| To find which worker owns a branch | `orchestration worker-list --full` and its `resource.worktreeId`, `projection.provider` and `projection.liveness` fields | `orchestration.workers` in the host API, with those fields promised |
| To launch reviewers read-only | the `agent.launch.before` hook rewrites the agent's command line; Orca restores sessions after a restart without that hook, so Matriarch closes a reviewer that came back unlocked and starts it again | launch hooks on restored sessions too, or a read-only launch option Orca enforces per agent |
| To pass a model's effort | Orca checks `--effort` against its own model catalog, which can lag the agent's | accepting what the agent itself reports |
