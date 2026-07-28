# Agent Nodes

Use only when `SKILL.md` routes here. Return to its table before opening any linked reference.

## Fields

```yaml
implement:
  type: agent
  role: TypeScript feature implementer
  task: |
    Outcome:
    - Implement the planned behavior in the existing project.

    Inputs / read:
    - Read .omp-swarm/change/run/implementation-plan.yaml from investigate.
    - Require owned_paths and acceptance_cases; on invalid input, write the
      failure report named below and stop without source edits.

    Scope:
    - Inspect: paths listed in implementation-plan.yaml.
    - May edit: only owned_paths from the plan and
      .omp-swarm/change/run/implement.md.
    - Must not edit: sibling-owned paths, unrelated modules, user work, or
      runtime-owned .swarm_* paths.

    Decision rules:
    - Not applicable.

    Acceptance / verification:
    - Run the focused command from the plan.
    - Every acceptance case must pass against the current project.

    Outputs / handoffs:
    - Overwrite .omp-swarm/change/run/implement.md as Markdown for review.
    - Include changed_paths, behavior_summary, verification_command,
      verification_exit, and unresolved_findings.

    Control / correction:
    - No control signal.

    Retry / failure:
    - Re-read current source, the plan, and the latest review evidence.
    - Preserve already-correct and unrelated work; apply only missing fixes.
    - On failure, overwrite implement.md with actionable safe diagnostics.
  waits_for: [investigate]
  reports_to: [review]
  resume:
    id: implement
    contract_version: 1
    state_version: 1
    policy: inputs-unchanged
```

| Field           | Required | Contract                                                                                            |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `type`          | yes      | Exactly `agent`.                                                                                    |
| `role`          | yes      | Non-empty role used in the system prompt.                                                           |
| `task`          | yes      | Non-empty objective and project-state contract.                                                     |
| `extra_context` | no       | Additional system-prompt context; do not hide required task inputs or outputs here.                 |
| `model`         | no       | Non-empty node override; otherwise this graph's `swarm.model` or configured default applies.        |
| `workload`      | no       | Routing profile plus optional replacement token estimate; route through `SKILL.md` when changed.    |
| `tools`         | no       | Non-empty unique string list selecting native built-in tools; omitted means unrestricted built-ins. |
| `waits_for`     | no       | Local upstream IDs; semantics live in `root-and-scheduling.md`.                                     |
| `reports_to`    | no       | Local downstream IDs; semantics live in `root-and-scheduling.md`.                                   |
| `control`       | no       | Agent/graph-only control object; route through `SKILL.md` when changed.                             |
| `resume`        | no       | Restart identity, versions, and reuse policy; route through `SKILL.md` when changed.                |

`tools` is an initial native built-in allowlist, not a non-escalatable security boundary. Names are trimmed and must be unique; unknown or unavailable names are omitted by the native registry. Subprocess agents additionally receive the mandatory `irc` and hidden `yield` tools when runtime gates permit them. Discovered extension/custom tools remain active, and a selected discovery or extension tool may activate more tools later. Do not use this field to claim a strict all-registry sandbox.

Every agent runs with the resolved swarm workspace as its working directory. Agent nodes have no separate `cwd` field and no per-node worktree. Imported child agents also use the root run's workspace.

Agents are independent invocations. They share current filesystem state, not hidden conversation memory. A downstream agent must read the actual project paths and declared handoff files it needs.

## Human-Reviewable Task Contract

Write every non-trivial agent `task` as a literal block scalar, `task: |`, with
these labels in this exact order. All labels are required. Write
`Not applicable`, `No handoff required`, or `No control signal` only when that
conditional contract genuinely does not apply.

1. **Outcome:** one observable project behavior, decision, or deliverable. Avoid
   activity-only outcomes such as “help implement” or “review everything.”
2. **Inputs / read:** exact project paths, authorities, plans, reports, command
   outputs, and handoffs. For each DAG-owned input, name its producer, path,
   format, required fields, and behavior when missing, stale, contradictory, or
   malformed.
3. **Scope:** use three explicit entries:
   - **Inspect:** exact paths, or a bounded discovery area and required ownership
     manifest when exact files are not yet known.
   - **May edit:** every currently owned project and DAG-artifact path, or the
     upstream manifest field that supplies them.
   - **Must not edit:** sibling-owned paths, unrelated modules, pre-existing user
     work, runtime-owned `.swarm_*`, and other forbidden scope.
4. **Decision rules:** define READY/BLOCKED, accept/reject, severity, or other
   predicates for investigation, planning, and review. Missing implementation
   that the graph exists to create is a finding, not automatically BLOCKED. Use
   `Not applicable` for straightforward implementers.
5. **Acceptance / verification:** focused command or observable behavior, exact
   evidence, and the predicate proving the outcome. Execution, file existence,
   or predecessor settlement alone is not proof.
6. **Outputs / handoffs:** for every output, name producer, exact path, format,
   required content, consumer, overwrite/append/version behavior, and behavior
   when production fails. Use `No handoff required` only when no downstream
   artifact is needed.
7. **Control / correction:** controllers define exact `continue`, `restart`, and
   `fail` predicates and invoke `submit_control_decision` exactly once. Every
   restart names the failing predicate, required mutation, selected target, and
   authorized writer in the invalidated suffix. Repeat decision owners invoke
   `submit_repeat_decision` exactly once per round. Non-controllers write
   `No control signal`.
8. **Retry / failure:** re-read current project state and latest review evidence;
   assume prior edits and artifacts remain; define idempotence; preserve unrelated
   work; leave actionable evidence on failure. This section is mandatory for
   every modifying node.

The node schema is closed. Do not add sibling fields such as `inputs`, `writes`,
or `acceptance`; encode these contracts inside `task`. The runtime trims and
forwards `task` as one string and does not parse these headings, so this is an
authoring and review convention rather than validator enforcement.

`waits_for` and `reports_to` schedule nodes only. They do not transport files,
imply successful completion, or replace an explicit handoff contract.

Do not force exact source filenames before investigation can know them. Give one
investigation node a bounded project scope and require an exact path/ownership
manifest for its implementer.

Status belongs to the node's own objective. A discovery node that completely
identifies absent or defective target implementation is READY with gaps to
implement. It is BLOCKED only when unavailable or malformed authority, an
unresolved contradiction, or another prerequisite prevents discovery.

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

- Accept by calling `submit_control_decision` with action `continue`.
- Reject with concrete findings and restart the upstream implementer.
- Fail when safe completion is impossible.

Every restartable finding must name the required mutation and an authorized
owner in the selected target's invalidated suffix. Inspecting or recovering an
upstream handoff does not grant permission to rewrite it. A reviewer must not
turn a merely inspected historical handoff into a new READY acceptance gate. If
the required owner is unreachable, reject or supersede a stale non-authoritative
finding, select a reachable allowed target, or fail; never restart an incapable
node.

On restart, the implementer sees its existing edits; no filesystem rollback occurs. Its task must read the review report, inspect current source, and repair idempotently. A reviewer must not claim independence after modifying the source it approves.

Ordinary source changes need no publisher agent. Add a terminal publisher only for a generated or single replaceable artifact that genuinely requires staged atomic promotion.
