import vitest from '@vitest/eslint-plugin';
import perfectionist from 'eslint-plugin-perfectionist';
import prettier from 'eslint-plugin-prettier';
import pluginPromise from 'eslint-plugin-promise';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.lock',
      '.husky/**',
      'coverage/**',
      '.nyc_output/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  pluginPromise.configs['flat/recommended'],
  perfectionist.configs['recommended-natural'],
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: process.cwd(),
      },
      sourceType: 'module',
    },
    plugins: {
      prettier,
    },
    rules: {
      ...prettier.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: {
        ...vitest.environments.env.globals,
      },
    },
    plugins: {
      vitest,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
    settings: {
      vitest: {
        typecheck: false,
      },
    },
  },
];
