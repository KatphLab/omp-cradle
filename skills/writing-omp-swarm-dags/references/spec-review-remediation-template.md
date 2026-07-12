# Specification Review and Remediation DAG Template

Use this composition for a large, specification-driven review that must extract requirements, reconcile precedence, repair an existing project in dependency order, audit the result independently, run deterministic checks, and allow one bounded correction loop.

This is a graph-design template, not a project-specific DAG. Replace domain partitions, ownership sets, commands, models, and paths. Keep the phase boundaries and evidence contracts only when they earn their place in the target workflow.

Do not use this composition for a small one-pass change, a review with no remediation, or work whose requirements already have one unambiguous source. Start from `dag-template.md` in those cases and add only the boundaries the workflow needs.

## Design Target

The graph should make five facts mechanically clear:

1. No project edit begins before the normative sources have one reconciled interpretation.
2. Every mutable project path has one writer at a time.
3. Auditors are read-only and independent from the writers they assess.
4. Command completion is not acceptance; agents interpret command evidence and current behavior.
5. A restart replays only the bounded repair-and-acceptance suffix against the already-modified tree.

## Reference Topology

```text
prepare
  |
  +--> analyze_domain_a --+
  +--> analyze_domain_b --+--> synthesize_requirements
  +--> analyze_governance -+             |
                                           v
                                  implement_foundation
                                           |
                         +-----------------+-----------------+
                         v                 v                 v
                 implement_area_a  implement_area_b  implement_area_c
                         +-----------------+-----------------+
                                           |
                                           v
                                  implement_integration
                                           |
                         +-----------------+-----------------+
                         v                 v                 v
                audit_requirements  audit_invariants  audit_composition
                         +-----------------+-----------------+
                                           |
                                           v
                                     residual_repair
                                           |
                    +----------------------+----------------------+
                    |                      |                      |
                    v                      v                      v
              check_behavior         check_static       semantic_acceptance
                    +-----------+----------+                      |
                                v                                 |
                         check_acceptance                         |
                                +---------------+-----------------+
                                                |
                                                v
                                         final_decision
                                                |
                            restart residual_repair only when safe
```

Scale the two fan-outs horizontally. Add or remove analysis, implementation, audit, and check nodes according to real boundaries; do not add nodes merely to preserve symmetry.

## Phase Contracts

| Phase                     | Project mutation                               | Required output                                               | Design purpose                                                                   |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `prepare`                 | None                                           | Workspace decision and clean current-run directories          | Fail safely before work if project anchors or cleanup scope are invalid.         |
| `analyze_*`               | None                                           | Disjoint, cited requirement packets                           | Parallelize reading by source domain, not arbitrary file counts.                 |
| `synthesize_requirements` | None                                           | One precedence-aware matrix and ownership plan                | Establish the single normative input to all writers.                             |
| `implement_foundation`    | Foundational paths only                        | Change report and focused evidence                            | Stabilize shared types or interfaces before dependents.                          |
| `implement_area_*`        | Pairwise-disjoint path sets                    | One report per owned area                                     | Exploit safe parallelism after shared foundations settle.                        |
| `implement_integration`   | Explicit integration paths only                | Integrated-state report                                       | Own shared exports, registries, aggregate types, or other fan-in surfaces.       |
| `audit_*`                 | None                                           | Independent PASS/FINDINGS reports                             | Review different failure classes without mixing review and repair.               |
| `residual_repair`         | Bounded union of approved implementation paths | Finding dispositions, exact fixes, focused evidence, or NO-OP | Give all residual edits one serialized owner.                                    |
| `check_*`                 | Only declared command outputs                  | Raw output with parseable exit markers                        | Produce deterministic evidence in parallel.                                      |
| `semantic_acceptance`     | None                                           | PASS/FINDINGS/BLOCKER                                         | Recheck high-risk behavior against current source, independent of command exits. |
| `check_acceptance`        | None                                           | PASS/FINDINGS/BLOCKER                                         | Interpret all raw check reports; non-zero exits do not gate by themselves.       |
| `final_decision`          | None                                           | Final report and exactly one control decision                 | Continue, restart only the residual writer, or fail.                             |

## Ownership and Ordering Rules

### Partition analysis by meaning

Assign each analysis node a complete normative domain and an explicit source list. Every packet should contain stable local IDs, exact citations, normative statements, boundaries or invalid cases, affected symbols, conflicts, and observable acceptance conditions. Require a coverage ledger so synthesis can detect omissions.

Give governance, amendments, precedence, or canonical vocabulary its own packet when those sources can override domain documents. Examples and implementation notes should be labeled normative or illustrative rather than silently promoted to policy.

### Synthesize before mutation

The synthesis node is the semantic fan-in. It should:

