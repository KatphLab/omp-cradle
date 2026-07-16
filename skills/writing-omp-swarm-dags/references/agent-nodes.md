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

Write `task` in this order:

1. **Outcome:** one coherent project behavior, decision, or deliverable.
2. **Inspect:** exact project paths when known; otherwise a bounded discovery scope and the plan/manifest to produce.
3. **Read:** upstream project state and exact DAG-owned handoffs or reports.
4. **Edit:** owned project files or the upstream ownership manifest that defines them.
5. **Do not edit:** unrelated modules, sibling-owned paths, runtime `.swarm_*`, and other user work.
6. **Verify:** focused observable behavior or project command.
7. **Report/control:** exact evidence and signal paths required by consumers.
8. **Retry/failure:** behavior when files are already modified, inputs are missing, or verification fails.

Do not force exact source filenames before investigation can know them. Instead, give one investigation node a bounded project scope and have it write the exact path/ownership plan consumed by the implementer.

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
- Reject with concrete findings and restart the upstream implementer.
- Fail when safe completion is impossible.

On restart, the implementer sees its existing edits; no filesystem rollback occurs. Its task must read the review report, inspect current source, and repair idempotently. A reviewer must not claim independence after modifying the source it approves.

Ordinary source changes need no publisher agent. Add a terminal publisher only for a generated or single replaceable artifact that genuinely requires staged atomic promotion.
