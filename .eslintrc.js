'use strict';
const eslintConfig = {
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  env: {
    es6: true,
    node: true,
  },
  rules: {
    'no-console': 0,
  },
  overrides: [
    {
      files: ['**/*.ts'],
      extends: [
        'eslint:recommended',
        'plugin:import/errors',
        'plugin:import/warnings',
        'plugin:promise/recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:import/typescript',
        'prettier',
      ],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        sourceType: 'module',
      },
    },
  ],
};

module.exports = eslintConfig;
