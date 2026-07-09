---
name: writing-omp-swarm-dags
description: Use when authoring or reviewing OMP swarm-extension YAML, multi-agent DAGs, waits_for/reports_to edges, pipeline/parallel/sequential modes, workspace handoffs, signals, wave orchestration, restart/resume behavior, graph-change diagnostics, or control-signal rewinds.
---

# Writing OMP Swarm DAGs

## Contract

Author or review one valid OMP swarm-extension YAML DAG. The DAG must use:

- Explicit workspace files for every cross-node handoff.
- Parseable one-line signals for completion, blockers, repeats, and control actions.
- Local acyclic dependencies only.
- Bounded graph `repeat` for fixed loops.
- Bounded `restart_policy` plus `control` signals for dynamic rewinds.
- Bash nodes only as deterministic feedback producers.
- Restart-safe assumptions: resume only unchanged saved graphs.

## Minimal Shape

```yaml
swarm:
  name: my-workflow
  workspace: ./workspace
  mode: parallel # parallel | sequential | pipeline
  concurrency: 3
  nodes:
    producer:
      type: agent
      role: researcher
      task: |
        Write results/out.md and signals/producer.txt as OK or FAIL:<reason>.
      reports_to: [check]
    check:
      type: bash
      command: bun typecheck
      output_path: reports/typecheck.txt
      waits_for: [producer]
      reports_to: [consumer]
    consumer:
      type: agent
      role: synthesizer
      task: |
        Read reports/typecheck.txt and results/out.md.
        Write output/final.md.
      waits_for: [check]
```

## Schema Rules

- Top level is exactly `swarm`.
- Required swarm fields: `name`, `workspace`, positive integer `concurrency`, and non-empty `nodes`.
- `mode` is `parallel`, `sequential`, or `pipeline`.
- `pipeline` requires `target_count`; iterations must use tracking files or unique output paths.
- Every node requires `type`: `agent`, `graph`, or `bash`.
- Agent nodes require `role` and text `task`.
- Graph nodes require `path` to another swarm YAML file.
- Bash nodes require `command` and workspace-relative `output_path`.
- `waits_for` and `reports_to` targets must be typed node names in the same local graph.
- Orchestration fields are only `nodes`, `waits_for`, `reports_to`, `target_count`, `concurrency`, graph `repeat`, top-level `restart_policy`, and agent/graph `control`.
- Never invent `version`, `kind`, `stages`, `tasks`, `depends_on`, `after`, or `run`.

## Data and Execution Rules

- Orchestration orders nodes and bounded repeats only. It does not pass hidden memory.
- Pass all data through files under `workspace`.
- Assign one writer per path. Concurrent nodes must never write the same file.
- Give every agent exact read paths, write paths, and signal format.
- Prefer one-line signals: `OK`, `FAIL:<reason>`, `FOUND:<url>`, `DONE:<id>`, `ACCEPTED`, `CHANGES_REQUESTED`.
- Do not put shell redirection in `command`; use `output_path` for captured bash output.
- A non-zero bash exit is feedback, not an orchestration stop. Downstream nodes still run after `output_path` is written.
- To retry a deterministic check, add a later bash node or put the checked work in a bounded repeated graph.
- `concurrency` limits simultaneous agent nodes across the parent DAG and imported subgraphs. Bash nodes do not count.
- Imported graph agents run in the parent workspace and share the parent run's `concurrency` limit. A child graph's own `workspace` is used only for standalone runs.

## Design Order

1. Pick the pattern: sequential, fan-out/fan-in, diamond, imported graph, bash feedback, fixed review loop, dynamic rewind, hybrid, or iterative pipeline.
2. Define file contracts: inputs, handoffs, reports, signals, tracking files, final output, and one writer for each path.
3. Assign each agent one objective plus exact read/write paths and success/failure signal.
4. Add bash checks only when deterministic command output helps downstream agents or retry nodes.
5. Encode edges: producer `reports_to` consumer; consumer `waits_for` producer. Use both when readability improves.
6. Check waves: same dependency level runs concurrently; downstream nodes read upstream workspace files.
7. Set `concurrency` to the provider-safe maximum simultaneous agent nodes, including imported subgraphs and excluding bash.
8. For `pipeline`, add `target_count` plus `tracking/*.txt` or numbered outputs to prevent duplicate or clobbered iterations.
9. For fixed loops, import the loop body as a child graph and add graph `repeat`.
10. For dynamic rewinds, add top-level `restart_policy` plus agent/graph `control.signal` and `control.allowed_restart_targets`. Do not create dependency cycles.
11. Decide restart semantics before handoff. Editing execution-affecting fields makes saved state non-resumable: `name`, `workspace`, `mode`, `target_count`, `concurrency`, `model`, `restart_policy`, node deps/control/task/command/path/repeat.

## Pattern Reference

| Need                   | Use                                                                        |
| ---------------------- | -------------------------------------------------------------------------- |
| Independent work       | `mode: parallel`; add deps only for real handoffs                          |
| Ordered handoff        | `mode: sequential` or `reports_to` chain                                   |
| Fan-in                 | Consumer `waits_for: [a, b, c]`                                            |
| Producer-side edge     | Producer `reports_to: [consumer]`                                          |
| Cross-node data        | Workspace files                                                            |
| Deterministic feedback | `type: bash` + `output_path` + downstream reader                           |
| Reusable graph         | `type: graph` + `path: ./graphs/child.yaml`                                |
| Fixed review loop      | Graph `repeat` + parseable `stop_signal`                                   |
| Dynamic restart        | `restart_policy` + agent/graph `control.signal`                            |
| Repeat N iterations    | `mode: pipeline` + `target_count: N`                                       |
| Resume interrupted run | `omp-swarm restart <path-to-yaml>` only with unchanged DAG YAML            |
| Force scratch run      | `omp-swarm <path-to-yaml>` overwrites saved state                          |
| Iteration safety       | `tracking/*.txt`, numbered outputs, parseable `signals/*.txt`              |
| Rate-limit guard       | Required `concurrency`; counts all simultaneous agent nodes, excludes bash |

