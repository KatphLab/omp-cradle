---
name: writing-omp-spec-to-code-dags
description: Use when a bounded normative specification must become reviewed contracts, executable RED tests, implementation, and independent acceptance in an existing project.
---

# Writing OMP Spec-to-Code DAGs

## Core Principle

Lean means one boundary per proof obligation, not one agent doing everything. Freeze the behavior contract, approve the test plan, prove RED, implement GREEN, then review current source and evidence.

**REQUIRED BACKGROUND:** Use `writing-omp-swarm-dags` and `writing-red-tests` first.

## Start Here

Copy [spec-to-code.yaml](templates/spec-to-code.yaml), then set:

1. `swarm.name`, `workspace`, and every `.omp-swarm/<name>/` path.
2. `PROJECT_ANCHOR` to an exact file proving project identity.
3. The operator-owned specification path.
4. Model budget and usage estimates when different bounds are needed.

Do not add a ledger, item queue, nested graph, approval database, or event log unless the operator explicitly requires resumable multi-run processing.

## Workflow

```text
plan -> contract -> review_design -> red -> review_red -> implement -> review
 ^        ^              |          ^          |            ^          |
 |________|______________|__________|__________|____________|__restart_|
```

| Node            | Proof obligation                                                                                                      | Mutable project scope     |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `plan`          | Every requirement has a citation, acceptance condition, owned paths, test scenario, and fixed project-native commands | none                      |
| `contract`      | Public boundaries, types, errors, invariants, defaults, side effects, and compatibility are explicit                  | none                      |
| `review_design` | The test plan and contract are complete and implementable                                                             | none                      |
| `red`           | Approved tests call the public boundary, assert exact behavior, and fail for the expected missing behavior            | test paths only           |
| `review_red`    | RED tests are behavior tests, not placeholders, mocks, import smoke tests, or framework checks                        | none                      |
| `implement`     | Production code makes the accepted RED tests pass without changing them                                               | implementation paths only |
| `review`        | Current source satisfies the specification and the complete project gate passes                                       | none                      |

## Test-Plan Contract

For every normative requirement, `plan.md` must name:

- stable ID and exact source citation;
- public boundary to call;
- realistic input and exact output, error, state change, event, or rendered result;
- the plausible implementation bug the test prevents;
- exact test and implementation paths; and
- targeted RED command plus the established full project gate as fixed `program`, `args`, `cwd`, ordered `executors`, and bounded mutable-output records.

`review_design` accepts this plan before any test is written. It rejects missing behavior coverage, vague assertions, ownership overlap, commands invented from specification prose, or a change too broad for one implementation owner.

Each command declares every path it may write and whether the executor preserves or removes it. Its ordered executors are drawn only from `red`, `review_red`, `implement`, and `review`; ownership transfers serially between them. Reject commands with unknown writers or unbounded writes.

## Contract and RED Gates

`contract.md` freezes only observable behavior. It does not add production stubs.

A valid RED test imports and calls the planned public API and asserts an exact observable result. Missing-module or missing-symbol failure is valid only when that symbol is the approved boundary. Infrastructure failure, `assert true`, existence checks, broad mocks, snapshots without semantic assertions, and tests that can pass without the implementation are blocked.

`review_red` reruns and accepts RED evidence before implementation starts. Implementation never edits accepted tests. If behavior already exists, RED may report `ALREADY_SATISFIED`, but the reviewer must still prove the test would fail for a plausible behavioral defect.

## Recovery

- Requirement coverage, paths, or command defect → restart `plan`.
- Public API, error, invariant, or compatibility defect → restart `contract`.
- Test code or RED-evidence defect found before implementation → restart `red`.
- Production behavior or implementation-report defect → restart `implement`.
- Missing or malformed RED-review evidence before any production mutation → restart `review_red`; after mutation → fail safely.
- A semantic plan, contract, or test defect discovered after implementation → fail safely; do not fabricate RED evidence against an already-modified tree.

Restarts preserve the project tree. Each writer reconciles current files, reads the finding, and replaces only its own evidence.

## Acceptance

Completion requires hash-matched accepted design and RED reviews, unchanged accepted tests, every requirement observed against current production code, targeted tests passing GREEN, the full project gate passing, and one authoritative `final-review.control.yaml` whose evidence supports `action: continue`.

Before delivery, run `omp-swarm validate` and `omp-swarm plan-models` on the copied DAG. Confirm the seven serial waves, workspace, anchor, ownership sets, fixed commands, and every correction target.
