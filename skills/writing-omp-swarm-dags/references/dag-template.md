# Project Source-Change DAG Template

Use only for the exact complete-template match selected in `SKILL.md`; do not also load equivalent node references.

Save this example as `.omp/source-change.yaml` inside the project root. Because paths resolve from the YAML location, `workspace: ..` selects the existing project.

```yaml
swarm:
  name: source-change
  workspace: ..
  mode: parallel
  concurrency: 2
  restart_policy:
    max_restarts: 2
    max_restarts_per_target: 2
    max_node_attempts: 3
  nodes:
    prepare:
      type: agent
      role: Project workspace guard
      task: |
        Outcome:
        - Establish the intended TypeScript workspace and a clean DAG-owned run
          directory without changing project work.

        Inputs / read:
        - Read package.json and inspect src/ as project anchors.
        - If either anchor is missing or malformed, preserve all existing files
          and emit the fail decision defined below.

        Scope:
        - Inspect: package.json, src/, and the literal
          .omp-swarm/source-change/run/ path.
        - May edit: only .omp-swarm/source-change/run/.
        - Must not edit: project source, user changes, .git, or .swarm_*.

        Decision rules:
        - READY when both anchors identify the intended project and the run path
          resolves safely inside the workspace; otherwise BLOCKED.

        Acceptance / verification:
        - READY requires recreated handoffs/, reports/, and signals/ directories
          and a successful submit_control_decision call.

        Outputs / handoffs:
        - The runtime writes signals/prepare.control.yaml from the typed control
          decision; failure to submit it fails this node.

        Control / correction:
        - Call submit_control_decision with action continue only for READY.
        - Otherwise call it with action fail, a safe reason, and no target.

        Retry / failure:
        - Recheck anchors before cleanup; make directory recreation idempotent.
        - Preserve project files and existing inputs on every failure.
      reports_to: [investigate]
      control:
        signal: .omp-swarm/source-change/run/signals/prepare.control.yaml
        allowed_restart_targets: [prepare]
      resume:
        id: prepare
        contract_version: 1
        state_version: 1
        policy: preserve

    investigate:
      type: agent
      role: Source change investigator
      task: |
        Outcome:
        - Produce an implementation plan that authorizes the requested source
          change without editing project files.

        Inputs / read:
        - Read docs/feature-request.md as authority.
        - Read package.json, applicable project guidance, and the bounded src/
          module implicated by the request.
        - Missing or contradictory authority is BLOCKED; missing target
          implementation is a READY finding.

        Scope:
        - Inspect: package.json, applicable guidance, and the bounded src/ module.
        - May edit: only
          .omp-swarm/source-change/run/handoffs/implementation-plan.md.
        - Must not edit: project files, sibling artifacts, user work, or .swarm_*.

        Decision rules:
        - READY when the request and authority permit an exact bounded plan.
        - BLOCKED only for missing, malformed, or contradictory authority.

        Acceptance / verification:
        - Confirm every editable path is inside the bounded module and every
          requested behavior maps to an observable acceptance case.

        Outputs / handoffs:
        - Overwrite implementation-plan.md as Markdown for implement.
        - Include status, observable_behavior, owned_paths, forbidden_paths,
          conventions, acceptance_cases, and focused_verification_command.
        - On BLOCKED, include actionable blockers and no editable paths.

        Control / correction:
        - No control signal.

        Retry / failure:
        - Re-read current authority and overwrite stale plan evidence atomically.
        - Preserve every project file on failure.
      waits_for: [prepare]
      reports_to: [implement]
      resume:
        id: investigate
        contract_version: 1
        state_version: 1
        policy: inputs-unchanged

    implement:
      type: agent
      role: TypeScript feature implementer
      task: |
        Outcome:
        - Implement or repair every acceptance case authorized by the current
          implementation plan in the real project tree.

        Inputs / read:
        - Read implementation-plan.md from investigate and review.md from review
          when present.
        - Require READY status, owned_paths, forbidden_paths, acceptance_cases,
          and focused_verification_command.
        - On missing or malformed plan, write the failure handoff and make no
          source edit.

        Scope:
        - Inspect: current project files named by implementation-plan.md.
        - May edit: only owned_paths and
          .omp-swarm/source-change/run/handoffs/implementation.md.
        - Must not edit: forbidden_paths, sibling-owned files, unrelated modules,
          user work, staged source copies, or .swarm_*.

        Decision rules:
        - Not applicable.

        Acceptance / verification:
        - Run focused_verification_command.
        - Every acceptance case must pass without regressing preserved behavior.

        Outputs / handoffs:
        - Overwrite implementation.md as Markdown for review.
        - Include changed_paths, behavior_summary, verification_command,
          verification_exit, and unresolved_findings.

        Control / correction:
        - No control signal.

        Retry / failure:
        - Re-read current source and latest review; prior edits remain.
        - Preserve already-correct and unrelated work; apply only missing fixes.
        - On failure, record actionable safe diagnostics in implementation.md.
      waits_for: [investigate]
      reports_to: [check]
      resume:
        id: implement
        contract_version: 1
        state_version: 1
        policy: inputs-unchanged

    check:
      type: bash
      command: |
        bun check; status=$?
        printf '\nCHECK_EXIT=%s\n' "$status"
        exit "$status"
      output_path: .omp-swarm/source-change/run/reports/check.txt
      cwd: .
      waits_for: [implement]
      reports_to: [review]
      resume:
        id: check
        contract_version: 1
        state_version: 1
        policy: inputs-unchanged

    review:
      type: agent
      role: Independent source and behavior reviewer
      task: |
        Outcome:
        - Independently accept the current source change or emit one reachable
          correction/failure decision.

        Inputs / read:
        - Read implementation-plan.md from investigate, implementation.md from
          implement, and reports/check.txt from check.
        - Require the plan/summary fields named above and one CHECK_EXIT marker.
        - Missing, stale, duplicate, or malformed evidence cannot pass.

        Scope:
        - Inspect: actual current source paths named by the plan and the three
          declared inputs.
        - May edit: reports/review.md and signals/review.control.yaml.
        - Must not edit: project files, upstream handoffs, user work, or .swarm_*.

        Decision rules:
        - ACCEPT only when source behavior, conventions, ownership, and
          CHECK_EXIT=0 satisfy every acceptance case.
        - REJECT with restart only when implement owns the required mutation.
        - Otherwise fail for an unreachable owner or impossible prerequisite.

        Acceptance / verification:
        - Reproduce the highest-risk acceptance behavior against current source
          and validate the check marker and ownership evidence.

        Outputs / handoffs:
        - Overwrite reports/review.md as Markdown with verdict, findings,
          evidence, required_mutation, correction_owner, and restart_target.
        - Submit exactly one runtime decision with submit_control_decision.
        - Failure to produce the report or submit the decision fails this node.

        Control / correction:
        - Call submit_control_decision with action continue only for ACCEPT.
        - Call it with action restart, target implement, and a concrete reason
          only for a confirmed owned correction that the implement -> check ->
          review suffix can make false.
        - Call it with action fail and a safe reason for missing evidence, unsafe
          scope, or unreachable correction.

        Retry / failure:
        - Re-read current source and all current evidence; no files roll back.
        - Supersede stale findings, overwrite the report, and submit a fresh decision.
        - Preserve project and upstream files on failure.
      waits_for: [check]
      control:
        signal: .omp-swarm/source-change/run/signals/review.control.yaml
        allowed_restart_targets: [implement]
      resume:
        id: review
        contract_version: 1
        state_version: 1
        policy: never
```

Before adapting this topology, enumerate every possible review rejection reason
and compute the `implement -> check -> review` invalidated suffix. `implement`
must own every required correction; the reviewer alone owns its report and
signal. Missing implementation discovered by `investigate` must still permit a
complete plan.

The terminal accepted state is the modified project tree plus review evidence. There is no publisher node because ordinary source files are edited and verified in place.

Validate after adapting the template:

```bash
omp-swarm validate .omp/source-change.yaml
```

Do not add imports, pipeline iterations, repeat, cache, or extra agents unless the workflow needs them; return to the `SKILL.md` router and load only the newly matched reference.
