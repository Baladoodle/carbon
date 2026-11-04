// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Bare Node built-ins (matched exactly; `node:*` is matched as a pattern). */
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'crypto',
  'url',
  'util',
  'events',
  'stream',
  'worker_threads',
  'module',
  'process',
];
const NODE_MODULES = ['node:*'];

/**
 * Layer boundaries (docs/SYSTEM.md §1):
 *  - src/core      pure TypeScript: no Node, no Electron, no React, no I/O, no clock, no randomness
 *  - src/shared    IPC contracts: may use core and zod only
 *  - src/main      may use anything except the renderer
 *  - src/preload   electron + shared only
 *  - src/renderer  may use core, shared and React; never Node, Electron or main
 */
const layer = (/** @type {string[]} */ patterns, /** @type {string} */ message, noNode = true) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: noNode ? NODE_BUILTINS.map((name) => ({ name, message })) : [],
      patterns: [{ group: patterns, message }],
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'design/**',
      'fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // Commands build modified copies and delete keys from those copies.
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      ...layer(
        [
          ...NODE_MODULES,
          'electron',
          'electron/*',
          'react',
          'react-dom',
          'react/*',
          'react-dom/*',
          '@main/*',
          '@renderer/*',
          '@shared/*',
          '**/main/**',
          '**/renderer/**',
          '**/shared/**',
          '@anthropic-ai/*',
        ],
        'src/core is pure: no Node, Electron, React, SDK or outer layers (docs/SYSTEM.md §1).',
      ),
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'src/core has no environment access.' },
        { name: 'window', message: 'src/core has no DOM.' },
        { name: 'document', message: 'src/core has no DOM.' },
        { name: 'fetch', message: 'src/core does no I/O.' },
        { name: 'require', message: 'src/core uses ES imports.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'src/core is deterministic: pass a seed.' },
        {
          object: 'Date',
          property: 'now',
          message: 'src/core is deterministic: pass the time in.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'src/core is deterministic: pass the time in.',
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: layer(
      [
        ...NODE_MODULES,
        'electron',
        'react',
        'react-dom',
        '@main/*',
        '@renderer/*',
        '**/main/**',
        '**/renderer/**',
      ],
      'src/shared holds IPC contracts only: core and zod.',
    ),
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...layer(
        [...NODE_MODULES, 'electron', '@main/*', '**/main/**', '@anthropic-ai/*'],
        'The renderer talks to the main process only through window.carbon (src/shared/ipc.ts).',
      ),
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: layer(
      ['@main/*', '@renderer/*', '**/main/**', '**/renderer/**', 'react'],
      'The preload only bridges IPC.',
      false,
    ),
  },
  {
    files: ['src/main/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: layer(
      ['@renderer/*', '**/renderer/**', 'react', 'react-dom'],
      'Main never imports the renderer.',
      false,
    ),
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      // Tests may read fixtures and files from disk in any layer.
      'no-restricted-imports': 'off',
    },
  },
);
