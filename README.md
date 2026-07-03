# ts-pnpm-template

A production-ready TypeScript template for Node.js scripts, CLIs, and libraries with comprehensive tooling for code quality, testing, security, and CI/CD.

## Features

- **[TypeScript](https://www.typescriptlang.org)** with strict configuration for Node.js
- **[tsx](https://github.com/privatenumber/tsx)** for fast TypeScript execution in development
- **[Vitest](https://vitest.dev)** for testing with coverage (90% threshold)
- **Code Quality**: ESLint, Prettier, Husky, lint-staged
- **Architecture Enforcement**: ESLint boundaries, dependency-cruiser, knip
- **Security**: Semgrep, ESLint security plugins, duplicate code detection
- **CI/CD**: GitHub Actions with comprehensive PR checks

## Getting Started

### Prerequisites

- Node.js >=24.0.0 <25 (managed via `packageManager: pnpm@10.33.4`)
- pnpm (Corepack enabled)

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

Runs `src/index.ts` in watch mode with tsx.

### Build

```bash
pnpm build
```

Compiles TypeScript to `dist/` using `tsc`.

### Run

```bash
pnpm start
```

Executes the compiled output from `dist/`.

## Scripts

| Script               | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`           | Run in development with tsx watch                                                |
| `pnpm build`         | Compile TypeScript to dist/                                                      |
| `pnpm start`         | Run compiled output                                                              |
| `pnpm lint`          | Run ESLint                                                                       |
| `pnpm lint:fix`      | Fix ESLint issues                                                                |
| `pnpm typecheck`     | Run TypeScript compiler (no emit)                                                |
| `pnpm format`        | Format code with Prettier                                                        |
| `pnpm format:check`  | Check formatting                                                                 |
| `pnpm test`          | Run tests with Vitest                                                            |
| `pnpm test:ci`       | Run tests with coverage                                                          |
| `pnpm test:watch`    | Run tests in watch mode                                                          |
| `pnpm test:coverage` | Run tests with coverage report                                                   |
| `pnpm check`         | **Full quality gate**: format, lint, typecheck, tests, depcruise, knip, dupcheck |
| `pnpm fix`           | Auto-fix issues: format, lint, knip                                              |
| `pnpm depcruise`     | Check architecture boundaries                                                    |
| `pnpm knip`          | Find unused dependencies/exports                                                 |
| `pnpm dupcheck`      | Check for code duplication                                                       |

## Quality Gates

This repository enforces high standards:

- **Coverage**: 90% per file for statements, branches, functions, and lines
- **No skipped/todo tests**: Vitest strict reporter fails builds
- **Architecture boundaries**: Enforced via ESLint and dependency-cruiser
- **No code duplication**: jscpd detects copy-pasted code
- **Security**: Semgrep scans for OWASP Top 10, Node.js, TypeScript, and secrets

## GitHub Security Settings

> **Note**: To enable the full security scanning pipeline (Semgrep), you may need to enable **Advanced Security** in your GitHub repository settings.
>
> **Settings** → **Security** → **Code security and analysis** → **GitHub Advanced Security**
>
> This enables:
>
> - Secret scanning
> - Dependency review
> - Code scanning with Semgrep

## CI/CD

Pull requests automatically run:

1. Lint, typecheck, format checks
2. Vitest with coverage (strict mode)
3. Architecture validation (dependency-cruiser)
4. Unused code detection (knip)
5. Duplicate code detection (jscpd)
6. Security scanning (Semgrep)

All checks must pass before merging.

## AI Agent Guidelines

See [AGENTS.md](./AGENTS.md) for coding rules and conventions when using AI assistants.

## License

MIT
