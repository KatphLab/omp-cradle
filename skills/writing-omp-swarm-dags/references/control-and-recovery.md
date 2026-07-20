# Control and Recovery

Read this complete file when the new DAG uses node `control`, `restart_policy`, dynamic rewind, `omp-swarm restart`, or resume behavior.

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

The runtime reads a control decision only after the controlled node executes successfully. The task must always write exactly one valid decision before returning.

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

## Control Signal Grammar

| Signal field | Contract                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| `action`     | Required; exactly `continue`, `restart`, or `fail`.                            |
| `target`     | Required only for `restart`; forbidden otherwise; must be allowed by the node. |
| `reason`     | Required and non-empty for `restart` and `fail`; optional for `continue`.      |

Continue permits an optional non-empty reason and forbids `target`:

```yaml
action: continue
reason: focused checks and review passed
```

Restart requires both an allowed target and a non-empty reason:

```yaml
action: restart
target: implement
reason: src/feature.ts still violates the acceptance contract
```

Fail requires a non-empty reason and forbids `target`:

```yaml
action: fail
reason: the required project API is unavailable
```

Use a dedicated `.yaml` control file. Do not use the one-line signal format reserved for graph `repeat`.

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

Use:

```bash
omp-swarm restart path/to/swarm.yaml
```

Restart resumes prior state only when the root and imported YAML definitions are unchanged. It reuses eligible settled nodes and reruns unfinished or invalidated work. It does not verify that settled-node artifacts or source files still exist and does not restore the working tree.

For a routed DAG, restart also requires the persisted versioned routing plan. It reuses the original selected aliases, planned concrete models, costs, and assumptions rather than reranking against the current catalog. OMP may resolve the persisted alias to a different concrete fallback during execution; state `resolvedModel` records that runtime model without changing the planned audit record. Legacy state without a routing plan cannot be resumed as routed; start a fresh normal run.

Do not clean the DAG's current run directory before restart. Preserve the handoffs, reports, signals, and project edits required by reused nodes. A fresh normal run may clean only the DAG-owned run directory according to `artifact-lifecycle.md`.

Keep control loops bounded and purposeful. For an ordinary one-pass source change, explicit implementation → check → review edges may be sufficient; add rewind only when automated correction is a required workflow behavior.
