# omp-cradle

A local [Oh My Pi](https://github.com/can1357/oh-my-pi) extension package for practical coding workflows: smaller changes, explicit tool risk, independent reviews, and reusable multi-agent pipelines.

## Included

| Capability                         | What it does                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Practical system prompt            | Adds minimal-engineering guidance and live Git context to each agent run.                                                                     |
| Tool severity                      | Requires a severity for shell commands, confirms high-risk operations, and guards destructive edits.                                          |
| `/commit`                          | Runs OMP's commit workflow with `--dry-run`, `--push`, and `--no-changelog` support.                                                          |
| `/council` and `council`           | Runs four independent `pi/smol` perspectives, then synthesizes a verdict.                                                                     |
| `/multi-review` and `multi_review` | Runs read-only reviewers on the `pi/smol`, `pi/default`, and `pi/slow` model aliases, then lets the calling agent deduplicate their findings. |
| `/swarm` and `omp-swarm`           | Validates, runs, resumes, and inspects YAML-defined agent, shell, and nested-graph pipelines.                                                 |
| Swarm skills                       | Guides agents that write or review OMP swarm DAGs.                                                                                            |

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
/tool-severity off
```

Use `/tool-severity off` to suppress severity confirmation prompts for the current session. Use `/tool-severity on` to restore them; prompts reset to enabled when switching sessions.

`/multi-review` and the agent-callable `multi_review` tool only provide model diversity when the `pi/smol`, `pi/default`, and `pi/slow` roles resolve to different models. Configure those roles in `/model` → **Roles**.

Agents can call `multi_review` with a complete `target` and `acceptanceCriteria`, plus optional factual `context`. The tool waits for all three independent reviewers and returns their reports for the caller to deduplicate, preserve disagreements, and attribute findings by reviewer and model alias.

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

#### Packaged PR review

The standalone CLI includes a single-pass PR workflow (not a `/swarm review-pr` extension command):

```bash
omp-swarm review-pr 195 --validate
omp-swarm review-pr 195
```

Use a positive PR number. `--validate` checks the packaged graph locally and offline: no authentication, GitHub or agent calls, or file writes. To run it, authenticate GitHub CLI (`gh auth login`) and start in the current repository with a clean working tree, including untracked source files, already at the open PR's HEAD. The command uses the repository root; it does not check out a branch or create a worktree.

Complementary parallel reviews feed adjudication, one implementer, verification, and independent acceptance. There are no automatic correction loops. Fixes remain as uncommitted local changes; the workflow does not post comments, commit, merge, or push.

The generated graph is `.omp-swarm/review-pr-195/workflow.yaml`; the final report is `.omp-swarm/review-pr-195/run/acceptance.md`. A fresh invocation refuses an existing graph path rather than overwriting it. After inspecting the findings, use the existing restart command:

```bash
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from implementer
```

Restart does not roll back files. State policy may invalidate upstream results, so reuse is not guaranteed.

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
