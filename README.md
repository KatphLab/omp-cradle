# omp-cradle

A local [Oh My Pi](https://github.com/can1357/oh-my-pi) extension package for practical coding workflows: smaller changes, explicit tool risk, independent reviews, and reusable multi-agent pipelines.

## Included

| Capability                       | What it does                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Practical system prompt          | Adds minimal-engineering guidance and live Git context to each agent run.                                                                     |
| Tool severity                    | Requires a severity for shell commands, confirms high-risk operations, and guards destructive edits.                                          |
| ADHD mode                        | Opt-in ADHD-friendly output via /i-have-adhd, --adhd, or the stop phrases documented below.                                                   |
| /commit                          | Runs OMP's commit workflow with `--dry-run`, `--push`, and `--no-changelog` support.                                                          |
| /council and `council`           | Runs four independent `pi/smol` perspectives, then synthesizes a verdict.                                                                     |
| /multi-review and `multi_review` | Runs read-only reviewers on the `pi/smol`, `pi/default`, and `pi/slow` model aliases, then lets the calling agent deduplicate their findings. |
| /swarm and `omp-swarm`           | Validates, runs, resumes, and inspects YAML-defined agent, shell, and nested-graph pipelines.                                                 |
| Swarm skills                     | Guides agents that write or review OMP swarm DAGs.                                                                                            |

## Requirements

- [Bun](https://bun.sh) 1.3.14
- Node.js 24
- An OMP installation compatible with `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` ^18.2.5

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
/i-have-adhd on
/i-have-adhd off
/i-have-adhd
```

Use `/i-have-adhd [on|off|stop]` to toggle ADHD-friendly output for the current session. It is off by default; pass `--adhd` when starting OMP to enable it. The mode persists across session branches and is restored after compaction. Saying "stop adhd mode" or "normal mode" disables it.

Use `/tool-severity off` to suppress severity confirmation prompts for the current session. Native approval policies remain active. Use `/tool-severity on` to restore severity prompts; they reset to enabled when switching or branching sessions.

`/multi-review` and the agent-callable `multi_review` tool only provide model diversity when the `pi/smol`, `pi/default`, and `pi/slow` roles resolve to different models. Configure those roles in `/model` → **Roles**.

Agents can call `multi_review` with a complete `target` and `acceptanceCriteria`, plus optional factual `context`. The tool waits for all three independent reviewers and returns their reports for the caller to deduplicate, preserve disagreements, and attribute findings by reviewer and model alias. Each reviewer result explicitly records `completed`, `failed`, or `aborted` status, the resolved model, exit code, output, and available error/abort diagnostics. Any incomplete reviewer makes the tool result an error; failed or aborted coverage is never an empty successful review. Unresolved model aliases fail before any reviewer starts.

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

Agent nodes finish through the native `yield` tool after publishing their required handoffs and control decisions. Successful yield data becomes the returned agent output and persisted context report: strings are preserved verbatim and other values are serialized as JSON, replacing interim commentary. If an otherwise successful session ends without yielding, the runner requests one final yield under the existing execution limits. Missing yield still fails; model errors, response-length limits and cancellation are not treated as successful completion.
Use [`src/swarm/dag.schema.json`](./src/swarm/dag.schema.json) for editor validation. Working definitions live in [`src/swarm/sample-graphs`](./src/swarm/sample-graphs), and the bundled [`writing-omp-swarm-dags`](./skills/writing-omp-swarm-dags/SKILL.md) and [`reviewing-omp-swarm-dags`](./skills/reviewing-omp-swarm-dags/SKILL.md) skills document the authoring constraints.

#### Packaged PR review

The standalone CLI reviews a PR without modifying source:

```bash
omp-swarm review-pr 195 --validate
omp-swarm review-pr 195
```

`--validate` renders and validates the graph offline, without authentication, GitHub requests, agent calls or file writes. To run a review, authenticate `gh` and start in a clean checkout of the open PR head, including untracked files. The CLI resolves the canonical repository, captures GitHub identity and the local commit diff, and rechecks identity before publishing frozen evidence. It never fetches or checks out a branch.

The graph is `correctness + simplicity → adjudicate`: two direct independent reviewers, then one consolidator. All three use `pi/smol`; there are no nested reviewers, implementation stages or automatic repair loops. Reviewers inspect source but do not run project checks. Fixing findings is a separate, explicitly requested task. The obsolete `--report-only` flag is removed because every review is now report-only.

The CLI owns `.omp-swarm/review-pr-195/run/freeze.yaml` (identity and changed paths) and `pr.patch`. Agents publish Markdown through `write_review_report`, which attaches frozen identity, checks current HEAD and source cleanliness, safely writes the node-specific YAML, and reads it back. Consolidation requires both upstream reviews to be READY with the same identity. It preserves reviewer attribution and disagreements and publishes `run/findings.md` with COMPLETE or BLOCKED status. COMPLETE means the review finished, not that the PR is safe to merge. No fixes or post-fix verification are performed.

Fresh invocation refuses existing review or runtime artifacts rather than replacing evidence. Existing generated workflows are not migrated. Use a separate clean checkout for a fresh review; never blindly delete old evidence. Restarting a new-format generated workflow reruns all three agents against its frozen PR snapshot, not fresh remote metadata. Changed local HEAD/source blocks publication; for a newer PR revision start a fresh review.

Agents must not inspect runtime state or session transcripts, delegate, access secrets/network, or alter source. Restricted native sessions retain the configured approval policy and execution limits. Report writes reject tracked destinations and symlinks using the existing safe writer, which requires Linux `/proc/self/fd`; this is not a general filesystem sandbox.

### Workflow source layout

Packaged workflows live under `src/swarm/workflows/<name>/`. Keep each DAG and its workflow-specific TypeScript together:

```text
src/swarm/
  cli.ts                       # CLI command dispatch
  swarm/                       # Shared DAG execution runtime
  signal-tools.ts              # Shared control/repeat tools
  workflows/
    review-pr/
      workflow.yaml            # DAG template
      prepare.ts               # CLI preparation and PR preflight
      report-tool.ts           # PR-specific report publication
```

Add a sibling directory for another workflow; include helpers only when needed. Load templates relative to their module with `import.meta.url`. Keep workflow-specific checks and tools in that directory, and wire any CLI command or custom tool explicitly at the existing CLI/executor integration points. Shared execution primitives stay in `swarm/`; generated run artifacts remain under `.omp-swarm/`, separate from packaged source.

## Development

```bash
bun fix    # apply formatting, lint, and Knip fixes
bun check  # format, lint, typecheck, architecture, dead-code, and duplication checks
```

Run the system-prompt behavior evaluation with:

```bash
bun src/system-prompt/eval/index.ts
```

For a quick single-scenario run:

```bash
OMP_EVAL_RUNS=1 OMP_EVAL_SCENARIO=existing-code-reuse bun src/system-prompt/eval/index.ts
```

Optionally set `OMP_EVAL_MODEL` and `OMP_EVAL_THINKING` to select the model and thinking level. The evaluation writes `report/system-prompt-eval.json`.

See [`AGENTS.md`](./AGENTS.md) for repository contribution rules.
