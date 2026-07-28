# Control and Recovery

Use only when `SKILL.md` routes here. Return to its table before opening any linked reference.

## Restart Policy

Any graph containing a controlled agent or graph node must declare all three positive integers:

```yaml
restart_policy:
  max_restarts: 2
  max_restarts_per_target: 2
  max_node_attempts: 3
```

| Field                     | Contract                                           |
| ------------------------- | -------------------------------------------------- |
| `max_restarts`            | Maximum restart decisions across the graph run.    |
| `max_restarts_per_target` | Maximum restarts aimed at one target.              |
| `max_node_attempts`       | Maximum attempts for nodes invalidated by rewinds. |

## Controlled Node

Only `agent` and `graph` nodes may declare control:

```yaml
control:
  signal: .omp-swarm/source-change/run/signals/review.control.yaml
  allowed_restart_targets: [implement]
```

`signal` is a safe workspace-relative YAML path. `allowed_restart_targets` is a non-empty unique list of local node IDs. Every target must be the controlled node itself or one of its transitive upstream dependencies.

The runtime reads a control decision only after the controlled node executes
successfully. The task must invoke `submit_control_decision` exactly once before
returning; the tool validates the action and writes the configured `signal`.

### Control-Target Correction Reachability

For every condition that may emit `restart`, name the exact project path,
handoff, report, or status predicate that must change. The selected target's
invalidated suffix must contain a node authorized to make that mutation at the
current ownership phase. Structural eligibility as self/transitive-upstream is
necessary but insufficient.

Recovery by rereading authority can supersede stale evidence, but it does not
change that evidence file or transfer its ownership. If acceptance still requires
the stale file to change, restart its reachable owner or fail. Do not consume a
restart on a target that cannot make the reason false.

## Control Decision Tool

`submit_control_decision` accepts:

| Field    | Contract                                                                       |
| -------- | ------------------------------------------------------------------------------ |
| `action` | Required; exactly `continue`, `restart`, or `fail`.                            |
| `target` | Required only for `restart`; forbidden otherwise; must be allowed by the node. |
| `reason` | Required and non-empty for `restart` and `fail`; optional for `continue`.      |
| `scope`  | Omit when one channel is available; otherwise use a runtime-listed scope.      |

Continue permits an optional non-empty reason and forbids `target`:

```json
{ "action": "continue", "reason": "focused checks and review passed" }
```

Restart requires both an allowed target and a non-empty reason:

```json
{
  "action": "restart",
  "target": "implement",
  "reason": "src/feature.ts still violates the acceptance contract"
}
```

Fail requires a non-empty reason and forbids `target`:

```json
{ "action": "fail", "reason": "the required project API is unavailable" }
```

The agent calls the tool with these arguments; it never writes the control YAML
directly. The configured `signal` remains the runtime handoff read by the
orchestrator.

## Rewind Semantics

A restart decision marks the target and all of its transitive dependents stale, then requeues them within policy limits. Unrelated settled branches remain settled.

Scheduler rewind does not restore source files, reports, or build outputs. Rerun nodes receive the same project workspace with all prior edits. Therefore:

- Implementation and integration tasks must be idempotent.
- A restarted implementer must read the latest review report and current source.
- Verification output must be safely overwritten or versioned.
- Never rerun global cleanup as a review target.
- Do not use rewind to simulate source rollback.

A `fail` decision fails the current iteration. In pipeline mode, later target iterations still run, but the final run remains failed.

Restart limits bound execution; they do not prove convergence. An unreachable
correction repeats until `max_restarts`, `max_restarts_per_target`, or
`max_node_attempts` is exhausted and the run fails.

## External Restart and Resume

Restart normally:

```bash
omp-swarm restart path/to/swarm.yaml
```

Operator overrides are explicit and auditable:

```bash
omp-swarm restart path/to/swarm.yaml --reuse plan,implement --rerun lint,validate
omp-swarm restart path/to/swarm.yaml --from lint
```

