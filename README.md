# omp-cradle

A TypeScript workspace for building Oh My Pi extensions with local static-analysis tooling only.

## Features

- **Bun 1.3.14** for dependency management and repository scripts
- **TypeScript native preview** with strict configuration
- **Code quality**: ESLint, Prettier, Husky, and lint-staged
- **Architecture enforcement**: dependency-cruiser, Knip, and jscpd
- **Security**: ESLint security rules and duplicate code detection

## Getting Started

### Prerequisites

- Bun 1.3.14 or newer
- Node.js >=24.0.0 <25

### Installation

```bash
bun install
cd server && bun install
```

### Development

The root OMP configuration registers the repository extensions, including the loopback-only HTTP server at `./server/src/index.ts`. Start OMP from this repository to load them.

The server is an independent Bun package. Its API, security boundary, configuration, and examples are documented in [`server/README.md`](./server/README.md).

```bash
cd server
bun dev
```

## Scripts

| Script          | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `bun lint`      | Run ESLint                                                                   |
| `bun lint:fix`  | Fix ESLint findings                                                          |
| `bun typecheck` | Run the TypeScript compiler without emitting                                 |
| `bun format`    | Format with Prettier                                                         |
| `bun check`     | Full gate: format, lint, typecheck, depcruise, Knip, and duplicate detection |
| `bun fix`       | Auto-fix formatting, lint, and Knip findings                                 |
| `bun depcruise` | Check architecture boundaries                                                |
| `bun knip`      | Find unused dependencies and exports                                         |
| `bun dupcheck`  | Check for code duplication                                                   |

Run server-package commands from `server/`; `bun run check` there formats, lints, typechecks, and builds the extension.

## Quality Gates

This repository enforces local static checks:

- **Type safety**: TypeScript runs with strict compiler settings
- **Architecture boundaries**: Enforced via ESLint and dependency-cruiser
- **No code duplication**: jscpd detects copy-pasted code

Run `bun check` locally before sharing changes.

## AI Agent Guidelines

See [AGENTS.md](./AGENTS.md) for coding rules and conventions when using AI assistants.

## License

MIT
