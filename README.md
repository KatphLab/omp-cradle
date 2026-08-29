# omp-cradle

A local [Oh My Pi](https://github.com/can1357/oh-my-pi) extension package for practical coding workflows: smaller changes, explicit tool risk, independent reviews, and reusable multi-agent pipelines.

## Included

| Capability               | What it does                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Practical system prompt  | Adds minimal-engineering guidance and live Git context to each agent run.                                               |
| Tool severity            | Requires a severity for shell commands, confirms high-risk operations, and guards destructive edits.                    |
| `/commit`                | Runs OMP's commit workflow with `--dry-run`, `--push`, and `--no-changelog` support.                                    |
| `/council` and `council` | Runs four independent `pi/smol` perspectives, then synthesizes a verdict.                                               |
| `/multi-review`          | Runs read-only reviewers on the `pi/smol`, `pi/default`, and `pi/slow` model aliases, then deduplicates their findings. |
| `/swarm` and `omp-swarm` | Validates, runs, resumes, and inspects YAML-defined agent, shell, and nested-graph pipelines.                           |
| Swarm skills             | Guides agents that write or review OMP swarm DAGs.                                                                      |

## Requirements

- [Bun](https://bun.sh) 1.3.14
- Node.js 24
- An OMP installation compatible with `@oh-my-pi/pi-coding-agent` 17.2

## Setup

From this checkout:

```bash
bun install
omp plugin link .
```

Start a new OMP session to load the linked package. During extension development, run `/reload-plugins` in an existing session after changing source files.

To load the checkout for one session without linking it:

```bash
omp --extension .
```

## Usage

### Practical commands

```text
/commit --dry-run
/council Should this state live in the session or the workspace?
/multi-review Review the current branch against main
```

`/multi-review` only provides model diversity when the `pi/smol`, `pi/default`, and `pi/slow` roles resolve to different models. Configure those roles in `/model` → **Roles**.

### Swarms

Run a DAG inside OMP:

```text
/swarm run path/to/pipeline.yaml
/swarm status pipeline-name
/swarm restart path/to/pipeline.yaml --from review
```

Or use the standalone CLI:

```bash
omp-swarm validate path/to/pipeline.yaml
omp-swarm plan-models path/to/pipeline.yaml
omp-swarm path/to/pipeline.yaml
omp-swarm restart path/to/pipeline.yaml --from review
```

A swarm is a YAML dependency graph of agent, shell, or nested graph nodes. Runs persist state in the configured workspace, allowing targeted restarts with `--reuse`, `--rerun`, or `--from`.

Use [`src/swarm/dag.schema.json`](./src/swarm/dag.schema.json) for editor validation. Working definitions live in [`src/swarm/sample-graphs`](./src/swarm/sample-graphs), and the bundled [`writing-omp-swarm-dags`](./skills/writing-omp-swarm-dags/SKILL.md) and [`reviewing-omp-swarm-dags`](./skills/reviewing-omp-swarm-dags/SKILL.md) skills document the authoring constraints.

## Development

```bash
bun fix    # apply formatting, lint, and Knip fixes
bun check  # format, lint, typecheck, architecture, dead-code, and duplication checks
```

Run the system-prompt behavior evaluation with:

```bash
make eval-system-prompt
```

For a quick single-scenario run:

```bash
RUNS=1 SCENARIO=existing-code-reuse make eval-system-prompt
```

The evaluation writes `report/system-prompt-eval.json`.

See [`AGENTS.md`](./AGENTS.md) for repository contribution rules.