## Example: Diamond, Bash Feedback, Imported Review Loop

```yaml
swarm:
  name: composed-feature
  workspace: ./workspace
  mode: parallel
  concurrency: 3
  nodes:
    planner:
      type: agent
      role: architect
      task: |
        Read spec.md. Write plan.md assigning api, ui, and tests.
        Write signals/planner.txt as OK or FAIL:<reason>.
      reports_to: [api, ui, tests]
    api:
      type: agent
      role: backend-developer
      task: |
        Read spec.md and plan.md. Write reports/api.md and signals/api.txt.
      waits_for: [planner]
      reports_to: [implementation]
    ui:
      type: agent
      role: frontend-developer
      task: |
        Read spec.md and plan.md. Write reports/ui.md and signals/ui.txt.
      waits_for: [planner]
      reports_to: [implementation]
    tests:
      type: agent
      role: test-engineer
      task: |
        Read spec.md and plan.md. Write reports/tests.md and signals/tests.txt.
      waits_for: [planner]
      reports_to: [implementation]
    implementation:
      type: graph
      path: ./graphs/implementation.yaml
      waits_for: [api, ui, tests]
      reports_to: [typecheck]
    typecheck:
      type: bash
      command: bun typecheck
      output_path: reports/typecheck.txt
      waits_for: [implementation]
      reports_to: [review_loop]
    review_loop:
      type: graph
      path: ./graphs/review-round.yaml
      waits_for: [typecheck]
      reports_to: [integrator]
      repeat:
        max_rounds: 3
        stop_signal: signals/review-loop.txt
        success_value: ACCEPTED
        continue_value: CHANGES_REQUESTED
    integrator:
      type: agent
      role: tech-lead
      task: |
        Read signals/*.txt, reports/typecheck.txt, and imported graph outputs.
        On any FAIL:<reason>, write output/status.md with blockers.
        Otherwise integrate, run focused verification, and write output/final.md.
      waits_for: [review_loop]
```

Waves: `planner` → `api` + `ui` + `tests` → `implementation` → `typecheck` → repeated `review_loop` → `integrator`.

## Example: Dynamic Rewind Control

```yaml
swarm:
  name: rewind-feature
  workspace: ./workspace
  mode: sequential
  concurrency: 1
  restart_policy:
    max_restarts: 2
    max_restarts_per_target: 1
    max_node_attempts: 3
  nodes:
    implement_p1:
      type: agent
      role: implementer
      task: |
        Write reports/implement_p1.md and signals/implement-p1.txt as OK.
      reports_to: [review_p1]
    review_p1:
      type: agent
      role: reviewer
      task: |
        Read reports/implement_p1.md. If accepted, write
        signals/review-p1.control.yaml with action: continue. If phase 1 must
        be rerun, write action: restart, target: implement_p1, and a reason.
      waits_for: [implement_p1]
      control:
        signal: signals/review-p1.control.yaml
        allowed_restart_targets: [implement_p1]
```

Control rules:

- Only agent and graph nodes may declare `control`.
- Any node with `control` requires top-level `restart_policy`.
- `control.signal` is workspace-relative.
- `allowed_restart_targets` must be the control node itself or an upstream dependency in the same local graph.
- Rewind reruns the selected target and transitive dependents. Unrelated completed branches stay completed.
- Bash nodes cannot declare `control`, but upstream restarts can invalidate bash outputs on their downstream path.

## Restart and Resume Semantics

- Normal run: `omp-swarm <path-to-yaml>` starts from scratch and overwrites saved state for that swarm name/workspace.
- Resume run: `omp-swarm restart <path-to-yaml>` starts from scratch only when no saved state exists.
- Matching saved state: restart skips nodes saved as `completed` for the current iteration, reruns failed/running/pending nodes, and invalidates transitive dependents.
- Completed saved state: restart prints the saved state and exits without running nodes.
- Changed or unverifiable saved state: restart fails fast with graph-change diagnostics. Do not expect restart to merge old state after YAML edits.
- Persisted `running` nodes are treated as abandoned work and rerun. Restart does not kill any still-live old process; avoid restarting while the old process can still write the same workspace.

## Review Checklist

- Schema: top-level `swarm`; required `name`, `workspace`, positive integer `concurrency`, and non-empty `nodes`.
- Fields: only valid node types and orchestration fields.
- Edges: every target is local and typed; graph is acyclic.
- Bash feedback: `output_path` is workspace-relative; no shell redirection handles handoffs; downstream nodes read the report.
- Data: all cross-node state uses workspace files; each path has one writer.
- Parallel safety: same-wave nodes cannot clobber each other.
- Concurrency safety: limit counts agent nodes across imported subgraphs and excludes bash nodes.
- Pipeline safety: iterations use counters, tracking files, or unique filenames.
- Repeat safety: `max_rounds` exists; `stop_signal` is workspace-relative; trimmed content equals `success_value` or `continue_value`.
- Control safety: top-level `restart_policy` exists; `control.signal` is workspace-relative; restart targets are local upstream dependencies or the control node itself.
- Restart safety: use `omp-swarm restart <path>` only for unchanged DAGs; graph changes fail fast; normal `omp-swarm <path>` intentionally overwrites saved state.