- verify complete source coverage;
- apply documented precedence instead of preference;
- retain unresolved ambiguity as a blocker;
- de-duplicate rules without dropping distinct boundary cases;
- assign stable global requirement IDs;
- map requirements to project symbols and ownership clusters;
- separate cross-cluster invariants from cluster-local rules; and
- state READY or BLOCKED before writers run.

A writer receiving BLOCKED must edit nothing and report the blocker.

### Layer writers by dependency and path ownership

Use a new implementation layer only for a real dependency boundary:

- shared foundations before dependent models;
- independent areas after foundations, in parallel only when path sets are disjoint;
- aggregate/result types after their inputs;
- lifecycle, orchestration, or integration types after their component contracts;
- public exports or registries after all definitions stabilize.

A shared file cannot belong to parallel writers. Assign exports, indexes, manifests, lockfiles, generated registries, and other convergence points to one later integration node. When two areas cannot be given disjoint paths, serialize them instead of relying on agents to avoid conflicts.

Every modifying task should name its inspect scope, owned edit paths, forbidden sibling paths, focused verification, report path, idempotent retry behavior, and blocker behavior. It must inspect language-aware references before changing public symbols.

### Separate audits by failure class

Three independent audit lenses usually cover this workflow well:

- **Requirement coverage:** every global requirement has a disposition backed by current code and controlling citations.
- **Model or local invariants:** validation, immutability, optionality, numeric/domain types, state combinations, serialization, and boundary behavior.
- **Composition:** linked types, imports, public API, shared domains, sequencing, and bounded callers remain compatible.

Auditors inspect the actual current project tree and remain read-only. Findings need exact paths/symbols, controlling requirement or citation, observed versus required behavior, and a focused acceptance check. Style preferences and speculative enhancements are not actionable findings.

### Use one bounded residual writer

Fan all audits into one residual node. It adjudicates each finding against current code and normative evidence before editing. It may change only the declared project ownership envelope. Findings requiring broader source, tests, specifications, tooling, or configuration become blockers rather than scope expansion.

On a restart, this node reads the latest final-review report and current source. It repairs idempotently; scheduler rewind does not restore files. When no confirmed fix is needed, it writes an explicit NO-OP report.

### Split mechanical and semantic acceptance

After residual repair, run deterministic Bash checks in parallel. Each check writes a unique report and prints explicit markers such as:

```text
CHECK_EXIT=0
```

Fan raw check reports into a read-only check-acceptance agent. It passes only on the required zero markers and valid reports; otherwise it identifies the concrete in-scope defect or blocker. Do not treat a Bash node's non-zero exit as a dependency gate.

Run semantic acceptance in parallel with the command-check branch. It rechecks the highest-risk cross-cutting requirements against the actual current project, not only handoffs or test output. The final controller waits for both acceptance branches.

### Bound recovery to a suffix

The final controller always writes one final report and one valid control signal:

- `continue` only when semantic and check acceptance pass and no blocker remains;
- `restart` targeting only `residual_repair` for a confirmed defect fixable within that node's ownership; or
- `fail` for missing evidence, irreconcilable requirements, exhausted attempts, unsafe correction, or required edits outside ownership.

The restart target invalidates the residual node and all downstream acceptance nodes. It must not rerun preparation, analysis, synthesis, planned implementation, or audits.

## Structural YAML Skeleton

This skeleton shows edges and contracts, not task detail. Expand every task using `agent-nodes.md`; replace commands and paths before validation.

