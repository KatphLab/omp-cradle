# Graph Nodes

Read this complete file when the new DAG imports another graph or uses fixed `repeat` rounds.

## Graph Fields

```yaml
review_round:
  type: graph
  path: ./graphs/review.yaml
  waits_for: [implement]
  reports_to: [integrate]
```

| Field        | Required | Contract                                                                                 |
| ------------ | -------- | ---------------------------------------------------------------------------------------- |
| `type`       | yes      | Exactly `graph`.                                                                         |
| `path`       | yes      | Non-empty child YAML path; relative paths resolve from the YAML that declares the graph. |
| `waits_for`  | no       | Local parent upstream IDs.                                                               |
| `reports_to` | no       | Local parent downstream IDs.                                                             |
| `repeat`     | no       | Fixed bounded child execution described below.                                           |
| `control`    | no       | Dynamic decision object; read `control-and-recovery.md`.                                 |

Imports load recursively and import cycles fail validation. Parent dependencies address the graph node as a unit; they cannot name child node IDs.

An imported child's `workspace` and `concurrency` are used when that YAML runs alone. When imported, all child nodes use the parent run's resolved project workspace and child agents share the parent's concurrency limiter. Child source ownership must therefore be coordinated with every parent and sibling node that can run at the same time.

An imported child's agent-level model overrides its own `swarm.model`; parent model settings are not inherited into the child.

## Fixed Graph Repeat

```yaml
repeat:
  max_rounds: 3
  stop_signal: .omp-swarm/source-change/run/signals/review-round.txt
  success_value: ACCEPTED
  continue_value: CHANGES_REQUESTED
```

All four fields are required:

| Field            | Contract                                                       |
| ---------------- | -------------------------------------------------------------- |
| `max_rounds`     | Integer `>= 1`; hard execution limit.                          |
| `stop_signal`    | Safe workspace-relative one-line status file.                  |
| `success_value`  | Non-empty exact trimmed value that completes the graph node.   |
| `continue_value` | Non-empty exact trimmed value that starts another child round. |

`repeat` is valid only on graph nodes. A repeated child must declare `target_count: 1`.

After each child run, the parent reads `stop_signal` from the shared project workspace. Missing content, an unexpected value, or `continue_value` after the final allowed round fails the graph node. Use `repeat` only when every round has the same graph shape and source edits are idempotent against the already-modified project tree.

Use graph `repeat` for a fixed review/refinement protocol. Use node `control` when a reviewer must choose a particular upstream target to rewind. Do not combine loops unless both boundaries are independently necessary.

## Child Design

A child graph is a reusable orchestration boundary, not a filesystem sandbox. Give it:

- A standalone-valid `workspace` and positive `concurrency`.
- Project-relative tasks that also make sense in the parent's workspace.
- Source ownership that does not overlap concurrent parent or sibling writers.
- Child-specific DAG-owned reports/signals to prevent path collisions.
- `target_count: 1` when the parent applies `repeat`.

Validate the root YAML only after every child exists; validation recursively loads all imports and prints each graph's waves.
