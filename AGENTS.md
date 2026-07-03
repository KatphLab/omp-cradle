## Workflow and package management

- Use pnpm only. Run repo scripts with `pnpm`; do not use `npm`.
- Do not edit `package.json` manually.
- Before feature work, verify the branch is not `main` or `master`; if it is, create a descriptive feature branch.
- For isolated worktrees, use `.worktrees/`.
- Prefer branch names like `feat/<scope>-<short-desc>`, `fix/<scope>-<short-desc>`, or `chore/<scope>-<short-desc>`.
- Prefer commits like `<type>(<scope>): <why>` with `feat`, `fix`, `refactor`, `test`, `docs`, or `chore`.
- Keep commit messages focused on intent and impact, not file-by-file narration.

## Protected tooling

- Never modify tooling configuration files. If checks fail, fix the root cause in code instead of bypassing the tool.
- Forbidden files:
  - `.dependency-cruiser.js`
  - `.jscpd.json`
  - `.prettierrc.json`
  - `.semgrep.yml`
  - `eslint.config.mjs`
  - `knip.json`
  - `tsconfig.json`
  - `vitest.config.ts`
  - `vitest.setup.ts`
  - `vitest.strict-reporter.ts`

## Implementation rules

- This project is TypeScript-only. Do not write `.js` files.
- Reuse existing modules and utilities before adding new code.
- Prefer the smallest correct change, consistent with local patterns.
- When replacing behavior, remove the obsolete path instead of keeping parallel logic.
- Every file must be a self-contained module; do not rely on global augmentation across files.
- Add or update dependencies only when existing repo modules cannot solve the problem cleanly.
- For each dependency change, include rationale plus security and license impact in the PR or commit.
- If a change affects public behavior, workflow, configuration, or contributor expectations, update docs in the same change set.

## Testing and verification

- Test changes to state transitions, side effects, data contracts, output shape, and error or edge cases.
- For behavior changes, cover both success and failure paths with targeted tests.
- Keep per-file coverage at or above 90% for statements, branches, functions, and lines.
- Do not bypass quality gates, pre-commit hooks, or static-analysis findings.
- Before claiming work complete, run targeted verification for changed behavior and `pnpm check`.
- `pnpm check` runs: format, lint, typecheck, Vitest coverage, dependency-cruiser, Knip, and jscpd.
- Use `pnpm fix` to auto-apply Prettier, ESLint, and Knip fixes before the full gate.

## Error handling and security

- Normalize unknown thrown values to `Error` at module boundaries; never rethrow raw `unknown`.
- Show users safe, actionable messages. Do not expose stack traces or internal identifiers.
- Preserve useful developer diagnostics: context, failed operation, and safe identifiers.
- Do not introduce `eval`, the `Function` constructor, unsafe shell execution, or hardcoded secrets.
- Treat security findings as defects; fix the root cause.