```yaml
swarm:
  name: spec-review-remediation
  workspace: ..
  mode: parallel
  concurrency: 4
  restart_policy:
    max_restarts: 2
    max_restarts_per_target: 2
    max_node_attempts: 3
  nodes:
    prepare:
      type: agent
      role: Project workspace guard
      task: |
        Verify stable project anchors before cleanup. Prepare only the literal
        .omp-swarm/spec-review-remediation/run/ subtree. Never edit project files
        or runtime-owned .swarm_* paths. Always atomically write exactly one
        prepare control decision: continue on safe preparation, otherwise fail.
      reports_to: [analyze_domain_a, analyze_domain_b, analyze_governance]
      control:
        signal: .omp-swarm/spec-review-remediation/run/signals/prepare.control.yaml
        allowed_restart_targets: [prepare]

    analyze_domain_a:
      type: agent
      role: Domain A specification analyst
      task: |
        Read only the assigned complete normative domain. Do not edit project
        files. Atomically write a cited requirement packet with coverage status,
        boundaries, conflicts, target symbols, and observable acceptance.
      waits_for: [prepare]
      reports_to: [synthesize_requirements]

    analyze_domain_b:
      type: agent
      role: Domain B specification analyst
      task: |
        Read only the assigned complete normative domain. Do not edit project
        files. Atomically write a distinct cited requirement packet with the same
        contract as the other domain packets.
      waits_for: [prepare]
      reports_to: [synthesize_requirements]

    analyze_governance:
      type: agent
      role: Governance and precedence analyst
      task: |
        Extract canonical vocabulary, active decisions, superseded rules, and the
        exact conflict-precedence algorithm. Do not edit project files. Atomically
        write the governance packet and complete source coverage.
      waits_for: [prepare]
      reports_to: [synthesize_requirements]

    synthesize_requirements:
      type: agent
      role: Requirements integrator
      task: |
        Verify all assigned source coverage, reconcile packets using documented
        precedence, retain unresolved conflicts, assign global requirement IDs,
        and map requirements to ownership clusters and cross-cluster invariants.
        Do not edit project files. Atomically write one READY or BLOCKED matrix.
      waits_for: [analyze_domain_a, analyze_domain_b, analyze_governance]
      reports_to: [implement_foundation]

    implement_foundation:
      type: agent
      role: Foundational implementation reviewer and fixer
      task: |
        Read the matrix and exact controlling sources. Edit only foundational
        owned paths. If BLOCKED, edit nothing. Inspect references before public
        API changes, verify focused behavior, and atomically report compliant
        requirements, exact changes, evidence, and blockers. Remain idempotent.
      waits_for: [synthesize_requirements]
      reports_to: [implement_area_a, implement_area_b, implement_area_c]

    implement_area_a:
      type: agent
      role: Area A implementation reviewer and fixer
      task: |
        Edit only the Area A ownership set after foundations settle. Preserve
        sibling ownership and unrelated work. Verify focused behavior and write
        an idempotent report.
      waits_for: [implement_foundation]
      reports_to: [implement_integration]

    implement_area_b:
      type: agent
      role: Area B implementation reviewer and fixer
      task: |
        Edit only the Area B ownership set, disjoint from same-wave writers.
        Verify focused behavior and write an idempotent report.
      waits_for: [implement_foundation]
      reports_to: [implement_integration]

    implement_area_c:
      type: agent
      role: Area C implementation reviewer and fixer
      task: |
        Edit only the Area C ownership set, disjoint from same-wave writers.
        Verify focused behavior and write an idempotent report.
      waits_for: [implement_foundation]
      reports_to: [implement_integration]

    implement_integration:
      type: agent
      role: Cross-area integration reviewer and fixer
      task: |
        Read all upstream reports and current source. Edit only explicit aggregate,
        lifecycle, export, registry, or other integration paths assigned to this
        serialized layer. Verify composition and report idempotently.
      waits_for: [implement_area_a, implement_area_b, implement_area_c]
      reports_to: [audit_requirements, audit_invariants, audit_composition]

    audit_requirements:
      type: agent
      role: Independent requirement coverage auditor
      task: |
        Inspect the matrix, reports, controlling sources, and actual current code.
        Do not edit project files. Atomically write PASS or actionable FINDINGS.
      waits_for: [implement_integration]
      reports_to: [residual_repair]

    audit_invariants:
      type: agent
      role: Independent invariant auditor
      task: |
        Inspect current code for contract-observable local invariant defects. Do
        not edit project files. Atomically write PASS or actionable FINDINGS.
      waits_for: [implement_integration]
      reports_to: [residual_repair]

    audit_composition:
      type: agent
      role: Independent composition auditor
      task: |
        Inspect current cross-file and bounded caller compatibility. Do not edit
        project files. Atomically write PASS or actionable FINDINGS.
      waits_for: [implement_integration]
      reports_to: [residual_repair]

    residual_repair:
      type: agent
      role: Bounded audit remediation specialist
      task: |
        Read all audit reports and, on restart, the latest final review. Confirm
        each finding against current code and controlling evidence. Fix every
        confirmed finding only inside the declared ownership envelope. Run focused
        checks and atomically report accepted/rejected findings, edits, evidence,
        blockers, or NO-OP. Preserve prior correct edits and remain idempotent.
      waits_for: [audit_requirements, audit_invariants, audit_composition]
      reports_to: [check_behavior, check_static, semantic_acceptance]

    check_behavior:
      type: bash
      command: |
        <focused-behavior-command>
        status=$?
        printf '\nCHECK_EXIT=%s\n' "$status"
        exit "$status"
      output_path: .omp-swarm/spec-review-remediation/run/reports/check-behavior.txt
      cwd: .
      waits_for: [residual_repair]
      reports_to: [check_acceptance]

    check_static:
      type: bash
      command: |
        <focused-static-command>
        status=$?
        printf '\nCHECK_EXIT=%s\n' "$status"
        exit "$status"
      output_path: .omp-swarm/spec-review-remediation/run/reports/check-static.txt
      cwd: .
      waits_for: [residual_repair]
      reports_to: [check_acceptance]

    semantic_acceptance:
      type: agent
      role: Independent semantic acceptance reviewer
      task: |
        Recheck the highest-risk cross-cutting rules against the actual current
        project and controlling sources. Do not edit project files. Atomically
        write PASS, actionable FINDINGS, or BLOCKER with focused reproduction.
      waits_for: [residual_repair]
      reports_to: [final_decision]

    check_acceptance:
      type: agent
      role: Deterministic check evidence reviewer
      task: |
        Read every raw check report and explicit exit marker. Do not edit project
        files. Write PASS only when all required markers are zero and reports are
        valid; otherwise write concrete in-scope FINDINGS or BLOCKER.
      waits_for: [check_behavior, check_static]
      reports_to: [final_decision]

    final_decision:
      type: agent
      role: Final acceptance controller
      task: |
        Read semantic and check acceptance plus the latest residual report. Do not
        edit project files. Atomically write one final report and exactly one
        control decision: continue only on complete acceptance; restart only
        residual_repair for a confirmed in-scope defect; otherwise fail safely.
      waits_for: [semantic_acceptance, check_acceptance]
      control:
        signal: .omp-swarm/spec-review-remediation/run/signals/final.control.yaml
        allowed_restart_targets: [residual_repair]
```

