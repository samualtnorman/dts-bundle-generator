import * as ts from 'typescript';

import { hasNodeModifier } from './helpers/typescript';
import { packageVersion } from './helpers/package-version';

export interface ModuleImportsSet {
	defaultImports: Set<string>;
	starImports: Set<string>;
	namedImports: Set<string>;
	requireImports: Set<string>;
}

export interface OutputParams extends OutputHelpers {
	typesReferences: Set<string>;
	imports: Map<string, ModuleImportsSet>;
	statements: readonly ts.Statement[];
	renamedExports: string[];
}

export interface OutputHelpers {
	shouldStatementHasExportKeyword(statement: ts.Statement): boolean;
	needStripDefaultKeywordForStatement(statement: ts.Statement): boolean;
	needStripConstFromConstEnum(constEnum: ts.EnumDeclaration): boolean;
	needStripImportFromImportTypeNode(importType: ts.ImportTypeNode): boolean;
}

export interface OutputOptions {
	umdModuleName?: string;
	sortStatements?: boolean;
	noBanner?: boolean;
}

export function generateOutput(params: OutputParams, options: OutputOptions = {}): string {
	let resultOutput = '';

	if (!options.noBanner) {
		resultOutput += `// Generated by dts-bundle-generator v${packageVersion()}\n\n`;
	}

	if (params.typesReferences.size !== 0) {
		const header = generateReferenceTypesDirective(Array.from(params.typesReferences));
		resultOutput += `${header}\n\n`;
	}

	if (params.imports.size !== 0) {
		// we need to have sorted imports of libraries to have more "stable" output
		const sortedEntries = Array.from(params.imports.entries()).sort((firstEntry: [string, ModuleImportsSet], secondEntry: [string, ModuleImportsSet]) => {
			return firstEntry[0].localeCompare(secondEntry[0]);
		});

		const importsArray: string[] = [];
		for (const [libraryName, libraryImports] of sortedEntries) {
			importsArray.push(...generateImports(libraryName, libraryImports));
		}

		if (importsArray.length !== 0) {
			resultOutput += `${importsArray.join('\n')}\n\n`;
		}
	}

	const statements = params.statements.map((statement: ts.Statement) => getStatementText(statement, params));

	if (options.sortStatements) {
		statements.sort(compareStatementText);
	}

	resultOutput += statementsTextToString(statements, params);

	if (params.renamedExports.length !== 0) {
		resultOutput += `\n\nexport {\n\t${params.renamedExports.sort().join(',\n\t')},\n};`;
	}

	if (options.umdModuleName !== undefined) {
		resultOutput += `\n\nexport as namespace ${options.umdModuleName};`;
	}

	// this is used to prevent importing non-exported nodes
	// see https://stackoverflow.com/questions/52583603/intentional-that-export-shuts-off-automatic-export-of-all-symbols-from-a-ty
	resultOutput += `\n\nexport {};\n`;

	return resultOutput;
}

interface StatementText {
	leadingComment?: string;
	text: string;
}

function statementTextToString(s: StatementText): string {
	if (s.leadingComment === undefined) {
		return s.text;
	}

	return `${s.leadingComment}\n${s.text}`;
}

function statementsTextToString(statements: StatementText[], helpers: OutputHelpers): string {
	const statementsText = statements.map(statementTextToString).join('\n');
	return spacesToTabs(prettifyStatementsText(statementsText, helpers));
}

