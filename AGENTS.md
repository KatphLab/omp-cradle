## Workflow and package management

- Use bun only. Run repo scripts with `bun`; do not use `npm`.
- Do not edit `package.json` manually.
- Before feature work, verify the branch is not `main` or `master`; if it is, create a descriptive feature branch.
- For isolated worktrees, use `.worktrees/`.
- Prefer branch names like `feat/<scope>-<short-desc>`, `fix/<scope>-<short-desc>`, or `chore/<scope>-<short-desc>`.
- Prefer commits like `<type>(<scope>): <why>` with `feat`, `fix`, `refactor`, `docs`, or `chore`.
- Keep commit messages focused on intent and impact, not file-by-file narration.

## Tooling

- Tooling configuration files may be edited when the user explicitly requests tooling changes.
- If checks fail, fix the root cause instead of bypassing the tool.

## Implementation rules

- This project is TypeScript-only. Do not write `.js` files.
- Reuse existing modules and utilities before adding new code.
- Prefer the smallest correct change, consistent with local patterns.
- When replacing behavior, remove the obsolete path instead of keeping parallel logic.
- Every file must be a self-contained module; do not rely on global augmentation across files.
- Add or update dependencies only when existing repo modules cannot solve the problem cleanly.
- For each dependency change, include rationale plus security and license impact in the PR or commit.
- If a change affects public behavior, workflow, configuration, or contributor expectations, update docs in the same change set.

## Verification

- This repository uses local static verification only.
- Verify behavior changes with the smallest relevant local command or manual smoke check.
- Do not bypass quality gates, pre-commit hooks, or static-analysis findings.
- Before claiming work complete, run targeted verification for changed behavior and `bun check`.
- `bun check` runs: format, lint, typecheck, dependency-cruiser, Knip, and jscpd.
- Use `bun fix` to auto-apply Prettier, ESLint, and Knip fixes before the full gate.

## Error handling and security

- Normalize unknown thrown values to `Error` at module boundaries; never rethrow raw `unknown`.
- Show users safe, actionable messages. Do not expose stack traces or internal identifiers.
- Preserve useful developer diagnostics: context, failed operation, and safe identifiers.
- Do not introduce `eval`, the `Function` constructor, unsafe shell execution, or hardcoded secrets.
- Treat security findings as defects; fix the root cause.

## oh-my-pi documentation

- /home/lalit/github/oh-my-pi/docs/extensions.md
- /home/lalit/github/oh-my-pi/src/extensibility/extensions
