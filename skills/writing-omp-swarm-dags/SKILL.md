---
name: writing-omp-swarm-dags
description: Use when authoring or modifying OMP swarm YAML DAGs for existing projects.
---

# Writing OMP Swarm DAGs

## Core

Use the existing project as `swarm.workspace`; keep DAG paths for coordination and evidence. Give every mutable path one writer per phase, use explicit handoffs, make retries idempotent, and validate the root DAG.

## Route Before Reading

Inspect the request/YAML first:

- **Targeted edit:** preserve valid untouched decisions; route only changed fields or node types.
- **Complete-template match:** read one template; skip equivalent references unless deviating.
- **Custom DAG:** read project/root guidance and only references for used features.

This file is the core. Read exactly the matching rows. Never scan `references/` or `templates/`. Selected-file links do not activate another reference; return here and test its condition.

| Condition                                                                                         | Read                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| New custom DAG, or changing workspace, anchors, or project/DAG ownership                          | [Project Workflows](references/project-workflows.md)       |
| New custom DAG, or changing root fields, edges, mode, waves, concurrency, pipeline, or validation | [Root and Scheduling](references/root-and-scheduling.md)   |
| Adding or changing an agent node or task                                                          | [Agent Nodes](references/agent-nodes.md)                   |
| Adding or changing a Bash node                                                                    | [Bash Nodes](references/bash-nodes.md)                     |
| Changing `model_routing`, agent `model`, or `workload`                                            | [Model Routing](references/model-routing.md)               |
| Adding or changing imported, inline, or repeated graphs                                           | [Graph Nodes](references/graph-nodes.md)                   |
| Adding or changing control, restart, external rewind, or resume                                   | [Control and Recovery](references/control-and-recovery.md) |
| Adding or changing cleanup, cache, history, retention, cross-run reuse, or staged promotion       | [Artifact Lifecycle](references/artifact-lifecycle.md)     |

Ordinary reports, handoffs, check outputs, and signals use their node contracts; they do not trigger Artifact Lifecycle.

## Templates

Choose at most one:

- Standard source change: [complete template](references/dag-template.md); adapt only project paths and commands.
- Normative remediation: [structural template](references/spec-review-remediation-template.md); expand compact tasks with its required feature references.
- DAG-authoring DAG: use only its [request](templates/author-complex-dag-request.yaml) and [author DAG](templates/author-complex-dag.yaml); do not execute them.

No exact match means custom authoring.

## Build and Verify

1. Define outcome, workspace/anchors, commands, inspect/edit/forbidden paths, and project versus DAG ownership.
2. Draw the smallest graph; prove bootstrap order, handoffs, and one writer per mutable path.
3. Put each non-trivial agent contract inside ordered `task: |` sections; the closed schema rejects task-like sibling fields.
4. For each correction, name the failed predicate, mutation, owner, target, and reachable writer. Rewind does not restore files.
5. Interpret meaningful Bash evidence with an agent; settlement is not acceptance.
6. Validate the root and imports, fix diagnostics, and inspect waves:

```bash
omp-swarm validate path/to/swarm.yaml
```

Ready ends with `Validation: ok` and waves matching ownership and correction order.

## Common Failures

- Reading before routing, or loading a template plus equivalent references.
- Treating edges as data transport or Bash/file existence as acceptance.
- Restarting a node unable to change the failed predicate.

## Delivery

For a targeted edit, report the changed contract, preserved decisions, and focused validation evidence. For a new DAG, report path, workspace, ownership, evidence flow, correction reachability, waves, and validation evidence.
