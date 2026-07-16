---
name: writing-omp-swarm-dags
description: Use when authoring OMP swarm YAML DAGs for existing projects, especially large specifications, multi-document reviews, source changes, project checks, imported graphs, iterations, control rewinds, or restart/resume.
---

# Writing OMP Swarm DAGs

## Core Principle

The existing project is the work surface and the deliverable. Point `swarm.workspace` at the project root or an isolated project worktree; use DAG-owned files only for orchestration state and evidence.

## Route Before Reading

Read the first row for every DAG, then only rows whose trigger is true. Read selected files completely and record the named decisions.

| Trigger                                             | Read                                                                                                              | Decide                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Every DAG                                           | [Project Workflows](references/project-workflows.md) and [Root and Scheduling](references/root-and-scheduling.md) | Workspace and anchors; project/DAG paths; mode, edges, waves, concurrency, validation. |
| An agent inspects, decides, reviews, or edits       | [Agent Nodes](references/agent-nodes.md)                                                                          | Task, tools, ownership, reports/control, retry, failure.                               |
| A project command runs                              | [Bash Nodes](references/bash-nodes.md)                                                                            | Command, cwd, mutable output, exit marker, evidence, interpreting agent.               |
| A graph is imported, inlined, or repeated           | [Graph Nodes](references/graph-nodes.md)                                                                          | Child workspace/ownership, repeat semantics, parent edges, validation.                 |
| The workflow rewinds, restarts, or resumes          | [Control and Recovery](references/control-and-recovery.md)                                                        | Controller, restart targets/limits, rerun boundary, preserved state.                   |
| Artifacts are created, cleaned, retained, or reused | [Artifact Lifecycle](references/artifact-lifecycle.md)                                                            | Layout, writers, cleanup, restart preservation, retention/reuse.                       |

Choose the authoring mode before templates:

- Deliverable is a DAG that will later design and audit another DAG: prepare the [Complex DAG Authoring Template](templates/author-complex-dag.yaml); skip composition templates.
- Otherwise author directly, adapting at most one matching topology:
  - Bounded implementation → checks → review/correction: [DAG Template](references/dag-template.md).
  - Normative sources → precedence → dependency-ordered remediation → audits/correction: [Specification Review and Remediation Template](references/spec-review-remediation-template.md).
- No match: build directly from routed references.

Templates are starting artifacts, not schema documentation.

## Build

1. Define the outcome, project root and anchors, exact commands, and mutable, forbidden, and inspect-only paths.
2. Read routed references; record their decisions. Missing workspace, ownership, command, or recovery decisions block authoring.
3. Draw the smallest graph with one writer per mutable path. Agents edit project files; DAG paths hold coordination and evidence.
4. Interpret meaningful Bash results with a downstream agent. Make every retry idempotent; rewind does not restore files.
5. Validate the root and imports, fix every diagnostic, and confirm printed waves:

```bash
omp-swarm validate path/to/swarm.yaml
```

Ready means the command ends with `Validation: ok`.

## Prepare the Complex Author

Select this mode only when the requested deliverable is the authoring DAG itself. To write a project workflow now, use direct authoring instead. **Never execute the authoring DAG or its future generated DAG while applying this skill.**

1. Read `templates/author-complex-dag-request.yaml`. Inspect the task, project, and complete source corpus; derive goal/completion, anchors and inspection bounds, source records and token estimates, mutable/forbidden paths, ownership clusters, convergence owners, and exact commands.
2. Record explicit authority and precedence. Never invent policy. Block and ask only for required decisions that project evidence cannot establish.
3. Keep `generated_dag.path: .omp/generated-complex-task.yaml`. Default to `fail-if-exists`; use `replace-matching-sha256` only when replacement is explicitly required and the current digest is known.
4. Copy `templates/author-complex-dag.yaml` verbatim to `.omp/author-complex-dag.yaml`. Write the completed request to `.omp-swarm/author-complex-dag/input/request.yaml`.
5. Confirm the corpus fits the eight fixed reader shards. If not, widen reader nodes, shard manifests, coverage dependencies, and `shard_count` together; never omit sources.
6. Validate only:

   ```bash
   omp-swarm validate .omp/author-complex-dag.yaml
   ```

7. Inspect the printed waves and recheck every request binding against the project. Deliver the configured authoring DAG, persistent request, resolved workspace, ownership, expected waves, and successful validation evidence.

`.omp/generated-complex-task.yaml` and runtime reports do not exist yet. They are future outputs of an explicit execution outside this authoring skill; never claim or create them here.

## Delivery

Report the DAG path, resolved project workspace, project-path ownership, DAG-owned artifact paths, execution waves, and successful validation command.
