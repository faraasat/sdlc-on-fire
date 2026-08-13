// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are allowed only when explicitly marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `import type` must be explicit — verbatimModuleSyntax depends on it.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Config files and plain-ESM tooling are not part of a package tsconfig.
    // `scripts/**/*.ts` is deliberately absent from this list — it has its own
    // project (scripts/tsconfig.json) so it stays typechecked.
    files: ['*.mjs', 'scripts/**/*.mjs', '*.config.ts', 'packages/*/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
