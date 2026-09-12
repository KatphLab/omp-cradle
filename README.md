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
- An OMP installation compatible with `@oh-my-pi/pi-coding-agent` ^18.1.17

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
omp-swarm review-pr 195 --report-only
omp-swarm review-pr 195 --report-only --validate
```

Use a positive PR number. `--validate` checks the selected mode's graph locally and offline: no authentication, GitHub or agent calls, or file writes. To run either mode, authenticate GitHub CLI (`gh auth login`) and start in the current repository with a clean working tree, including untracked source files, already at the open PR's HEAD. The command uses the repository root; it does not check out a branch or create a worktree.

Complementary correctness and simplicity reviews each call `multi_review` once for subreviews from the `pi/smol`, `pi/default`, and `pi/slow` model role aliases; adjudication consolidates their findings. Model diversity requires those aliases to resolve to different models. By default, adjudication feeds one implementer, verification, and independent acceptance. There are no automatic correction loops. Fixes remain as uncommitted local changes; the workflow does not post comments, commit, merge, or push.

Both review stages await `multi_review` in a dedicated `functions.eval` call with `timeout: 0`, disabling the outer eval deadline while the three reviewers finish.

Final acceptance assesses published `run/` handoffs and permitted source, using the reviewer originals and check evidence embedded in those handoffs. It must not retrieve `history://`, `agent://`, session transcripts, or runtime-owned artifacts to verify provenance. Missing or contradictory evidence blocks acceptance and identifies the responsible producer; it does not authorize runtime reads.

Each `multi_review` invocation uses unique runtime reviewer IDs while preserving reviewer/model attribution, so concurrent stages do not share reviewer sessions. Every agent reads back and validates its written report before completing, including nested `identity.run_id` and node-specific evidence. Freeze binds the review to Git commit identity and validates its patch/path listing and manifest before signaling success; it may correct its own drafts before that signal. Stages inspect Git status/diffs and owned paths rather than custom checksums or source fingerprints. Published freeze evidence is not corrected while reviews are running: invalid evidence blocks and requires an explicitly authorized fresh attempt.

Fix-mode check plans must keep disposable fixtures and cleanup inside the repository. Containment tests use sibling simulated-workspace and outside-target directories under one uniquely created local fixture root; only that root may be recursively removed. Adjudication checks this before publishing the plan, and verification independently rechecks it.

Stage models are explicit: `freeze` uses `pi/smol` for procedural identity checks; `correctness`, `simplicity`, `implementer`, and `verify` use `pi/default` for review coordination, bounded fixes, and check interpretation; `adjudicate` and `acceptance` use `pi/slow` for cross-review reasoning and independent final judgment. These aliases use your configured OMP model roles.

`--report-only` ends at adjudication, skipping implementation, verification, and acceptance without source edits. It writes `.omp-swarm/review-pr-195/run/findings.md` with consolidated evidence, severity, reviewer disagreements, and recommendations. Findings are not auto-fixed, and the report is not merge acceptance.

Both modes use the same generated graph path, `.omp-swarm/review-pr-195/workflow.yaml`, so they cannot coexist there: a fresh invocation refuses an existing graph rather than overwriting it. Fresh runs also refuse any existing `.swarm_review-pr-195` runtime entry; inspect it before explicitly restarting the existing workflow. The default mode's final report remains `.omp-swarm/review-pr-195/run/acceptance.md`. After inspecting the findings, restart the generated graph at the appropriate stage:

```bash
# Default fix-mode graph
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from implementer
# Report-only graph
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from adjudicate
```

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
