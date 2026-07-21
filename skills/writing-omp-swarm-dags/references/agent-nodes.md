# Agent Nodes

Read this complete file when the new DAG contains an `agent` node.

## Fields

```yaml
implement:
  type: agent
  role: TypeScript feature implementer
  task: |
    Inspect the bounded project scope and edit the assigned source paths.
  extra_context: Preserve existing project conventions.
  model: pi/slow
  tools: [read, write]
  waits_for: [investigate]
  reports_to: [check]
```

| Field           | Required | Contract                                                                                            |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `type`          | yes      | Exactly `agent`.                                                                                    |
| `role`          | yes      | Non-empty role used in the system prompt.                                                           |
| `task`          | yes      | Non-empty objective and project-state contract.                                                     |
| `extra_context` | no       | Additional system-prompt context; do not hide required task inputs or outputs here.                 |
| `model`         | no       | Non-empty node override; otherwise this graph's `swarm.model` or configured default applies.        |
| `workload`      | no       | Routing profile plus optional replacement token estimate; read `model-routing.md`.                  |
| `tools`         | no       | Non-empty unique string list selecting native built-in tools; omitted means unrestricted built-ins. |
| `waits_for`     | no       | Local upstream IDs; semantics live in `root-and-scheduling.md`.                                     |
| `reports_to`    | no       | Local downstream IDs; semantics live in `root-and-scheduling.md`.                                   |
| `control`       | no       | Agent/graph-only control object; read `control-and-recovery.md`.                                    |

`tools` is an initial native built-in allowlist, not a non-escalatable security boundary. Names are trimmed and must be unique; unknown or unavailable names are omitted by the native registry. Subprocess agents additionally receive the mandatory `irc` and hidden `yield` tools when runtime gates permit them. Discovered extension/custom tools remain active, and a selected discovery or extension tool may activate more tools later. Do not use this field to claim a strict all-registry sandbox.

Every agent runs with the resolved swarm workspace as its working directory. Agent nodes have no separate `cwd` field and no per-node worktree. Imported child agents also use the root run's workspace.

Agents are independent invocations. They share current filesystem state, not hidden conversation memory. A downstream agent must read the actual project paths and declared handoff files it needs.

## Task Contract

Every `task` uses these headings in this exact order:

1. `### Goal`: one coherent behavior, decision, or deliverable.
2. `### Inputs`: exact upstream artifacts and project paths; when paths are unknown, a bounded discovery scope and required ownership manifest.
3. `### Files to touch`: every mutable project and DAG-owned path, the allowed change or schema, and any ownership transfer.
4. `### Task`: ordered actions, verification decisions, and current-source/review-delta reconciliation.
5. `### Outputs`: observable result, evidence, status, and control decision.
6. `### Rules`: forbidden paths, authority, independence, and non-assumptions.
7. `### Retry and failure`: idempotence, stale or missing input handling, blockers, and bounded failure.

Do not force exact filenames before investigation can know them. Give one investigation node a bounded project scope; it writes the exact ownership manifest before any project modifier runs.

Status is relative to the producing node's objective. A discovery node that completely identifies absent or defective target implementation is READY with gaps to implement. It is BLOCKED only when unavailable or malformed authority, unresolved contradiction, or another missing prerequisite prevents complete discovery.

## Choosing Agent Boundaries

An agent node earns a boundary through at least one of:

- Independent work that can safely run in parallel.
- Distinct expertise, permissions, or model needs.
- A meaningful retry or failure boundary.
- Independent review before acceptance.
- A project scope too large for one reliable context.

Otherwise merge it with its producer or consumer. Do not create one agent per small source file or checklist item. Do not replace many tiny nodes with one agent that owns unrelated modules, implementation, and its own approval.

A modifying agent may coherently own production source, directly coupled tests, and local configuration for one feature. Split when agents would own independent outcomes. Serialize or add one integrator when paths may overlap.

## Review and Correction

Reviewers inspect the actual project tree and focused check evidence. A read-only reviewer may:

- Accept and write `action: continue` through control.
- Reject with findings that state evidence, required mutation, current owner, and acceptance check.
- Fail when safe completion is impossible.

Route the restart by the required mutation, not by convenience. A source defect targets the source owner; a plan, report, ledger, status, or control defect targets that artifact's current writer. The invalidated suffix must also contain every downstream node that must regenerate evidence.

Inspecting or recovering a handoff does not grant permission to rewrite it. A reviewer never asks an implementer to update the review report, control signal, sibling report, or frozen status file. If the actual writer is unreachable, acceptance must use newer authoritative evidence or the reviewer must fail.

On restart, source files and reports are not rolled back. Each requeued writer reads current files and matching review deltas, repairs only its ownership, and atomically replaces its own evidence. A reviewer cannot claim independence after modifying the source it approves.

Ordinary source changes need no publisher agent. Add a terminal publisher only for a generated or single replaceable artifact that genuinely requires staged atomic promotion.
