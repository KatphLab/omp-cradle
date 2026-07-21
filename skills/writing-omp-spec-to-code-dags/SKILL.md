---
name: writing-omp-spec-to-code-dags
description: Use when an OMP swarm must turn multiple normative requirements into code through resumable items, approval-gated behavior checks, durable acceptance evidence, or cross-item ownership transfers.
---

# Writing OMP Spec-to-Code DAGs

## Core Principle

Process one stable requirement item through independently reviewable phases, then commit one immutable acceptance event. Durable state tracks progress; current-run artifacts coordinate the active attempt; reviewers never borrow another node's write access.

**REQUIRED BACKGROUND:** Use `writing-omp-swarm-dags` first. Its task, model-routing, ownership, recovery, and validation contracts remain mandatory.

## Start from the Structured Template

Use [spec-to-code.yaml](templates/spec-to-code.yaml) with all files under [templates/graphs](templates/graphs). Copy and adapt the complete graph family; do not flatten it into one YAML or one cross-requirement implementer merely to shorten the DAG.

The template has three orchestration levels:

```text
root: prepare_index -> process_one_item (bounded repeat) -> full_project_check -> completion_audit
item: select_or_resume -> contract -> behavior_plan -> red_evidence -> implementation -> advance_item
phase: plan/implement -> project-native check -> independent review -> parent control
```

The implementation phase fans out only independent behavior and static checks, then fans into one end-to-end reviewer.

## Preserve the State Layers

| Layer          | Contents                                                        | Writers                         |
| -------------- | --------------------------------------------------------------- | ------------------------------- |
| Operator input | specification sources, test approvals, accepted deviations      | Operator only; DAG is read-only |
| Durable state  | specification index, item ledger, active batch, approval pauses | Explicit phase-current owners   |
| Current run    | `meta/`, `handoffs/`, `reports/`, `signals/`, `scratch/`        | One named node per path         |
| Audit          | immutable accepted item events keyed by batch/item/selection    | `advance_item` only             |
| Runtime        | `.swarm_*`                                                      | OMP only                        |

`prepare_index` verifies project anchors, reconciles input fingerprints with durable state, and rebuilds only the literal current-run subtree. It preserves unaffected ledger records, approvals, pauses, and accepted events. A missing implementation is a requirement finding, not a preparation blocker.

## Use Stable Item Contracts

The specification index gives every item stable IDs, citations, fingerprints, acceptance criteria, dependencies, public interfaces or bounded discovery, and these ownership sets:

- `contract_only_paths`: contract phase owns them; later implementation cannot edit them.
- `implementation_only_paths`: implementation phase owns them.
- `shared_paths`: contract implementer owns them first; ownership transfers to implementation only after accepted contract review.
- `forbidden_paths`: no item phase may edit them.

Same-item shared paths are safe only because their writers are serialized and the transfer boundary is explicit. Cross-item mutable overlap requires an explicit dependency transfer and successor revalidation of affected predecessor criteria. Otherwise repartition or serialize before execution.

One child round selects or resumes exactly one item and one `selection_id`. Every artifact matches batch, item, selection, specification, input, plan, ownership, and source fingerprints before mutation. Item, pass, approval-resume, graph-repeat, and restart limits are durable bounds; a rerun never double-charges a counter.

## Keep Phase Responsibilities Separate

| Phase          | Writer path                                                                     | Acceptance boundary                                                   |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Contract       | plan exact observable interfaces; implement only contract ownership             | contract check + independent contract review                          |
| Behavior plan  | map each criterion to real observable scenarios and a project-native invocation | independent plan/approval review                                      |
| Red evidence   | create and execute an approved reproduction against pre-change behavior         | review proves expected missing behavior or already satisfied behavior |
| Implementation | implement only missing behavior in implementation and transferred shared paths  | parallel targeted behavior/static checks + end-to-end item review     |
| Advance        | hash current evidence and changed files; update ledger/batch exactly once       | immutable acceptance event                                            |

