import type * as BabelParser from "@babel/parser";

type BabelImportDeclaration = {
	type: "ImportDeclaration";
	start: number;
	end: number;
	source: { value: string };
	specifiers: ReadonlyArray<{
		type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
		local: { name: string };
		imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
	}>;
	attributes?: ReadonlyArray<{
		key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
		value: { value: string };
	}>;
};

type BabelBindingPattern = {
	type: string;
	name?: string;
	properties?: ReadonlyArray<unknown>;
	elements?: ReadonlyArray<unknown | null>;
	argument?: unknown;
	left?: unknown;
	value?: unknown;
};

type BabelVariableDeclaration = {
	type: "VariableDeclaration";
	kind: "const" | "let" | "var";
	start: number;
	end: number;
	declarations?: ReadonlyArray<{ id: BabelBindingPattern }>;
};

type BabelClassDeclaration = {
	type: "ClassDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelLexicalDecl = BabelVariableDeclaration | BabelClassDeclaration;
type BabelFunctionDeclaration = {
	type: "FunctionDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelPublishableDecl = BabelLexicalDecl | BabelFunctionDeclaration;

type BabelExpressionStatement = {
	type: "ExpressionStatement";
	start: number;
	end: number;
	expression?: { type?: string };
};

type BabelProgramNode = BabelImportDeclaration | BabelLexicalDecl | BabelExpressionStatement | { type: string };
type BabelModuleSourceDeclaration = {
	type: "ImportDeclaration" | "ExportNamedDeclaration" | "ExportAllDeclaration";
	source?: { value: string; start: number; end: number } | null;
};

type BabelNode = { type: string; start: number; end: number; [key: string]: unknown };

let babelParser: typeof BabelParser | undefined;

async function loadBabelParser(): Promise<typeof BabelParser> {
	if (!babelParser) {
		babelParser = await import("@babel/parser");
	}
	return babelParser;
}

async function parseProgram(code: string): Promise<{ program: { body: ReadonlyArray<BabelProgramNode> } } | null> {
	const { parse } = await loadBabelParser();
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins: ["typescript"],
		}) as unknown as { program: { body: ReadonlyArray<BabelProgramNode> } };
	} catch {
		return null;
	}
}

const DYNAMIC_IMPORT_CALLEE = '(typeof __veyyon_import__ === "function" ? __veyyon_import__ : (s, o) => import(s, o))';

function buildVeyyonImportCall(sourceLiteral: string, optionsLiteral: string | undefined): string {
	return optionsLiteral
		? `__veyyon_import__(${sourceLiteral}, ${optionsLiteral})`
		: `__veyyon_import__(${sourceLiteral})`;
}

function walkNodes(root: unknown, visit: (node: BabelNode) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
			continue;
		}
		const node = current as Record<string, unknown>;
		if (typeof node.type === "string") visit(node as unknown as BabelNode);
		for (const key in node) {
			if (key === "loc" || key === "extra" || key === "range") continue;
			if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
			const value = node[key];
			if (value && typeof value === "object") stack.push(value);
		}
	}
}

function buildOptionsLiteral(node: BabelImportDeclaration): string | undefined {
	const attrs = node.attributes;
	if (!attrs || attrs.length === 0) return undefined;
	const pairs = attrs.map(attr => {
		const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
		return `${key}: ${JSON.stringify(attr.value.value)}`;
	});
	return `{ with: { ${pairs.join(", ")} } }`;
}

function rewriteImportNode(node: BabelImportDeclaration): string {
	const sourceLiteral = JSON.stringify(node.source.value);
	const optionsLiteral = buildOptionsLiteral(node);
	const importCall = buildVeyyonImportCall(sourceLiteral, optionsLiteral);

	let defaultName: string | undefined;
	let namespaceName: string | undefined;
	const namedPairs: Array<[imported: string, local: string, fromString: boolean]> = [];
	for (const spec of node.specifiers) {
		if (spec.type === "ImportDefaultSpecifier") {
			defaultName = spec.local.name;
		} else if (spec.type === "ImportNamespaceSpecifier") {
			namespaceName = spec.local.name;
		} else if (spec.type === "ImportSpecifier" && spec.imported) {
			const fromString = spec.imported.type === "StringLiteral";
			const imported = spec.imported.type === "StringLiteral" ? spec.imported.value : spec.imported.name;
			namedPairs.push([imported, spec.local.name, fromString]);
		}
	}

	if (namedPairs.length > 0) {
		const inner = namedPairs
			.map(([imp, loc, fromString]) => (imp === loc ? imp : `${fromString ? JSON.stringify(imp) : imp}: ${loc}`))
			.join(", ");
		const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
		return `const { ${props} } = await ${importCall};`;
	}
	if (namespaceName && defaultName) {
		return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
	}
	if (namespaceName) return `const ${namespaceName} = await ${importCall};`;
	if (defaultName) return `const ${defaultName} = (await ${importCall}).default;`;
	return `await ${importCall};`;
}

