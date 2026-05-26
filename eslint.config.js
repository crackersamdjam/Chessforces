import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
	{
		ignores: [ 'node_modules/**', 'dist/**' ],
	},
	js.configs.recommended,
	{
		files: [ 'lib/**/*.ts', 'server.ts' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' } ],
		},
	},
	{
		files: [ 'public/**/*.ts' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.browser,
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' } ],
		},
	},
	{
		files: [ 'test/**/*.ts' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: globals.node,
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' } ],
		},
	},
	{
		files: [ 'test/smoke/**/*.ts' ],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' } ],
		},
	},
];

