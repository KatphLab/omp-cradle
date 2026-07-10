---
name: reviewing-omp-swarm-dags
description: Use when auditing, approving, or debugging an OMP swarm YAML DAG, especially before execution or when validation passes but runtime safety, scheduling, recovery, cost, or completion remains uncertain.
---

# Reviewing OMP Swarm DAGs

## Core Principle

`Validation: ok` is necessary, not approval. Prove workspace mutations, failure propagation, and terminal acceptance.

**REQUIRED SUB-SKILL:** Use `writing-omp-swarm-dags`; read its always-required references and every route matching the root and imported graphs.

## Evidence First

1. Read the complete root YAML and every import.
2. Run and record the exact command, result, and waves:

```bash
omp-swarm validate path/to/swarm.yaml
```

If unavailable, say `Not run`.

3. Resolve `swarm.workspace` from the root YAML directory. Verify project anchors and inspect only named project paths needed to check task, command, and ownership claims.
4. Do not execute or edit the DAG unless requested. Mark unproved claims `[INFERENCE]`.

## Critical Review Order

Review backward from terminal acceptance:

| Area                | Required evidence                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acceptance          | Trace every success path. Final review is independent; Bash non-zero settles, so failure needs an exit marker and downstream decision.                                                            |
| Topology            | Printed waves match required edges; any explicit edge disables implicit local chaining.                                                                                                           |
| Workspace/ownership | The resolved workspace is the intended project. Same-wave agents, Bash, and imports share it and have disjoint mutable paths.                                                                     |
| Data                | Each handoff defines producer, path, format, consumer, and invalid/missing behavior. Edges schedule only.                                                                                         |
| Lifecycle/recovery  | Evidence is fresh; cleanup touches only the literal DAG `run/`, never `.swarm_*`; signals have exact producers/grammar; reruns are idempotent because files are not rolled back.                  |
| Fitness             | Every agent, model, concurrency slot, loop, staging step, and publisher has a concrete need. Flag destructive commands, security violations, unsupported fields, and project-contradicted claims. |

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
4. **Findings** — descending severity; each has `Location`, `Evidence`, `Runtime impact`, `Smallest correction`.
5. **Confirmed strengths** — evidence worth preserving.
6. **Residual uncertainties** — missing inputs and `[INFERENCE]`.

Prioritize approval-changing findings and combine common causes. Prefer deleting a mechanism with no distinct purpose over completing its plumbing. Give bounded corrections, not replacement YAML, unless requested. If no findings exist, say so.

## Example Finding

```text
[P0] Failed check can still produce completion
Location: nodes.check, nodes.finish; W2:[check] -> W3:[finish]
Evidence: check writes check.txt without an exit marker; finish treats file existence as success.
Runtime impact: Bash settles on non-zero, so finish can approve a failing project check.
Smallest correction: record CHECK_EXIT, require an independent decision node to read it, and emit fail/restart instead of unconditional completion.
```

## Common Rationalizations

| Claim                                      | Fact                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| “It validates.”                            | Validation does not execute, inspect workspace, prove ownership, or gate Bash. |
| “Failed Bash stops dependents.”            | Dependents may run after settlement; require a decision.                       |
| “Agents are isolated / edges carry data.”  | Root/child nodes share workspace; edges only schedule.                         |
| “Restart is clean.”                        | It reuses state and edits; no rollback occurs.                                 |
| “More agents mean coverage.”               | Valueless boundaries add cost and handoff risk.                                |
| “Authority, deadline, or cost settles it.” | None changes runtime evidence.                                                 |

## Red Flags

Stop before approval when a review skips validation/waves, treats validation as sufficient, guesses runtime or project behavior, assumes isolation/success propagation/rollback/data transport, reviews reports instead of the mutation and acceptance path, or rewrites the DAG instead of giving bounded corrections.

Gather evidence and revise the review before issuing a verdict.
