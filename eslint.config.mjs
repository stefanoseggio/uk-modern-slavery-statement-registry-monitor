import prettierConfig from 'eslint-config-prettier';

import apifyConfig from '@apify/eslint-config/ts.js';

export default [
    { ignores: ['dist', 'node_modules', 'storage', 'examples'] },
    ...apifyConfig,
    prettierConfig,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            'no-console': 'error',
            // `csv-parse/sync` is a real, documented package subpath export (confirmed in its own
            // package.json `exports` map) with no `.js`-suffixed path - appending one would break
            // resolution entirely, so the base config's blanket extension requirement is
            // incorrect for bare package specifiers, not just stylistically off.
            'import-x/extensions': ['error', 'ignorePackages'],
        },
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            // Test files legitimately construct large literal fixtures and use non-null
            // assertions when asserting on values the test itself just set up.
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        // Flat-config files are required by ESLint itself to use a default
        // export - the base config's import-x/no-default-export rule is
        // correct in general but cannot apply to this one file.
        files: ['eslint.config.mjs'],
        rules: {
            'import-x/no-default-export': 'off',
        },
    },
];
