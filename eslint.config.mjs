import regexpPlugin from 'eslint-plugin-regexp'
import pluginSecurity from 'eslint-plugin-security'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import unusedImports from 'eslint-plugin-unused-imports'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

const eslintConfig = defineConfig([
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  regexpPlugin.configs.recommended,
  pluginSecurity.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Prefer TS-aware variants
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: true,
          ignoreTypeReferences: true,
        },
      ],

      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',

      // Tighten common escape hatches
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/require-array-sort-compare': [
        'error',
        { ignoreStringArrays: true },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowNumber: true,
          allowBoolean: false,
          allowAny: false,
          allowNullish: false,
          allowRegExp: false,
        },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      // Script project rules
      'unused-imports/no-unused-imports': 'error',
      'sonarjs/cognitive-complexity': ['error', 12],
      'sonarjs/aws-restricted-ip-admin-access': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',
      complexity: ['error', 10],
      'max-lines-per-function': [
        'error',
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      'security/detect-object-injection': 'off',
      'max-params': 'off',
      '@typescript-eslint/max-params': ['error', { max: 7 }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportNamedDeclaration[source]',
          message: 'Do not create pass-through re-export files.',
        },
        {
          selector: 'ExportAllDeclaration',
          message: 'Do not use export * barrel files.',
        },
        {
          selector:
            "TSTypeReference[typeName.name='ReturnType'] > TSTypeParameterInstantiation > TSTypeQuery > Identifier",
          message:
            'Do not use ReturnType<typeof fn> for local codebase functions. Define and export an explicit type instead.',
        },
      ],
      'unicorn/prevent-abbreviations': [
        'error',
        {
          allowList: {
            // TypeScript / runtime conventions
            env: true,
            Env: true,
            args: true,
            Args: true,
            err: true,
            fn: true,
            Fn: true,
            temp: true,

            ctx: true,
            params: true,
            Def: true,
            msg: true,
            opts: true,
          },

          ignore: [],

          checkProperties: false,
          checkShorthandProperties: false,
          checkDefaultAndNamespaceImports: 'internal',
          checkShorthandImports: 'internal',
        },
      ],
    },
  },
  globalIgnores([
    '.dependency-cruiser.js',
    '*.config.mjs',
    'eslint.config.mjs',
    'dist/**',
    '.opencode/**',
    '.worktrees/**',
  ]),
])

export default eslintConfig
