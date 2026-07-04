/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'This dependency is part of a circular relationship. Use dependency inversion or split responsibilities to break the cycle.',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'This module depends on a module that cannot be resolved. Add it to package.json or fix the import path.',
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment:
        "This module depends on an npm package that isn't in package.json dependencies. Add it to dependencies before using it.",
      from: {},
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
      },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'This source module depends on a package from devDependencies. If this ships to production, move it to dependencies. If it is truly dev-only, add a path exception.',
      from: {
        path: '^src',
      },
      to: {
        dependencyTypes: ['npm-dev'],
        // type-only imports do not reach runtime output
        dependencyTypesNot: ['type-only'],
        pathNot: ['node_modules/@types/'],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    exclude: String.raw`^\.worktrees/`,
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['main', 'types', 'typings'],
    },
    skipAnalysisNotInRules: true,
  },
}
