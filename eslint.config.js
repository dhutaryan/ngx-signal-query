const eslint = require('@eslint/js')
const stylistic = require('@stylistic/eslint-plugin')
const angular = require('angular-eslint')
const typescript = require('typescript-eslint')

module.exports = typescript.config(
  {
    ignores: ['dist/**', 'out-tsc/**', 'coverage/**', '.angular/**'],
  },
  {
    files: ['**/*.ts'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    extends: [
      eslint.configs.recommended,
      ...typescript.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // --- requested ---
      'prefer-const': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',

      '@stylistic/semi': ['error', 'never'],
      '@stylistic/function-call-spacing': 'error',
      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: true },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        {
          blankLine: 'always',
          prev: '*',
          next: ['function', 'block', 'block-like', 'return', 'break'],
        },
        { blankLine: 'always', prev: '*', next: ['const', 'let'] },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'any', prev: 'directive', next: 'directive' },
        { blankLine: 'always', prev: ['case', 'default'], next: '*' },
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        {
          blankLine: 'never',
          prev: 'function-overload',
          next: ['function-overload', 'function'],
        },
      ],

      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: [
            // Index signature
            'signature',
            'call-signature',

            // Fields
            'public-field',
            'private-field',
            '#private-field',

            // Static initialization
            'static-initialization',

            // Constructors
            'constructor',

            // Methods
            'public-method',
            'protected-method',
            'private-method',
            '#private-method',
          ],
        },
      ],

      // Add `readonly` to private members that are never reassigned (type-aware).
      '@typescript-eslint/prefer-readonly': 'error',

      // Enforce native #private members over the `private` modifier.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(PropertyDefinition, MethodDefinition, TSParameterProperty)[accessibility="private"]',
          message: 'Use a native #private member instead of the "private" modifier.',
        },
      ],

      // --- suggested extras (safe to drop) ---
      'no-console': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Bootstrap entry point: console.error in the bootstrap catch is expected.
    files: ['**/main.ts'],
    rules: { 'no-console': 'off' },
  },
)
