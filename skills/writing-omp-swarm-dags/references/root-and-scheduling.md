# Root and Scheduling Reference

Read this complete file for every new DAG. It owns root fields, dependency edges, execution modes, pipeline behavior, validation, and delivery evidence.

## Root Shape

Only the documented fields have supported behavior. Do not add fields such as `version`, `kind`, `stages`, `tasks`, `depends_on`, `after`, or `run`, even if the runtime happens to ignore an unknown key.

```yaml
swarm:
  name: feature-workflow
  workspace: ..
  mode: parallel
  target_count: 1
  concurrency: 2
  model: pi/smol
  nodes: {}
```

| Field            | Required    | Contract                                                                                                                                                           |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `swarm`          | yes         | The only supported top-level object.                                                                                                                               |
| `name`           | yes         | Non-empty; matches `^[\w.-]+$`; names persisted runtime state.                                                                                                     |
| `workspace`      | yes         | Non-empty absolute path, or relative to the YAML file. Use the existing project root or project worktree.                                                          |
| `mode`           | no          | `sequential`, `parallel`, or `pipeline`; default `sequential`.                                                                                                     |
| `target_count`   | no          | Integer `>= 1`; default `1`; values above `1` require `pipeline`.                                                                                                  |
| `concurrency`    | yes         | Integer `>= 1`; maximum simultaneous agent nodes across the root and imported graphs. Bash nodes do not consume this budget.                                       |
| `model`          | no          | Non-empty default model selector for agents declared in this graph. An agent-level model overrides it. Imported children use their own agent/graph model settings. |
| `restart_policy` | conditional | Required in this graph when any local agent or graph declares `control`; read `control-and-recovery.md`.                                                           |
| `nodes`          | yes         | Non-empty map of local node IDs to `agent`, `bash`, or `graph` definitions.                                                                                        |

The runner resolves a relative workspace from the root YAML's directory and creates it if absent. `omp-swarm validate` does not create or inspect the workspace; project anchors need a workflow guard.

## Dependency Fields

Every node type may declare:

| Field        | Contract                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| `waits_for`  | Unique list of local producer node IDs. Adds producer → current-node edges. |
| `reports_to` | Unique list of local consumer node IDs. Adds current-node → consumer edges. |

Both forms describe scheduling edges and may state the same edge from opposite ends. Targets must exist in the same YAML, must not name the node itself, and must not form a cycle. Parent nodes cannot target IDs inside an imported child.

Dependencies do not carry files, merge source changes, or require the predecessor's result to be successful. They only wait for settlement. If failure matters, add an explicit result contract and a downstream decision-maker.

## Modes and Waves

- `parallel`: all dependency-ready nodes may run together, subject to agent concurrency.
- `sequential`: declaration order is an implicit chain only when the entire local graph has no explicit `waits_for` or `reports_to` edge.
- `pipeline`: the same implicit-chain rule as sequential, plus full-DAG iteration through `target_count`.

Once any explicit local edge exists, implicit declaration-order chaining is disabled for the whole local graph. Declare every required edge. Same-wave project writers must have disjoint ownership.

Use fan-out for independent project work and fan-in for a later integrator or reviewer. Keep unrelated branches independent; do not add edges merely to make the YAML look ordered.

## Pipeline Iterations

`mode: pipeline` with `target_count: N` executes the entire root graph N times. It does not interpolate an iteration number into tasks, commands, or paths. Use pipeline only when each iteration is intended to refine the same current project state or produce a deliberately distinct result.

If iterations create durable DAG artifacts, one setup node must own an iteration counter and every iteration must archive evidence under a unique path such as `results/iteration-<n>/`. A Bash `output_path` is literal, so archive it before the next iteration when prior output must survive.

Project-modifying pipeline nodes are rerun against the already-modified tree. Their tasks must be idempotent and must state what changes between iterations.

## Required Validation

After the YAML and every imported child exist, run:

```bash
omp-swarm validate path/to/swarm.yaml
```

Validation recursively hydrates file-backed and inline child graphs, checks supported values and cross-field constraints, rejects dependency/import cycles and invalid control targets, and prints execution waves. It does not execute nodes, check project anchors, prove path ownership, or run project verification.

Delivery requires:

- `Validation: ok` from the exact DAG path.
- Printed waves matching intended source ownership and review order.
- The resolved project workspace.
- Project paths each modifying node may own.
- DAG-owned evidence paths.
- The focused project command the executed workflow will use.
