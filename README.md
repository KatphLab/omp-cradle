# omp-cradle

A TypeScript workspace for building Oh My Pi extensions with local static-analysis tooling only.

## Features

- **[TypeScript](https://www.typescriptlang.org)** with strict configuration for Node.js
- **[tsx](https://github.com/privatenumber/tsx)** for fast TypeScript execution in development
- **Code Quality**: ESLint, Prettier, Husky, lint-staged
- **Architecture Enforcement**: ESLint boundaries, dependency-cruiser, knip
- **Security**: ESLint security rules and duplicate code detection

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

| Script              | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`          | Run in development with tsx watch                                             |
| `pnpm build`        | Compile TypeScript to dist/                                                   |
| `pnpm start`        | Run compiled output                                                           |
| `pnpm lint`         | Run ESLint                                                                    |
| `pnpm lint:fix`     | Fix ESLint issues                                                             |
| `pnpm typecheck`    | Run TypeScript compiler (no emit)                                             |
| `pnpm format`       | Format code with Prettier                                                     |
| `pnpm format:check` | Check formatting                                                              |
| `pnpm check`        | **Full quality gate**: format, lint, typecheck, depcruise, knip, and dupcheck |
| `pnpm fix`          | Auto-fix issues: format, lint, knip                                           |
| `pnpm depcruise`    | Check architecture boundaries                                                 |
| `pnpm knip`         | Find unused dependencies/exports                                              |
| `pnpm dupcheck`     | Check for code duplication                                                    |

## Quality Gates

This repository enforces local static checks:

- **Type safety**: TypeScript runs with strict compiler settings
- **Architecture boundaries**: Enforced via ESLint and dependency-cruiser
- **No code duplication**: jscpd detects copy-pasted code

Run `pnpm check` locally before sharing changes.

## AI Agent Guidelines

See [AGENTS.md](./AGENTS.md) for coding rules and conventions when using AI assistants.

## License

MIT
