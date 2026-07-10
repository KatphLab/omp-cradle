# Bash Nodes

Read this complete file when the new DAG contains a `bash` node.

## Fields

```yaml
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
```

| Field         | Required | Contract                                                                           |
| ------------- | -------- | ---------------------------------------------------------------------------------- |
| `type`        | yes      | Exactly `bash`.                                                                    |
| `command`     | yes      | Non-empty deterministic command.                                                   |
| `output_path` | yes      | Safe workspace-relative path receiving captured output.                            |
| `cwd`         | no       | Safe workspace-relative command directory; defaults to the project workspace root. |
| `waits_for`   | no       | Local upstream IDs.                                                                |
| `reports_to`  | no       | Local downstream IDs.                                                              |

A safe relative path is non-empty, is not absolute, and contains no `..` path segment. `output_path` is always resolved from the workspace root, not from `cwd`. The executor creates its parent directory.

Bash nodes do not accept `model`, `extra_context`, `repeat`, or `control`. They do not consume the agent `concurrency` budget.

## Use Bash for Project Verification

Use Bash for deterministic project operations: focused tests, lint, typecheck, build, schema validation, format checks, generated-file comparisons, or other non-interactive commands. Run the project's real command in the project workspace or a safe project-relative `cwd`.

Capture output under a DAG-owned run path. Include an explicit parseable exit marker when a downstream agent must distinguish quiet success from failure. A literal `output_path` can be reused by pipeline/restart execution; clean it on a fresh run and archive it before reuse when prior evidence must survive.

Do not use Bash as a substitute for an agent that must interpret findings or modify source semantically.

## Non-Zero Exit Is Not a Gate

A returned non-zero exit code is recorded, but the Bash node is still settled and downstream dependencies may run. Dependency ordering means “finished,” not “passed.”

When failure affects the workflow:

1. Capture command output and an exit marker.
2. Put an agent after the Bash node.
3. Have that agent inspect the actual project state and report.
4. Emit control `continue`, `restart`, or `fail`, or write another explicit decision artifact.

Never rely on Bash exit status alone to prevent review, publication, or completion.

## Source Safety

Bash and agents share the same project tree. A Bash command may create build outputs or modify files, so declare any mutable project paths it owns. Do not run destructive repository cleanup, broad deletion, hard reset, or commands that discard pre-existing user changes. DAG cleanup is limited to its own coordination directory.
