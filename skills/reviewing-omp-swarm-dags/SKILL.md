---
name: reviewing-omp-swarm-dags
description: Use when auditing, approving, or debugging an OMP swarm YAML DAG, especially when validation passes but ownership, restart loops, recovery, runtime safety, cost, or terminal completion remains uncertain.
---

# Reviewing OMP Swarm DAGs

## Core Principle

`Validation: ok` is necessary, not approval. Prove workspace mutations, correction ownership, failure propagation, and terminal acceptance.

**REQUIRED SUB-SKILL:** Use `writing-omp-swarm-dags`; read its always-required references and every route matching the root and imported graphs.

## Evidence First

1. Read the complete root YAML and every import.
2. Run and record the exact command, result, and waves:

```bash
omp-swarm validate path/to/swarm.yaml
```

If unavailable, say `Not run`.

3. Resolve `swarm.workspace` from the root YAML directory. Verify project anchors and inspect only named project paths needed to check task, command, and ownership claims.
   If current-run DAG artifacts exist, inspect the exact handoffs, reports, and
   control signals needed to test status and ownership claims; never inspect
   runtime-owned `.swarm_*`.
4. Do not execute or edit the DAG unless requested. Mark unproved claims `[INFERENCE]`.

## Critical Review Order

Review backward from terminal acceptance:

| Area                    | Required evidence                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acceptance              | Trace every success path. Final review is independent; Bash non-zero settles, so failure needs an exit marker and downstream decision.                                                                             |
| Agent tasks             | Every non-trivial `task:                                                                                                                                                                                           | ` has the ordered Outcome, Inputs/read, Scope, Decision, Acceptance, Outputs, Control, and Retry sections; no task-like sibling properties. |
| Correction reachability | For every possible open finding, name the required mutation, its owner, allowed restart target, and whether the rewound subgraph contains an authorized writer.                                                    |
| Topology                | Printed waves match required edges; any explicit edge disables implicit local chaining.                                                                                                                            |
| Workspace/ownership     | The resolved workspace is the intended project. Same-wave agents, Bash, and imports share it and have disjoint mutable paths.                                                                                      |
| Data                    | Each handoff defines producer, path, format, required fields, consumer, overwrite/versioning, and invalid/missing behavior. Edges schedule only; they do not transport data or prove success.                      |
| Node-type contract      | Bash declares command/cwd/mutations/output/marker/interpreter/rerun safety; graph composition declares child workspace/ownership, parent edges, repeat/control stop behavior, terminal behavior, and rerun safety. |
| Lifecycle/recovery      | Evidence is fresh; cleanup touches only the literal DAG `run/`, never `.swarm_*`; reruns are idempotent; resume IDs/versions/policies match semantic reuse and runtime evidence limits.                            |
| Fitness                 | Every agent, model, concurrency slot, loop, staging step, and publisher has a concrete need. Flag destructive commands, security violations, unsupported fields, and project-contradicted claims.                  |

## Fast Contract Checks

A review is incomplete until it can answer without inferring intent:

1. Who owns every mutable project and DAG-artifact path in each phase?
2. What exact behavior and evidence prove each node succeeded?
3. How does every consumer locate and validate each input?
4. Can every restart target requeue an authorized writer that changes the
   failing predicate?
5. Will every rerun safely handle existing edits and artifacts?

For each non-trivial agent, require the `agent-nodes.md` labels in order. A
section may say `Not applicable`, `No handoff required`, or `No control signal`
only when the conditional contract truly does not apply. The runtime forwards
`task` as one unparsed string; validator success cannot prove heading content.

Only agent nodes have `task`. The Bash and graph schemas are closed; reject
task-like sibling properties rather than requesting `inputs`, `writes`, or
`acceptance` fields.

## Resume and Restart Gate

For every node, resolve the normalized resume contract: stable unique `id`,
positive `contract_version` and `state_version`, and `preserve`,
`inputs-unchanged`, `strict`, or `never`. Omitted values normalize to node name,
version `1`, version `1`, and `preserve`; omission is safe only when that reuse
contract is actually intended.

Check semantic version discipline and runtime limits:

- `contract_version` changes with outcome/input/output/acceptance meaning;
  `state_version` changes only for incompatible persisted-result state.
- `preserve` tolerates definition drift; `strict` does not.
- `inputs-unchanged` additionally needs matching upstream references, output
  evidence, exact definition, and unchanged workspace checkpoint.
