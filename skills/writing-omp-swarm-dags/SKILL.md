---
name: writing-omp-swarm-dags
description: Use when authoring or reviewing OMP swarm-extension YAML, multi-agent DAGs, waits_for/reports_to dependencies, pipeline/parallel/sequential modes, shared workspace handoffs, signal files, or wave orchestration.
---

# Writing OMP Swarm DAGs

## Core Contract

OMP swarm files are YAML with exactly this outer shape:

```yaml
swarm:
  name: my-workflow
  workspace: ./workspace
  mode: parallel # pipeline | parallel | sequential
  agents:
    producer:
      role: researcher
      task: |
        Write results/raw.md and signals/producer.txt as OK or FAIL:<reason>.
      reports_to: [consumer]
    consumer:
      role: synthesizer
      task: |
        Read signals/producer.txt and results/raw.md.
        Write output/final.md.
      waits_for: [producer]
```

NEVER invent `version`, `kind`, `stages`, `tasks`, `depends_on`, `after`, `run`, or `command`. Agents receive text tasks; the orchestrator only orders them.

## Design Recipe

1. Pick pattern: sequential, fan-out/fan-in, diamond, hybrid, or iterative pipeline.
2. Declare file contracts: handoffs, signals, tracking state, final output.
3. Give each agent one objective, exact paths, success signal, failure signal.
4. Encode edges: producer `reports_to` consumer; consumer `waits_for` producers.
5. Check waves: same dependency level runs in parallel; later waves read files.
6. Pipeline? Add `target_count` + tracking files to avoid duplicate/clobbered iterations.

## Quick Reference

| Need                               | Use                                               |
| ---------------------------------- | ------------------------------------------------- |
| Repeat full graph N times          | `mode: pipeline` + `target_count: N`              |
| Run all independent agents at once | `mode: parallel`, explicit deps only where needed |
| Ordered handoff                    | `mode: sequential` or explicit `reports_to` chain |
| Fan-in synthesizer                 | Synthesizer `waits_for: [a, b, c]`                |
| Readable producer-side edge        | Producer `reports_to: [consumer]`                 |
| Cross-agent data                   | Files under `workspace`, not hidden memory        |
| Iteration state                    | `tracking/*.txt                                   | json`, numbered outputs, parseable `signals/*.txt` |

## Example: Diamond Feature Implementation

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace
  mode: parallel
  agents:
    planner:
      role: architect
      task: |
        Read spec.md.
        Write plan.md with ownership for api, ui, and tests.
        Write signals/planner.txt as OK or FAIL:<reason>.
      reports_to: [api, ui, tests]

    api:
      role: backend-developer
      task: |
        Read plan.md and spec.md.
        Implement only assigned backend files.
        Write reports/api.md and signals/api.txt as OK or FAIL:<reason>.
      waits_for: [planner]
      reports_to: [integrator]

    ui:
      role: frontend-developer
      task: |
        Read plan.md and spec.md.
        Implement only assigned frontend files.
        Write reports/ui.md and signals/ui.txt as OK or FAIL:<reason>.
      waits_for: [planner]
      reports_to: [integrator]

    tests:
      role: test-engineer
      task: |
        Read plan.md and spec.md.
        Add behavior tests for the feature contract.
        Write reports/tests.md and signals/tests.txt as OK or FAIL:<reason>.
      waits_for: [planner]
      reports_to: [integrator]

    integrator:
      role: tech-lead
      task: |
        Read signals/*.txt and reports/*.md.
        On any FAIL, write output/status.md with blockers and stop.
        Otherwise integrate work, run focused verification, write output/status.md.
      waits_for: [api, ui, tests]
```

Waves: `planner` → `api` + `ui` + `tests` → `integrator`.

## Common Mistakes

- **Invalid schema**: top-level must be `swarm` with `name`, `workspace`, `agents`.
- **Implicit data passing**: orchestration orders agents only. Use files.
- **Oversized agents**: split research, implementation, review, integration.
- **Pipeline clobbering**: use `processed.txt`, counters, or unique filenames.
- **Bad edges**: every `waits_for`/`reports_to` target must be an agent; cycles reject.
- **Unparseable signals**: prefer one-line `OK`, `FAIL:<reason>`, `FOUND:<url>`, `DONE:<id>`.
- **Unsafe waves**: parallel agents must not write the same path; downstream reads must be upstream writes.
