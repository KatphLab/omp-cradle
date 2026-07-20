# Project Workflows

Read this complete file for every new DAG.

## Use the Existing Project as the Workspace

`swarm.workspace` is the working directory for every agent and the default working directory for Bash. For a useful project workflow, resolve it to the existing project root or to an isolated worktree of that project.

If the YAML is saved below the project root, account for that location. For example, `.omp/source-change.yaml` uses `workspace: ..` to target the project containing `.omp/`.

A normal run creates the workspace directory when it is missing. Validation does not prove that the path points to the intended project. Before source mutation, verify stable project anchors such as the expected manifest, source directory, or configuration file. A typo must fail safely instead of creating and modifying an empty directory.

Prefer an isolated worktree when the DAG may make broad or concurrent edits. When using an existing checkout, preserve pre-existing user changes. Never use destructive reset or clean commands as workflow preparation.

## Project Files Are the Product

Agent nodes run in the shared project workspace. Their tasks may inspect and edit real source, tests, configuration, migrations, documentation, and checked-in generated files. These changes do not need a publisher node: the modified project tree is the intended result.

Use `.omp-swarm/<swarm-name>/...` only for plans, handoffs, command output, review reports, status, cache, and history. Do not stage ordinary source edits there and copy them into the project at the end. Reserve staging plus atomic replacement for a genuinely generated, binary, or single replaceable artifact.

The swarm runtime does not create per-node worktrees, merge concurrent edits, snapshot the project, or roll back files. All nodes and imported graphs see the same current project tree.

## Source-Change Shape

Use only the boundaries the workflow needs:

1. **Project guard:** confirm the resolved workspace is the intended project and prepare only the DAG-owned run directory.
2. **Investigation:** when target files are not known in advance, inspect a bounded module or directory and write an implementation plan naming the discovered files. An investigation is READY when it completely describes authoritative current state and implementation gaps. Missing target implementation is a finding, not a blocker; reserve BLOCKED for missing/malformed authority, unresolved contradiction, or inability to complete the investigation.
3. **Implementation:** edit the actual project files in place. One implementation node may own a coherent change across production code, its tests, and tightly coupled configuration.
4. **Project verification:** run the repository's focused check, build, lint, typecheck, or behavioral command against the modified project.
5. **Independent review:** inspect the actual changed source and verification evidence. Continue on acceptance; for a bounded correction loop, restart the implementation node with concrete findings.
6. **Completion:** leave the project workspace containing the reviewed source changes. Coordination reports are evidence, not the deliverable.

Do not create nodes merely because these labels exist. Omit investigation when targets are already known. Omit dynamic control when one implementation and one final review are sufficient.

## Exploration and Ownership

Exact paths are ideal when known. When they are not known, the task must bound discovery by feature, module, symbol, route, package, or directory and require the agent to record the resulting ownership set before editing.

Parallel modifiers are safe only when their mutable path sets are disjoint. If two agents may touch the same source file, manifest, lockfile, generated index, or migration list, either serialize them or assign that shared path to one later integrator. The runtime has no path lock or conflict detector.

When ownership transfers to a later integrator, name the exact dependency
boundary. Earlier writers cease ownership after settlement; the integrator owns
only the declared transferred paths. A correction target must remain on the
current-owner side of that boundary unless its invalidated suffix safely
re-establishes the full transfer.

Readers and reviewers must wait for the writers whose project state they inspect. Dependencies order execution; they do not carry data or imply success.

## Project-State Contract

For every modifying node, define:

- **Outcome:** observable project behavior or artifact.
- **Inspect:** bounded project scope and declared upstream reports.
- **Edit:** owned project paths, or the plan that supplies them.
- **Phase/current owner:** the node authorized to mutate each project and DAG path before and after any ownership transfer.
- **Do not edit:** sibling ownership and unrelated user work.
- **Verify:** focused project command or observable manual check.
- **Report:** exact DAG-owned evidence path, if a downstream node needs it.
- **Retry:** how rerunning against an already-modified tree remains idempotent.
- **Correction reachability:** for each possible rejection reason, the required mutation and an authorized owner inside the selected restart suffix.
- **Failure:** actionable evidence while preserving unrelated project state.

Review and verification must use the real project tree, not a detached summary of proposed edits. Source control commits are optional workflow outputs only when the user explicitly requires them.
