import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'api/**', '.venv/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Per-chart code addresses its own session's stores; the facades below
    // always follow the active chart (apps/web/src/chart/facade.ts).
    files: [
      'apps/web/src/**/attach.ts',
      'apps/web/src/**/controller.ts',
      'apps/web/src/chart/**/*.{ts,tsx}',
    ],
    // Tests exercise the facades on purpose.
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**'],
              importNames: [
                'useChartView',
                'useIndicatorStore',
                'useIndicatorPreview',
                'useIndicatorRuntime',
                'useEffectiveInstances',
                'effectiveInstances',
                'useCompareStore',
                'useCompareRuntime',
                'currentCompareLayout',
                'useHistory',
                'useDrawingRuntime',
              ],
              message:
                'Active-chart facade: use the explicit session stores (ChartSession) instead.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
