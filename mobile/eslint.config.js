// mobile/eslint.config.js — flat config from Expo's own ruleset (matches the installed SDK 54 toolchain).
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  { ignores: ['node_modules/', 'android/', 'ios/', '.expo/', 'dist/', 'scripts/'] },
  {
    // Known M15 debt, kept visible as warnings instead of blocking CI (see docs/M16_CHANGES.md "Lint baseline").
    // rules-of-hooks is an ERROR again: the four conditional-hook bugs were fixed in M16.
    rules: {
      'react/display-name': 'warn',
      'react/no-unescaped-entities': 'warn',
      'import/namespace': 'off',
      'import/no-unresolved': ['error', { ignore: ['^@react-native-firebase/'] }],
    },
  },
  {
    files: ['**/__tests__/**', '**/*.test.js', 'jest.setup.js'],
    languageOptions: { globals: { jest: 'readonly', describe: 'readonly', test: 'readonly', it: 'readonly', expect: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly', __dirname: 'readonly' } },
  },
];
