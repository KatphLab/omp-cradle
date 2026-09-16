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

Complementary correctness and simplicity reviews each call `multi_review` once for three independent subreviews using `pi/smol`; adjudication consolidates their findings. Swarm-provided `multi_review` inherits the node model rather than selecting different model roles. By default, adjudication feeds one implementer, verification, and independent acceptance. There are no automatic correction loops. Fixes remain as uncommitted local changes; the workflow does not post comments, commit, merge, or push.

Both review stages explicitly allow `eval` for their dedicated `functions.eval` call and `bash` for Git inspection and Bun report read-back. They await `multi_review` with `timeout: 0`, disabling the outer eval deadline while the three reviewers finish. Host settings must enable the JavaScript eval backend and Bash; unavailable tools or incomplete reviewer coverage block the stage.

Final acceptance assesses published `run/` handoffs and permitted source, using the reviewer originals and check evidence embedded in those handoffs. It must not retrieve `history://`, `agent://`, session transcripts, or runtime-owned artifacts to verify provenance. Missing or contradictory evidence blocks acceptance and identifies the responsible producer; it does not authorize runtime reads.

Each `multi_review` invocation uses a fresh UUID prefix for its runtime reviewer IDs while preserving stable reviewer/model attribution, so concurrent and repeated calls do not share reviewer sessions. Every agent reads back and validates its written report before completing, including nested `identity.run_id` and node-specific evidence. Freeze binds the review to Git commit identity and validates its patch/path listing and manifest before signaling success; it may correct its own drafts before that signal. Stages inspect Git status/diffs and owned paths rather than custom checksums or source fingerprints. Published freeze evidence is not corrected while reviews are running: invalid evidence blocks and requires an explicitly authorized fresh attempt.

Fix-mode plans execute inspected fixture/setup prerequisites before publication and map every material requirement, including security negative cases, to checks. Setup failure blocks publication; an expected pre-fix behavioral failure does not. Disposable fixtures and cleanup stay inside a unique repository-local root. A fixture may initialize its own Git repository and index using sanitized child Git configuration/environment and asserted repository ownership, but may never borrow or mutate the project index, commit, run hooks, or use the network. Verification independently reruns the exact published commands against a READY implementation.

All review stages and nested reviewers use `pi/smol`, resolved through your configured OMP model role. Swarm nodes run in fresh native SDK sessions with explicitly allowed custom tools, preserving restricted tool lists without dependency patches or reopening previous agent sessions.

`--report-only` ends at adjudication, skipping implementation, verification, and acceptance without source edits. It writes `.omp-swarm/review-pr-195/run/findings.md` with consolidated evidence, severity, reviewer disagreements, and recommendations. Findings are not auto-fixed, and the report is not merge acceptance.

Both modes use the same generated graph path, `.omp-swarm/review-pr-195/workflow.yaml`, so they cannot coexist there: fresh invocation refuses an existing graph or runtime entry rather than overwriting it. The default mode's final report remains `.omp-swarm/review-pr-195/run/acceptance.md`. Signal-path checks do not yet provide a complete tracked-file and symlink safety guarantee across every runtime write/cleanup path; workflow restrictions are not a runtime sandbox.

For an unchanged safe plan, an operator may restart fix mode at `implementer`; it rechecks remote PR identity even for a no-change result. To repair the plan or its check prerequisites while retaining partial fixes, first explicitly authorize same-identity replanning in the generated `adjudicate` task, naming the exact frozen `run_id` and `head`. No authorization is present by default. The entire unstaged delta must match prior recorded source evidence within prior ownership; unrelated edits, staging or unevidenced untracked bytes block recovery. Adjudicate alone archives existing plan/implementation/verification/acceptance reports under a unique `run/recovery-<uuid>/` before replacement and links the archive and retained delta in the successor plan; frozen PR and review evidence stay unchanged.

`--from` selects a restart suffix, not guaranteed upstream reuse: strict definition/version drift or other resume invalidation may rerun upstream stages. Those stages preserve frozen identity and review evidence during authorized recovery; they cannot freeze a new identity over dirty source. Report-only restarts must start at `freeze` for fresh remote identity validation. Any route bypassing implementer likewise requires freeze to rerun. Workflow/documentation edits are not automatically attributable PR fixes, so updating this workflow does not make the current tree restart-ready.

```bash
# Fix mode: unchanged safe plan
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from implementer
# Fix mode: only after recording explicit same-identity replanning authorization
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from adjudicate
# Report-only: fresh identity validation required
omp-swarm restart .omp-swarm/review-pr-195/workflow.yaml --from freeze
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
