import js from '@eslint/js';
import globals from 'globals';

export default [
	{
		ignores: [ 'node_modules/**' ],
	},
	js.configs.recommended,
	{
		files: [ 'lib/**/*.js', 'lib/**/*.mjs', 'lib/**/*.cjs', 'server.js' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
	},
	{
		files: [ 'public/**/*.js' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.browser,
		},
	},
	{
		files: [ 'test/**/*.js', 'test/**/*.mjs', 'test/**/*.cjs' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
	},
	{
		files: [ 'test/smoke/**/*.mjs' ],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
	},
];

