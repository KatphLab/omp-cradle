# Project Source-Change DAG Template

Read this complete file only when a concrete composition helps. This is a TypeScript-project example, not the field reference. Replace the request path, project anchors, bounded source scope, and project check command before use.

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
        Work in the existing project workspace. Verify that package.json and src/
        identify the intended TypeScript project. Never modify or delete project
        source, user changes, .git, or any .swarm_* directory.

        If the anchors are valid, remove only .omp-swarm/source-change/run/,
        recreate its handoffs/, reports/, and signals/ directories, then write
        .omp-swarm/source-change/run/signals/prepare.control.yaml with exactly:
        action: continue
        reason: project anchors verified and run directory prepared

        If an anchor is missing, do not delete anything. Write the same control
        file with action: fail and a safe reason.
      reports_to: [investigate]
      control:
        signal: .omp-swarm/source-change/run/signals/prepare.control.yaml
        allowed_restart_targets: [prepare]

    investigate:
      type: agent
      role: Source change investigator
      task: |
        Read docs/feature-request.md. Inspect only package.json, relevant project
        guidance, and the bounded src/ module implicated by the request. Do not
        edit project files. Write
        .omp-swarm/source-change/run/handoffs/implementation-plan.md containing:
        the observable behavior, exact source/config/test paths the implementer
        may edit, paths it must not edit, existing conventions to reuse, and the
        focused verification command.
      waits_for: [prepare]
      reports_to: [implement]

    implement:
      type: agent
      role: TypeScript feature implementer
      task: |
        Read .omp-swarm/source-change/run/handoffs/implementation-plan.md and, if
        present, .omp-swarm/source-change/run/reports/review.md. Inspect the
        current project files named by the plan. Implement or repair the feature
        directly in those real project paths; do not create staged source copies.
        Preserve unrelated user changes and do not edit paths outside the plan.
        Make the change idempotent when prior edits already exist. Write a concise
        implementation summary to
        .omp-swarm/source-change/run/handoffs/implementation.md.
      waits_for: [investigate]
      reports_to: [check]

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

    review:
      type: agent
      role: Independent source and behavior reviewer
      task: |
        Read the implementation plan, implementation summary, and check report.
        Inspect the actual changed project source; do not review staged copies and
        do not edit project files. Verify the requested behavior, project
        conventions, path ownership, and CHECK_EXIT value. Write findings to
        .omp-swarm/source-change/run/reports/review.md.

        If the source and checks pass, write
        .omp-swarm/source-change/run/signals/review.control.yaml with action:
        continue and a reason. If a correctable defect remains, write action:
        restart, target: implement, and a concrete reason. If safe completion is
        impossible, write action: fail and a concrete reason.
      waits_for: [check]
      control:
        signal: .omp-swarm/source-change/run/signals/review.control.yaml
        allowed_restart_targets: [implement]
```

The terminal accepted state is the modified project tree plus review evidence. There is no publisher node because ordinary source files are edited and verified in place.

Validate after adapting the template:

```bash
omp-swarm validate .omp/source-change.yaml
```

Do not add imports, pipeline iterations, repeat, cache, or extra agents unless the workflow actually needs them; read the corresponding complete reference file first.
