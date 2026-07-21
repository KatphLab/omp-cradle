---
name: writing-omp-swarm-dags
description: Use when authoring or revising OMP swarm YAML DAGs, especially when agents edit shared projects, models need cost-aware routing, reviewers can request corrections, or runs must restart or resume safely.
---

# Writing OMP Swarm DAGs

## Core Principle

A DAG is a mutation, evidence, and recovery contract. Draw edges only after every mutable project and coordination path has a current owner and every rejection has a reachable correction owner.

**REQUIRED SUB-SKILL:** Use `writing-omp-spec-to-code-dags` when normative requirements are processed as durable, resumable implementation items.

## Read Before Authoring

| Trigger                         | Required reference                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Every DAG                       | [Project Workflows](references/project-workflows.md), [Root and Scheduling](references/root-and-scheduling.md) |
| Any agent                       | [Agent Nodes](references/agent-nodes.md), [Artifact Lifecycle](references/artifact-lifecycle.md)               |
| Any Bash node                   | [Bash Nodes](references/bash-nodes.md)                                                                         |
| Any child graph or repeat       | [Graph Nodes](references/graph-nodes.md)                                                                       |
| Any control, restart, or resume | [Control and Recovery](references/control-and-recovery.md)                                                     |
| Every agent DAG                 | [Model Routing](references/model-routing.md)                                                                   |

Read each selected reference completely. Templates illustrate topology; the references define runtime behavior.

## Authoring Order

1. Resolve the YAML path, project workspace, stable project anchors, observable completion criteria, exact project commands, and mutable, inspect-only, and forbidden scopes.
2. Build the mutation ledger before nodes:

   | Path or pattern | Kind | Initial writer | Transfer boundary | Later writer | Consumers |
   | --------------- | ---- | -------------- | ----------------- | ------------ | --------- |

   Include project files, handoffs, reports, controls, repeat signals, durable status, and command outputs. Every mutable path has exactly one current writer. Same-wave writers are disjoint.

3. Build a correction matrix for every possible rejection:

   | Rejected predicate | Required mutation | Current owner | Restart target | Owner in invalidated suffix | Evidence regenerated |
   | ------------------ | ----------------- | ------------- | -------------- | --------------------------- | -------------------- |

   Reject any row without a reachable current owner.

4. Draw the smallest graph that preserves those ownership and recovery boundaries. An agent boundary must earn its cost through independent parallel work, distinct expertise/model needs, a retry boundary, or independent acceptance.
5. Write every agent task with the contract below.
6. Add explicit edges. Once one local edge exists, declaration order supplies no missing edges.
7. Prove bootstrap, success, failure, restart, and resume paths from current files—not assumed rollback or hidden agent memory.

## Agent Task Contract

Every agent `task` MUST use these headings in this order:

```markdown
### Goal

One coherent outcome owned by this node.

### Inputs

Exact upstream artifacts and project scope; include IDs, hashes, or bounded discovery.

### Files to touch

Every mutable project and DAG-owned path, its schema or allowed change, and any transfer.

### Task

Ordered decisions and actions. State how review deltas and current files are reconciled.

### Outputs

Observable project result, report status, evidence, and control decision.

### Rules

Forbidden paths, authority limits, independence, and non-assumptions.

### Retry and failure

Idempotent rerun behavior, stale/missing input handling, blockers, and limits.
```

Do not bury required inputs or ownership in prose such as “inspect as needed.” Unknown source paths require bounded discovery plus an exact ownership manifest before mutation.

## Route Models by Default

Every DAG containing agents MUST enable root `model_routing` unless the user explicitly requires fixed model selection. Do not defer routing as cleanup.

- Set a complete root policy: allowed built-in aliases, quality floor, cost cap, zero-cost assumption, and default usage.
- Give every agent a `workload.profile` matching its job and a complete per-attempt `estimated_usage`. Planning and review are not generic implementation workloads.
- Let imported children inherit the root policy; a child may only narrow it.
- `allowed_aliases` contains exact base aliases such as `pi/smol`, `pi/task`, `pi/default`, `pi/slow`, `pi/plan`, and `pi/advisor`. Bare `fast`, `default`, or `slow` and concrete provider IDs are invalid while routing is enabled.
- Run authenticated `omp-swarm plan-models <root.yaml>` before delivery. If it cannot run, report `Not run` and the exact blocker; never claim routing is resolved.

## Ownership and Reviewer Corrections

A reviewer owns only its review report and `.yaml` control signal. It inspects actual source and current evidence; it does not repair what it approves. Control targets are local node IDs and use the exact grammar in [Control and Recovery](references/control-and-recovery.md).

Each finding states `evidence`, `required_mutation`, `owner`, and `acceptance_check`. Route by mutation owner:

- Source or implementer-report defect → restart the owning implementer; downstream checks and reviewer rerun and replace their own evidence.
- Plan or handoff defect → restart that artifact's producer, then all dependent writers and acceptance nodes.
- Durable ledger or status defect → restart the current ledger/status owner, not whichever implementer is convenient.
- Review/control defect → rerun the review boundary that owns it.

A review request never grants write access. Do not ask an implementer to update a reviewer report, control signal, sibling report, or frozen status file. Bounded retries only cap failure; they do not make an unreachable mutation recoverable.

## State and Recovery

Keep three layers distinct:

- Project files: the deliverable.
- DAG-owned durable state and current-run handoffs/reports/signals under `.omp-swarm/<name>/`.
- Runtime-owned `.swarm_*`: never read or edit from DAG nodes.

A fresh normal run may rebuild only the literal DAG-owned `run/` subtree after verifying project anchors. Restart preserves current source and artifacts. Every writer must reconcile current files and overwrite or version its own evidence atomically.

## Validate and Deliver

Run from the exact root DAG:

```bash
omp-swarm validate path/to/swarm.yaml
omp-swarm plan-models path/to/swarm.yaml
```

Delivery includes `Validation: ok`, printed waves, resolved workspace and anchors, the mutation ledger, the correction matrix, routing-plan result, DAG-owned artifact root, and exact project verification commands. Validation is not proof of ownership or recovery; inspect both matrices manually.

## Common Failures

| Shortcut                                                | Failure                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| “One capable implementer keeps the graph short.”        | It couples unrelated requirements and status ownership; use it only for one coherent bounded change.    |
| “Assign fast/default/slow models manually.”             | This skips policy, capability, cost, and restart-stable routing.                                        |
| “The reviewer can tell the implementer what to update.” | A request does not transfer ownership; restart the actual writer.                                       |
| “The loop is bounded.”                                  | An unreachable correction still deterministically exhausts the bound.                                   |
| “The YAML validates.”                                   | Validation cannot prove project identity, mutable-path exclusivity, evidence freshness, or convergence. |
