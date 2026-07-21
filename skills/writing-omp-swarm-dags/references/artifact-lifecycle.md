# Artifact Lifecycle

Read this complete file when the new DAG creates cross-node handoffs, reports, signals, cleanup, reusable cache, or retained history.

## Separate Project Work from Coordination

Project source, tests, configuration, migrations, documentation, and checked-in outputs remain at their normal project paths. They are the workflow's product and must never be deleted as DAG cleanup.

DAG-owned files coordinate independent nodes:

```text
<project-workspace>/
├── .swarm_<name>/                          # runtime-owned; DAG nodes never touch
├── .omp-swarm/
│   └── <swarm-name>/
│       ├── run/                            # current normal run
│       │   ├── meta/                       # project guard/input manifest
│       │   ├── handoffs/                   # plans and ownership manifests
│       │   ├── reports/                    # checks and reviews
│       │   ├── signals/                    # repeat/control/status files
│       │   └── scratch/<node-id>/          # node-private temporary data
│       ├── cache/<validity-key>/            # optional immutable reusable data
│       └── history/<run-id>/                # optional bounded prior evidence
├── src/                                    # real project work
└── package.json                            # real project input
```

Use the literal `swarm.name` in the DAG-owned path. Runtime `.swarm_<name>/` and imported-child `.swarm_*` directories are owned by OMP; swarm agents and Bash nodes must not read, edit, move, clean, or delete them.

An explicit user request to inspect or edit runtime state authorizes the coding
assistant to perform that operator-directed recovery outside a swarm run. Never
infer this authorization from a request to restart, debug, or repair a DAG.
Before editing, verify that no swarm process is running, preserve the state
schema and definition fingerprint, and update mirrored state files consistently.

## File Contracts

- Give every mutable DAG-owned or project path one writer at a time.
- Name the writer in each phase and the dependency boundary for every ownership transfer.
- Same-wave nodes use disjoint files and disjoint project edit scopes.
- Consumers read exact paths or a declared ownership manifest.
- A file is a handoff only when the producing task defines its format and the consumer handles missing or invalid content.
- Status and graph-repeat files use exact one-line values.
- Control decisions use the YAML grammar in `control-and-recovery.md`.
- Use atomic temporary-file-and-rename writes when a retry could expose a partial file.

### Report Status Lifecycle

Define READY/BLOCKED against the producing node's objective, not the eventual
product. Name every consumer that hard-gates on the status, whether the report
remains current after ownership transfer, and the node allowed to replace it
during correction.

After transfer, an upstream report is either immutable historical evidence
superseded by a downstream current report, or its writer must be reachable from
the correction target. Never make terminal acceptance depend on changing a
frozen report whose writer is outside the invalidated suffix.

Agents may inspect bounded project areas for source discovery. They must not indiscriminately scan `.swarm_*`, other DAG roots, cache, or history.

## Fresh Normal Run

OMP resets its runtime state for a normal run but does not clean DAG-owned artifacts or project files. If stale handoffs could affect behavior, add a first-wave project guard/preparation node that:

1. Verifies project anchors before any deletion.
2. Resolves the exact literal `.omp-swarm/<swarm-name>/run/` path inside the project workspace.
3. Rejects an empty path, `..`, symlink escape, variable-derived broad path, or glob.
4. Deletes only that `run/` subtree.
5. Recreates required run directories and writes the current input manifest last.
6. Emits an explicit success/fail decision when later work must be gated.

Preserve project files, `.swarm_*`, cache, and history. Never use `git reset --hard`, `git clean`, or workspace-wide deletion as fresh-run preparation.

A Bash preparation node's non-zero exit does not gate dependents. Prefer a controlled guard agent, or place a downstream agent that verifies the preparation manifest before source work.

Do not perform fresh-run cleanup before `omp-swarm restart`. Restart may reuse settled nodes whose reports and source edits must remain available.

## Reusable Cache

Cache is optional. A leftover file is not a cache hit. Every immutable entry needs a validity manifest containing:

- Canonical input paths and content digests.
- Relevant task/DAG contract revision.
- Tool and configuration versions that affect meaning.
- Producer node IDs and successful completion status.
- Output paths and digests.
- Creation identifier and retention policy.

Reuse only on an exact manifest match; otherwise recompute. Report `REUSED` or `RECOMPUTED` in current-run evidence. Promote cache only after its producer's required verification succeeds. Never mix files from different validity keys.

## History and Cleanup

History is explicit audit/comparison evidence, not an implicit current input. A task may read it only when the workflow requests historical comparison. Prune cache/history only after successful workflow completion, under a declared age/count/size policy, and never prune an entry used by the current run.

Generated or binary project artifacts may be drafted under `run/scratch` and atomically promoted after independent verification. Ordinary source edits stay in the real project tree throughout the workflow.
