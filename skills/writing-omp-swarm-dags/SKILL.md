---
name: writing-omp-swarm-dags
description: Use when authoring a new OMP swarm YAML DAG for work in an existing project, including source changes, project checks, multi-agent collaboration, Bash verification, imported graphs, iterations, control rewinds, or restart/resume.
---

# Writing OMP Swarm DAGs

## Core Principle

The existing project is the work surface and the deliverable. Point `swarm.workspace` at the project root or an isolated project worktree; use DAG-owned files only for orchestration state and evidence.

## Whole-File Routing

A route selects whole files only. Read each selected file from beginning to end.

| Condition                                                            | Read                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Every new DAG                                                        | [Project Workflows](references/project-workflows.md) and [Root and Scheduling](references/root-and-scheduling.md) |
| DAG contains an `agent` node                                         | [Agent Nodes](references/agent-nodes.md)                                                                          |
| DAG contains a `bash` node                                           | [Bash Nodes](references/bash-nodes.md)                                                                            |
| DAG contains an imported or repeated `graph` node                    | [Graph Nodes](references/graph-nodes.md)                                                                          |
| DAG uses `control`, `restart_policy`, rewind, restart, or resume     | [Control and Recovery](references/control-and-recovery.md)                                                        |
| DAG creates handoffs, reports, signals, cleanup, cache, or history   | [Artifact Lifecycle](references/artifact-lifecycle.md)                                                            |
| A complete source-change composition would help                      | [DAG Template](references/dag-template.md)                                                                        |
| A specification-driven review and remediation composition would help | [Specification Review and Remediation Template](references/spec-review-remediation-template.md)                   |

Do not read a node-type or optional-feature file unless the new DAG uses that feature.

## Authoring Order

1. Define the project outcome, existing project root, acceptance commands, and source/config/test areas that may change.
2. Select and fully read the routed files above.
3. Draw the smallest graph that gives every mutable project path one writer at a time.
4. Make implementation agents edit the actual project tree. Put only coordination data under the DAG-owned run directory.
5. Add focused project checks and a downstream agent decision wherever a Bash failure must affect the workflow.
6. Make retries and rewinds idempotent: scheduler restart does not roll back project files.
7. Validate the root YAML and all imports:

```bash
omp-swarm validate path/to/swarm.yaml
```

Fix every diagnostic and inspect the printed waves. A DAG is ready only when the command ends with `Validation: ok`.

## Delivery

Report the DAG path, resolved project workspace, project-path ownership, DAG-owned artifact paths, execution waves, and successful validation command.