- `never` reruns; use it where an old verdict or effect is never sufficient.
- `--reuse` cannot override missing/malformed state or output evidence, changed
  workspace checkpoint, type/state-version mismatch, or upstream rerun.

Runtime fingerprints do not replace semantic handoff validation. Reviewers must
still inspect producer, path, format, fields, consumer, freshness, and
invalid-output behavior.

## Correction Reachability Gate

Before a verdict, build this matrix for every class of terminal defect the
reviewer may keep open, including nonzero command markers and missing, malformed,
or blocked handoffs:

```text
Finding/evidence:
Required mutation:
Current writer:
Allowed restart target:
Authorized writer in rewound subgraph:
Reachable: yes/no
```

Rereading or recovering information does not grant ownership of its artifact.
If acceptance requires an upstream coordination file to change, its writer must
be requeued; otherwise acceptance must judge the downstream recovery evidence
instead of the stale file status. A reviewer must not label a finding
`correctable` and restart a node that cannot mutate its required path.

Also trace bootstrap readiness. Missing implementation that the DAG exists to
create is an analysis requirement, not a missing input. If it blocks the plan
that authorizes its own implementer, completion is impossible.

An unreachable correctable finding or circular readiness gate is `P0`. Bounded
restart limits convert a futile loop into eventual failure; they do not make it
convergent.

## Severity and Verdict

- `P0`: wrong/destructive target, security failure, false success, impossible completion, or verification bypass.
- `P1`: likely nondeterminism, stale evidence, blind retry, unverifiable acceptance, material contract gap, or unjustified cost.
- `P2`: clarity, redundancy, maintainability, or minor cost without demonstrated wrong behavior.

Verdict: `REJECT` for validation failure or `P0`; `CHANGES REQUIRED` for `P1`; `APPROVE` only after successful validation with no `P0/P1`; `UNVERIFIABLE` when required YAML/imports or validator access are missing.

One finding covers one defect and cites an exact node, field, edge, wave, command, or path. Do not inflate severity.

## Output Contract

Return, in order:

1. **Verdict** — decisive reason.
2. **Validation** — command, result, waves.
3. **Workspace and ownership** — resolved path, same-wave writers.
4. **Findings** — descending severity; each has `Location`, `Evidence`, `Runtime impact`, `Correction owner/restart reachability`, and `Smallest correction`.
5. **Confirmed strengths** — evidence worth preserving.
6. **Residual uncertainties** — missing inputs and `[INFERENCE]`.

Prioritize approval-changing findings and combine common causes. Prefer deleting a mechanism with no distinct purpose over completing its plumbing. Give bounded corrections, not replacement YAML, unless requested. If no findings exist, say so.

## Example Finding

```text
[P0] Failed check can still produce completion
Location: nodes.check, nodes.finish; W2:[check] -> W3:[finish]
Evidence: check writes check.txt without an exit marker; finish treats file existence as success.
Runtime impact: Bash settles on non-zero, so finish can approve a failing project check.
Correction owner/restart reachability: implement owns the source correction and is requeued with check and finish.
Smallest correction: record CHECK_EXIT, require an independent decision node to read it, and emit fail/restart instead of unconditional completion.
```

## Common Rationalizations

| Claim                                      | Fact                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| “It validates.”                            | Validation does not execute, inspect workspace, prove ownership, or gate Bash.                           |
| “Failed Bash stops dependents.”            | Dependents may run after settlement; require a decision.                                                 |
| “Agents are isolated / edges carry data.”  | Root/child nodes share workspace; edges only schedule.                                                   |
| “Restart is clean.”                        | It reuses state and edits; no rollback occurs.                                                           |
| “The integrator can recover it.”           | Recovery supplies information; it does not grant write ownership of a blocked analysis, plan, or report. |
| “The loop is bounded.”                     | Exhausting retries on an unreachable finding is deterministic failure, not recovery.                     |
| “The reviewer can find anything.”          | A restartable finding needs an authorized correction owner in the rewound subgraph.                      |
| “More agents mean coverage.”               | Valueless boundaries add cost and handoff risk.                                                          |
| “Authority, deadline, or cost settles it.” | None changes runtime evidence.                                                                           |

## Red Flags

Stop before approval when a review skips validation/waves or the correction-reachability matrix, treats validation as sufficient, guesses runtime or project behavior, assumes isolation/success propagation/rollback/data transport, calls an unreachable finding correctable, requires a stale upstream artifact to change without requeuing its writer, reviews reports instead of the mutation and acceptance path, or rewrites the DAG instead of giving bounded corrections.

Gather evidence and revise the review before issuing a verdict.