export async function rewriteImports(code: string): Promise<string> {
	if (!code.includes("import")) return code;

	const ast = await parseProgram(code);
	if (!ast) {
		return code;
	}

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	for (const node of ast.program.body) {
		if (node.type !== "ImportDeclaration") continue;
		const decl = node as unknown as BabelImportDeclaration;
		edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
	}

	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callee = call.callee;
		if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
		edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
	});

	if (edits.length === 0) return code;

	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}
export async function collectModuleSourceSpecifiers(code: string): Promise<string[]> {
	const ast = await parseProgram(code);
	if (!ast) return [];
	const sources: string[] = [];
	for (const node of ast.program.body) {
		if (
			(node.type === "ImportDeclaration" ||
				node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration") &&
			typeof (node as BabelModuleSourceDeclaration).source?.value === "string"
		) {
			sources.push((node as BabelModuleSourceDeclaration).source!.value);
		}
	}
	return sources;
}

export async function rewriteModuleSourceSpecifiers(
	code: string,
	replacer: (source: string) => string,
): Promise<string> {
	const ast = await parseProgram(code);
	if (!ast) return code;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	for (const node of ast.program.body) {
		if (
			node.type !== "ImportDeclaration" &&
			node.type !== "ExportNamedDeclaration" &&
			node.type !== "ExportAllDeclaration"
		) {
			continue;
		}
		const source = (node as BabelModuleSourceDeclaration).source;
		if (!source || typeof source.value !== "string") continue;
		const next = replacer(source.value);
		if (next === source.value) continue;
		edits.push({ start: source.start, end: source.end, text: JSON.stringify(next) });
	}

	if (edits.length === 0) return code;
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

export async function rewriteDynamicImports(code: string, callee = "__veyyon_import__"): Promise<string> {
	if (!code.includes("import")) return code;
	const ast = await parseProgram(code);
	if (!ast) return code;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callCallee = call.callee;
		if (callCallee?.type !== "Import" || typeof callCallee.start !== "number" || typeof callCallee.end !== "number") {
			return;
		}
		edits.push({ start: callCallee.start, end: callCallee.end, text: callee });
	});

	if (edits.length === 0) return code;
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
	if (!pattern || typeof pattern !== "object") return;
	const node = pattern as BabelBindingPattern & { parameter?: unknown };
	switch (node.type) {
		case "Identifier":
			if (typeof node.name === "string") names.push(node.name);
			return;
		case "ObjectPattern":
			for (const property of node.properties ?? []) collectBindingNames(property, names);
			return;
		case "ObjectProperty":
		case "Property":
			collectBindingNames(node.value, names);
			return;
		case "ArrayPattern":
			for (const element of node.elements ?? []) collectBindingNames(element, names);
			return;
		case "AssignmentPattern":
			collectBindingNames(node.left, names);
			return;
		case "RestElement":
			collectBindingNames(node.argument, names);
			return;
		case "TSParameterProperty":
			collectBindingNames(node.parameter, names);
			return;
		default:
			return;
	}
}

function getLexicalBindingNames(node: BabelPublishableDecl): string[] {
	const names: string[] = [];
	if (node.type === "VariableDeclaration") {
		for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
	} else if (node.id) {
		names.push(node.id.name);
	}
	return names;
}

function appendGlobalBindingPublish(source: string, names: readonly string[]): string {
	if (names.length === 0) return source;
	const assignments = names.map(name => `this[${JSON.stringify(name)}] = ${name};`).join("\n");
	return `${source};\n${assignments}`;
}

async function demoteTopLevelLexicals(code: string, options: { publishGlobals?: boolean } = {}): Promise<string> {
	const publishGlobals = options.publishGlobals === true;
	const fastPath = publishGlobals ? /\b(?:const|let|class|var|function)\b/ : /\b(?:const|let|class)\b/;
	if (!fastPath.test(code)) return code;

	const ast = await parseProgram(code);
	if (!ast) {
		return code;
	}

	const targets: Array<{ node: BabelPublishableDecl; demote: boolean }> = [];
	for (const node of ast.program.body) {
		if (node.type === "VariableDeclaration") {
			const decl = node as unknown as BabelVariableDeclaration;
			if (decl.kind === "const" || decl.kind === "let") targets.push({ node: decl, demote: true });
			else if (publishGlobals) targets.push({ node: decl, demote: false });
		} else if (node.type === "ClassDeclaration") {
			const decl = node as unknown as BabelClassDeclaration;
			if (decl.id) targets.push({ node: decl, demote: true });
		} else if (publishGlobals && node.type === "FunctionDeclaration") {
			const decl = node as unknown as BabelFunctionDeclaration;
			if (decl.id) targets.push({ node: decl, demote: false });
		}
	}
	if (targets.length === 0) return code;

	targets.sort((a, b) => b.node.start - a.node.start);
	let result = code;
	for (const { node, demote } of targets) {
		const segment = result.slice(node.start, node.end);
		const bindingNames = publishGlobals ? getLexicalBindingNames(node) : [];
		let replacement: string;
		if (!demote) {
			replacement = segment;
		} else if (node.type === "VariableDeclaration") {
			replacement = `var${segment.slice(node.kind.length)}`;
		} else {
			const id = node.id;
			if (!id) continue;
			const idEndInSegment = id.end - node.start;
			const tail = segment.slice(idEndInSegment);
			const hasTrailingSemi = segment.endsWith(";");
			replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
		}
		result =
			result.slice(0, node.start) + appendGlobalBindingPublish(replacement, bindingNames) + result.slice(node.end);
	}
	return result;
}