Every agent task uses the seven mandatory headings from `writing-omp-swarm-dags`. `Files to touch` lists exact schemas and ownership transfers; `Retry and failure` states idempotence and stale-evidence behavior.

## Make Reviewer Corrections Reachable

The terminal reviewer in each child phase owns that phase's review report. It also writes the parent graph node's control signal. Findings name the required mutation, current owner, and acceptance check.

- Interpretation defect → `select_or_resume_item`.
- Contract defect → `contract_phase`.
- Scenario or approval-plan defect → `behavior_plan_phase`.
- Reproduction or execution-evidence defect → `red_evidence_phase`.
- Plan, source, ownership-transfer, or focused-check defect → `implementation_phase`.

Restart the earliest phase that owns the rejected predicate; the invalidated suffix must also regenerate every later check and review. The implementer reads matching review deltas and edits only its source and report. It never updates review reports, control signals, the ledger, or acceptance events.

Durable ownership transfers are explicit:

1. `prepare_index` initializes or reconciles the item ledger and active batch.
2. `select_or_resume_item` owns ledger selection fields, then relinquishes the ledger.
3. `advance_item` reacquires ledger ownership, owns the active batch for settlement, and writes the immutable acceptance event.
4. `completion_audit` owns batch-level reopening/closure after the repeated graph settles.
5. The next normal run transfers reconciliation ownership back to `prepare_index`.

A batch audit may restart item processing only after reopening the exact owning item in durable state. It never asks a source implementer to patch status directly.

Control targets are local to the YAML that declares them. A root `completion_audit` cannot target child node `advance_item`; for a ledger, event, or accepted-source defect it reopens the exact item and restarts parent node `process_one_item`. The child reruns idempotently until `advance_item` reacquires settlement ownership. An item reviewer runs before settlement and therefore cannot diagnose an acceptance-event hash that does not exist yet.

## Adapt in This Order

1. Set the root and every child `workspace` to the same verified project root. Change DAG names and the complete `.omp-swarm/<name>/` artifact root consistently.
2. Define exact revisioned operator input schemas, authority, source precedence, approval matching, and accepted-deviation matching.
3. Adapt item manifest fields and phase applicability without removing ownership or fingerprint fields needed by acceptance.
4. Create the mutation ledger and correction matrix required by `writing-omp-swarm-dags`; include every durable state transfer.
5. Enable root model routing. Keep a workload profile and complete usage estimate on every agent; child graphs inherit the root policy.
6. Keep fixed procedures as program/args/cwd data. Never construct shell commands from specification text.
7. Validate the root recursively and inspect every printed wave. Then run authenticated model planning. Authoring does not execute the swarm unless the user separately requests execution.

## Acceptance Gate

Completion requires all of the following:

- Full project-native verification passes with current command evidence.
- Every claimed item has one current, hash-matched, independently accepted event.
- Every critical criterion and transferred predecessor criterion has observable evidence.
- Every accepted deviation and approval matches the exact requirement and fingerprints.
- No pending, impacted, reopened, blocked, or ownerless finding remains.
- The final batch decision and control action agree.

Reaching an item limit produces `NEXT_RUN_REQUIRED`, not false completion or a restart that evades the bound.

## Common Failures

| Shortcut                                                | Failure                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| One implementer owns all requirements and global status | Shared context, stale status, and cross-item correction become inseparable.            |
| Reviewer asks implementer to change a phase status      | The implementer does not own it; rerun the status writer and dependent evidence chain. |
| Accepted ledger entry is treated as acceptance          | The immutable, hash-matched event and current source are authoritative evidence.       |
| Normal-run cleanup deletes all DAG state                | Resume history, approvals, counters, and accepted events are lost.                     |
| A source change skips predecessor revalidation          | Later items can silently invalidate already accepted behavior.                         |
