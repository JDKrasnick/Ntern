import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'browser-companion/dist/**',
      'cloudflare/dist/**',
      'cdk.out/**',
      'coverage/**',
      'node_modules/**',
      '.wrangler/**',
      'mobile/**',
      '.context/**',
      '**/.agents/**',
      '**/.codex/**',
      '**/.github/hooks/**',
      '**/.github/skills/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['browser-companion/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        CSS: 'readonly',
        Event: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        MutationObserver: 'readonly',
        URL: 'readonly',
        chrome: 'readonly',
        document: 'readonly',
        location: 'readonly',
        sessionStorage: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        Response: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        WebAssembly: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['cloudflare/**/*.ts'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
    }
  }
);
