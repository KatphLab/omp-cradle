# Graph Nodes

Use only when `SKILL.md` routes here. Return to its table before opening any linked reference.

## Graph Fields

File-backed child:

```yaml
review_round:
  type: graph
  path: ./graphs/review.yaml
  waits_for: [implement]
  reports_to: [integrate]
```

Inline child:

```yaml
inline_review:
  type: graph
  swarm:
    name: inline-review
    workspace: .
    mode: sequential
    concurrency: 1
    nodes:
      review:
        type: agent
        role: reviewer
        task: |
          Outcome:
          - Decide whether the current project satisfies the review contract.

          Inputs / read:
          - Read .omp-swarm/parent/run/implementation.md from the parent
            implementer as Markdown with changed_paths and acceptance_cases.
          - Missing or malformed input is BLOCKED and cannot pass.

          Scope:
          - Inspect: changed_paths from implementation.md.
          - May edit: .omp-swarm/inline-review/run/review.md only.
          - Must not edit: project files, sibling reports, or .swarm_*.

          Decision rules:
          - PASS only when current source satisfies every acceptance case.
          - Otherwise write actionable FINDINGS.

          Acceptance / verification:
          - Reproduce the highest-risk acceptance behavior against current source.

          Outputs / handoffs:
          - Overwrite .omp-swarm/inline-review/run/review.md as Markdown.
          - Include verdict, findings, evidence, and required_mutations for the
            parent integrator; failure to produce valid output blocks acceptance.

          Control / correction:
          - No control signal.

          Retry / failure:
          - Re-read current source and evidence; overwrite stale review output.
          - Preserve all project and parent-owned files on failure.
```

| Field        | Required | Contract                                                                                              |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `type`       | yes      | Exactly `graph`.                                                                                      |
| `path`       | one of   | Non-empty child YAML path; relative paths resolve from the YAML that declares the graph.              |
| `swarm`      | one of   | Inline child swarm object with the same root fields and node contracts as a top-level `swarm` object. |
| `waits_for`  | no       | Local parent upstream IDs.                                                                            |
| `reports_to` | no       | Local parent downstream IDs.                                                                          |
| `repeat`     | no       | Fixed bounded child execution described below.                                                        |
| `control`    | no       | Dynamic decision object; route through `SKILL.md` when changed.                                       |
| `resume`     | no       | Restart identity, versions, and reuse policy; route through `SKILL.md` when changed.                  |

Exactly one of `path` and `swarm` is required. They cannot appear together. File-backed children load recursively and import cycles fail validation; inline children may themselves contain either form.

Parent dependencies address the graph node as a unit; they cannot name child node IDs. An inline child has the same shared root workspace and concurrency behavior as a file-backed child: when nested, all child nodes use the parent run's resolved project workspace and child agents share the parent's concurrency limiter.

An imported or inline child's agent-level model overrides its own `swarm.model`; parent model settings are not inherited into the child.

With root `model_routing` enabled, routing policy is the exception: it is authoritative across recursively hydrated children. A child may omit it to inherit or declare an enabled policy that only narrows allowed aliases, raises quality, lowers its subtree cost cap, disables zero marginal cost, and increases token assumptions. It cannot introduce routing beneath a non-routed root.

## Human-Reviewable Contract

Graph nodes have no `task`; their schema is closed. For each graph node, record
outside the node or in its child agent tasks:

- Reason the child is a meaningful composition boundary.
- Exact imported `path` or inline `swarm`.
- Child workspace, project/DAG ownership, and overlap implications.
- Parent scheduling edges and the exact handoffs child consumers read.
- For `repeat`, one terminal decision owner, its `submit_repeat_decision` action,
  overwrite behavior, missing-decision behavior, rerun safety, and terminal
  success/failure.
- For `control`, decision predicates, reachable targets, and correction owners.
- Resume identity, versions, and policy when external restart may reuse it.

Do not add task-like sibling properties to a graph node.

## Fixed Graph Repeat

```yaml
repeat:
  max_rounds: 3
  stop_signal: .omp-swarm/source-change/run/signals/review-round.txt
  success_value: ACCEPTED
  continue_value: CHANGES_REQUESTED
```

All four fields are required:

| Field            | Contract                                                    |
| ---------------- | ----------------------------------------------------------- |
| `max_rounds`     | Integer `>= 1`; hard execution limit.                       |
| `stop_signal`    | Safe workspace-relative status path written by the runtime. |
| `success_value`  | Non-empty value emitted for tool action `complete`.         |
| `continue_value` | Non-empty value emitted for tool action `continue`.         |

Give exactly one terminal agent ownership of the repeat decision. That agent
must invoke `submit_repeat_decision` exactly once per round:

```json
{ "action": "complete" }
```

or:

```json
{ "action": "continue" }
```

The agent never writes `stop_signal` or copies `success_value` /
`continue_value`; the tool maps the semantic action to the configured value and
writes the file atomically. `scope` is omitted when one repeat channel is
available and is required only when the tool reports multiple scopes.

`repeat` is valid only on graph nodes. A repeated child must declare
`target_count: 1`.

After each child run, the parent reads `stop_signal` from the shared project
workspace. A missing tool submission, an unexpected value, or `continue` after
the final allowed round fails the graph node. Use `repeat` only when every round
has the same graph shape and source edits are idempotent against the
already-modified project tree.

Use graph `repeat` for a fixed review/refinement protocol. Use node `control` when a reviewer must choose a particular upstream target to rewind. Do not combine loops unless both boundaries are independently necessary.

## Child Design

A child graph is a reusable orchestration boundary, not a filesystem sandbox. Give it:

- A standalone-valid `workspace` and positive `concurrency`.
- Project-relative tasks that also make sense in the parent's workspace.
- Source ownership that does not overlap concurrent parent or sibling writers.
- Child-specific DAG-owned reports/signals to prevent path collisions.
- `target_count: 1` when the parent applies `repeat`.

Validate the root YAML only after every file-backed child exists; validation recursively hydrates file-backed and inline child graphs, rejects import cycles, and prints the root graph's waves.
