import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '.agents',
      '.pnpm-store',
      '.vite',
      'coverage',
      'data',
      'dist',
      'node_modules',
      '_bmad',
      '_bmad-output',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    plugins: { 'react-hooks': hooks },
    rules: { ...hooks.configs.recommended.rules, '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    ...refresh.configs.vite,
  },
);