Angle-bracket commands intentionally make the skeleton non-runnable until adapted. Remove unused nodes rather than leaving placeholder or no-op work.

## Expected Waves

For the skeleton above, validation should show equivalent waves:

1. `prepare`
2. `analyze_domain_a`, `analyze_domain_b`, `analyze_governance`
3. `synthesize_requirements`
4. `implement_foundation`
5. `implement_area_a`, `implement_area_b`, `implement_area_c`
6. `implement_integration`
7. `audit_requirements`, `audit_invariants`, `audit_composition`
8. `residual_repair`
9. `check_behavior`, `check_static`, `semantic_acceptance`
10. `check_acceptance`
11. `final_decision`

On `final_decision -> restart residual_repair`, only waves 8-11 rerun. Project files are not rolled back.

## Adaptation Checklist

1. Resolve `workspace` from the final YAML location and define stable project anchors.
2. Replace the generic analysis domains with complete, non-overlapping source ownership and a coverage ledger.
3. Name the authoritative precedence sources and the behavior for unresolved conflicts.
4. Map every mutable project path to exactly one implementation node per wave.
5. Replace the generic implementation shape with the minimum real dependency layers.
6. Assign all shared integration paths to one serialized writer.
7. Give every handoff, report, signal, and check output one exact DAG-owned path and one writer.
8. Define focused verification for each writer without treating self-verification as approval.
9. Select independent audit lenses based on distinct defect classes.
10. Bound residual ownership; do not let it expand from findings.
11. Replace every Bash placeholder with a deterministic non-interactive command and explicit exit markers.
12. Make semantic and command acceptance inspect current project state and complete evidence.
13. Keep `allowed_restart_targets` limited to the residual writer unless a different bounded correction contract is proven necessary.
14. Set concurrency to the widest agent fan-out that is actually safe; Bash nodes do not consume it.
15. Validate the final YAML and compare printed waves with the intended ownership order.

## Common Design Mistakes

| Mistake                                             | Consequence                                                        | Correction                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Parallel writers divided by topic but sharing files | Last-writer wins or mixed partial edits                            | Partition exact paths or serialize through a later owner.                                     |
| Writers interpret specifications independently      | Conflicting policy lands in code                                   | Require one cited precedence-aware synthesis before mutation.                                 |
| One agent implements and approves its own work      | Review evidence is not independent                                 | Fan out read-only audits after all planned writers settle.                                    |
| Auditors edit while reviewing                       | Findings and fixes become untraceable; same-wave collisions appear | Fan findings into one residual writer.                                                        |
| Bash nodes are treated as pass/fail gates           | Downstream work still runs after non-zero exits                    | Capture markers and add a check-acceptance agent.                                             |
| Final acceptance reads summaries only               | Reports can be stale or overclaim current behavior                 | Require inspection of actual source and exact check evidence.                                 |
| Restart targets an early implementation node        | Large graph suffix reruns and reinterprets already-settled work    | Restart the narrow residual writer and its acceptance suffix only.                            |
| Residual repair may edit “anything implicated”      | Review becomes unbounded feature work                              | Predeclare an ownership envelope; out-of-scope defects fail.                                  |
| Preparation reruns during correction                | Current evidence needed by resumed nodes can be deleted            | Keep preparation outside the restart suffix.                                                  |
| More nodes are added for symmetry                   | Extra handoffs and failure surfaces without safe parallelism       | A node must earn its boundary through ownership, expertise, review independence, or recovery. |

Validate the adapted DAG with:

```bash
omp-swarm validate path/to/spec-review-remediation.yaml
```

Completion requires `Validation: ok` and printed waves matching the declared writer ownership, evidence flow, and bounded recovery suffix.