async function returnFinalExpression(code: string): Promise<{ source: string; returned: boolean }> {
	const ast = await parseProgram(code);
	const body = ast?.program.body;
	if (!body) return { source: code, returned: false };
	let lastIndex = body.length - 1;
	while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
	const last = lastIndex >= 0 ? body[lastIndex] : undefined;
	if (last?.type === "ExpressionStatement") {
		const expression = last as BabelExpressionStatement;
		const prefix = code.slice(0, expression.start);
		const statement = code.slice(expression.start, expression.end);
		const suffix = code.slice(expression.end);
		const semicolonMatch = statement.match(/;\s*$/);
		const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
		return { source: `${prefix}__veyyon_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
	}
	if (last?.type === "ReturnStatement") {
		const ret = last as unknown as { start: number; end: number; argument?: { start: number; end: number } | null };
		if (!ret.argument) return { source: code, returned: false };
		const prefix = code.slice(0, ret.start);
		const suffix = code.slice(ret.end);
		const expr = code.slice(ret.argument.start, ret.argument.end);
		return { source: `${prefix}__veyyon_set_final_expr__((${expr}));${suffix}`, returned: true };
	}
	return { source: code, returned: false };
}

function isExecutionBoundary(type: string): boolean {
	return (
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "ObjectMethod" ||
		type === "ClassMethod" ||
		type === "ClassPrivateMethod" ||
		type === "PrivateMethod"
	);
}

function containsAsyncWrapperSyntax(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsAsyncWrapperSyntax(item)) return true;
		}
		return false;
	}

	const node = value as Record<string, unknown>;
	const type = node.type;
	if (type === "ReturnStatement" || type === "AwaitExpression") return true;
	if (type === "ForOfStatement" && node.await === true) return true;
	if (typeof type === "string" && isExecutionBoundary(type)) return false;

	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		if (containsAsyncWrapperSyntax(node[key])) return true;
	}
	return false;
}

async function requiresAsyncWrapper(code: string): Promise<boolean> {
	const ast = await parseProgram(code);
	if (!ast) return false;
	for (const node of ast.program.body) {
		if (containsAsyncWrapperSyntax(node)) return true;
	}
	return false;
}

type TypeScriptStripLoader = "ts" | "tsx";

const TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
const TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });

function stripTypeScript(code: string, options: { force?: boolean; loader?: TypeScriptStripLoader } = {}): string {
	if (!options.force && !LOOKS_LIKE_TS.test(code)) return code;
	try {
		const transpiler = options.loader === "tsx" ? TSX_TRANSPILER : TS_TRANSPILER;
		return transpiler.transformSync(code);
	} catch {
		return code;
	}
}
export function stripTypeScriptSyntax(
	code: string,
	options: { force?: boolean; loader?: TypeScriptStripLoader } = {},
): string {
	return stripTypeScript(code, options);
}

const LOOKS_LIKE_TS =
	/(?:\bimport\s+type\b|\bexport\s+type\b|\b(?:import|export)\s*\{[^}\n]*\btype\s+\w|\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;

export async function wrapCode(
	code: string,
): Promise<{ source: string; asyncWrapped: boolean; finalExpressionReturned: boolean }> {
	const finalExpression = await returnFinalExpression(code);
	const stripped = stripTypeScript(finalExpression.source);
	const importsRewritten = await rewriteImports(stripped);
	const needsAsyncWrapper = await requiresAsyncWrapper(importsRewritten);
	const rewritten = {
		source: await demoteTopLevelLexicals(importsRewritten, { publishGlobals: needsAsyncWrapper }),
		returned: finalExpression.returned,
	};
	if (!needsAsyncWrapper) {
		return { source: rewritten.source, asyncWrapped: false, finalExpressionReturned: rewritten.returned };
	}
	return {
		source: `(async () => {\n${rewritten.source}\n})()`,
		asyncWrapped: true,
		finalExpressionReturned: rewritten.returned,
	};
}