`--rerun` and `--from` rerun the selected node plus every transitive dependant.
Overrides accept either the current node name or its unique `resume.id`.
`--reuse` may override policy and contract-version incompatibility, but never
missing or malformed state, missing output evidence, a changed workspace
checkpoint, a node type or state-version change, or an upstream rerun. A node
cannot be in both `--reuse` and `--rerun`.

The restart decision, reason, warnings, overrides, and definition diff are
persisted under `.swarm_<name>/state/restart-plan.json`; an immutable raw-state
backup is written under `.swarm_<name>/state/backups/` before recovery. These
paths are runtime-owned and must not be read or edited by DAG nodes.

Each node may declare a resume contract:

```yaml
validate_implementation:
  type: agent
  role: reviewer
  task: |
    Outcome:
    - Revalidate the current implementation on every external restart.

    Inputs / read:
    - Read the current source and declared implementation/check reports.

    Scope:
    - Inspect: declared changed paths and reports.
    - May edit: the review report only.
    - Must not edit: project source, sibling artifacts, or .swarm_*.

    Decision rules:
    - Accept only when current source and evidence satisfy the contract.

    Acceptance / verification:
    - Reproduce the focused behavior against current source.

    Outputs / handoffs:
    - Overwrite the declared review report for its consumer.

    Control / correction:
    - No control signal.

    Retry / failure:
    - Re-read current state and replace stale review evidence.
  waits_for: [implement]
  resume:
    id: validate
    contract_version: 2
    state_version: 1
    policy: never
```

| Field              | Meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `id`               | Unique stable identity within the graph; defaults to node name. Keep across renames.          |
| `contract_version` | Semantic result contract; defaults to `1`. Increment when meaning or format changes.          |
| `state_version`    | Persisted runtime-result representation; defaults to `1`. Change only for incompatible state. |
| `policy`           | `preserve`, `inputs-unchanged`, `never`, or `strict`; defaults to `preserve`.                 |

Choose policy from the result's safe reuse conditions:

- `preserve`: reuse a completed node when identity, type, versions, and recorded
  file outputs remain compatible. Definition drift produces a warning but does
  not rerun it.
- `inputs-unchanged`: additionally require the exact executed node definition,
  matching upstream output-reference fingerprints, non-empty persisted output
  evidence, and the same recorded workspace checkpoint. This is conservative:
  later workspace changes can invalidate earlier nodes.
- `strict`: require the exact executed node-definition fingerprint, but not an
  unchanged workspace checkpoint.
- `never`: always rerun. Use for verdicts or effects that must be regenerated on
  every external restart.

Increment `contract_version` when outcome meaning, accepted inputs/handoffs,
required output fields or format, or acceptance predicates change. Keep it
stable for wording-only edits. `state_version` is not a task revision counter.
Change `id` only for a genuinely new node identity; duplicate IDs fail
validation.

The complete DAG definition summary and fingerprint remain provenance: they
explain changes and identify what executed, but do not globally invalidate
completed work. Contract versions determine semantic compatibility. Persisted
input/output references and workspace checkpoints validate actual evidence.

The runtime records dependency input fingerprints from upstream output
references, not from `waits_for` or `reports_to` themselves. It also records
available node output files and a Git workspace checkpoint. These runtime
references do not parse agent task headings or validate semantic handoff fields;
explicit producer/consumer contracts remain mandatory.
Every non-reusable node remains a restart root, and its transitive dependants
rerun; unrelated compatible branches remain settled.

State loading migrates the pipeline envelope and decodes agent, Bash, and graph
records independently. Missing legacy maps and attempts are normalized;
crash-interrupted `running` records become `stale`. A malformed node record
invalidates only that node and its dependants. A malformed child graph
invalidates that graph node. Unrecoverable pipeline-envelope or provenance
corruption aborts restart without overwriting the preserved raw backup.

For a routed DAG, restart still requires a persisted versioned routing plan.
When that plan remains compatible with the current DAG, restart reuses it.
When the DAG changes make it incompatible, restart plans the current DAG from
the refreshed catalog while preserving compatible settled nodes.