function prettifyStatementsText(statementsText: string, helpers: OutputHelpers): string {
	const sourceFile = ts.createSourceFile('output.d.ts', statementsText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const printer = ts.createPrinter(
		{
			newLine: ts.NewLineKind.LineFeed,
			removeComments: false,
		},
		{
			substituteNode: (hint: ts.EmitHint, node: ts.Node) => {
				// `import('module').Qualifier` or `typeof import('module').Qualifier`
				if (ts.isImportTypeNode(node) && node.qualifier !== undefined && helpers.needStripImportFromImportTypeNode(node)) {
					if (node.isTypeOf) {
						// I personally don't like this solution because it spreads the logic of modifying nodes in the code
						// I'd prefer to have it somewhere near getStatementText or so
						// but at the moment it seems that it's the fastest and most easiest way to remove `import('./module').` form the code
						// if you read this and know how to make it better - feel free to share your ideas/PR with fixes
						// tslint:disable-next-line:deprecation
						return ts.createTypeQueryNode(node.qualifier);
					}

					return ts.createTypeReferenceNode(node.qualifier, node.typeArguments);
				}

				return node;
			},
		}
	);

	return printer.printFile(sourceFile).trim();
}

function compareStatementText(a: StatementText, b: StatementText): number {
	if (a.text > b.text) {
		return 1;
	} else if (a.text < b.text) {
		return -1;
	}

	return 0;
}

function needAddDeclareKeyword(statement: ts.Statement, nodeText: string): boolean {
	// for some reason TypeScript allows to do not write `declare` keyword for ClassDeclaration, FunctionDeclaration and VariableDeclaration
	// if it already has `export` keyword - so we need to add it
	// to avoid TS1046: Top-level declarations in .d.ts files must start with either a 'declare' or 'export' modifier.
	if (ts.isClassDeclaration(statement) && (/^class\b/.test(nodeText) || /^abstract\b/.test(nodeText))) {
		return true;
	}

	if (ts.isFunctionDeclaration(statement) && /^function\b/.test(nodeText)) {
		return true;
	}

	if (ts.isVariableStatement(statement) && /^(const|let|var)\b/.test(nodeText)) {
		return true;
	}

	return false;
}

function getStatementText(statement: ts.Statement, helpers: OutputHelpers): StatementText {
	const shouldStatementHasExportKeyword = helpers.shouldStatementHasExportKeyword(statement);
	const needStripDefaultKeyword = helpers.needStripDefaultKeywordForStatement(statement);
	const hasStatementExportKeyword = ts.isExportAssignment(statement) || hasNodeModifier(statement, ts.SyntaxKind.ExportKeyword);

	let nodeText = getTextAccordingExport(statement.getText(), hasStatementExportKeyword, shouldStatementHasExportKeyword);

	if (
		ts.isEnumDeclaration(statement)
		&& hasNodeModifier(statement, ts.SyntaxKind.ConstKeyword)
		&& helpers.needStripConstFromConstEnum(statement)) {
		nodeText = nodeText.replace(/\bconst\s/, '');
	}

	// strip the `default` keyword from node
	if (hasNodeModifier(statement, ts.SyntaxKind.DefaultKeyword) && needStripDefaultKeyword) {
		// we need just to remove `default` from any node except class node
		// for classes we need to replace `default` with `declare` instead
		nodeText = nodeText.replace(/\bdefault\s/, ts.isClassDeclaration(statement) ? 'declare ' : '');
	}

	if (needAddDeclareKeyword(statement, nodeText)) {
		nodeText = `declare ${nodeText}`;
	}

	const result: StatementText = {
		text: nodeText,
	};

	// add jsdoc for exported nodes only
	if (shouldStatementHasExportKeyword) {
		const start = statement.getStart();
		const jsDocStart = statement.getStart(undefined, true);
		const nodeJSDoc = statement.getSourceFile().getFullText().substring(jsDocStart, start).trim();
		if (nodeJSDoc.length !== 0) {
			result.leadingComment = nodeJSDoc;
		}
	}

	return result;
}

function generateImports(libraryName: string, imports: ModuleImportsSet): string[] {
	const fromEnding = `from '${libraryName}';`;

	const result: string[] = [];

	// sort to make output more "stable"
	Array.from(imports.starImports).sort().forEach((importName: string) => result.push(`import * as ${importName} ${fromEnding}`));
	Array.from(imports.requireImports).sort().forEach((importName: string) => result.push(`import ${importName} = require('${libraryName}');`));
	Array.from(imports.defaultImports).sort().forEach((importName: string) => result.push(`import ${importName} ${fromEnding}`));

	if (imports.namedImports.size !== 0) {
		result.push(`import { ${Array.from(imports.namedImports).sort().join(', ')} } ${fromEnding}`);
	}

	return result;
}

function generateReferenceTypesDirective(libraries: string[]): string {
	return libraries.sort().map((library: string) => {
		return `/// <reference types="${library}" />`;
	}).join('\n');
}

function getTextAccordingExport(nodeText: string, isNodeExported: boolean, shouldNodeBeExported: boolean): string {
	if (shouldNodeBeExported && !isNodeExported) {
		return 'export ' + nodeText;
	} else if (isNodeExported && !shouldNodeBeExported) {
		return nodeText.slice('export '.length);
	}

	return nodeText;
}

function spacesToTabs(text: string): string {
	// eslint-disable-next-line no-regex-spaces
	return text.replace(/^(    )+/gm, (substring: string) => {
		return '\t'.repeat(substring.length / 4);
	});
}
