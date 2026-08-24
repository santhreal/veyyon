/**
 * A test that reads a `.ts` module out of a package's `src` asks a query about it, never a matcher
 * against its bytes.
 *
 * WHAT THIS CLOSES. Twenty-five suites in this repository enforced a one-owner or one-edge invariant
 * by matching the implementation's own formatting: `expect(source).toContain('import { getEnvApiKey }
 * from "./env-api-key";')`, `expect(owner).toMatch(/^export function parse\(/m)`. Both directions
 * fail. The assertion goes red on a reflow, a rename or a formatter release, which is noise a lane
 * fixes by widening the pattern; and it stays green on the defect it exists to catch, because a
 * second module declaring the same name, a longer route to the same import, or a signature quoted in
 * a doc comment all satisfy a byte match. One suite here asserted that phase two imports the `.env`
 * parser under an alias and passed for years while `env.ts` declared a `parseEnvFile` of its own.
 *
 * WHAT REPLACES IT. `@veyyon/utils/module-reach` answers what a module imports and what it reaches;
 * `@veyyon/utils/source-declarations` answers which module declares a name or a value. Both parse,
 * both ignore comments, and both take the whole candidate set rather than one file, so two owners and
 * no owner are single failures. A claim neither can express is a claim about behaviour, and the
 * behaviour is reachable: construct the thing and drive it.
 *
 * SCOPE, stated so the fence is visible. Only `.ts` and `.tsx` under a package's `src` count. A test
 * that reads a `.json`, `.css`, `.html` or `.md` asset and asserts on its text is asserting the bytes
 * that ship, which is behaviour. A test that reads a file its own subject WROTE — an applied patch, a
 * generated bundle, a rendered book page — is reading output, not source. Neither is in scope here.
 *
 * WHAT IT DOES NOT CATCH, and two of these are in the tree today. A census over the source rather than
 * a match against it: `[...SOURCE.matchAll(/"app\.[a-z.]+":\s*\["[a-z+]+"/g)]` asserted empty, which is
 * a claim about a literal table's SHAPE and has no query to replace it, and a `split("\n").filter(...)`
 * that reports which lines are not re-exports. Byte matching through an indirection this does not
 * follow: a helper in another module that returns source text, a path assembled at run time from
 * values not visible here, or text pulled from a `Bun.file` handle. The allowlist below is empty, so
 * the shapes it does see are all converted; it may only shrink.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Node, Project, type SourceFile, SyntaxKind } from "ts-morph";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Matchers that read the subject as text rather than asking it a question. */
const TEXT_MATCHERS = new Set([
	"toContain",
	"toMatch",
	"toStartWith",
	"toEndWith",
	"toInclude",
	"toIncludeRepeated",
	"toContainEqual",
]);

/**
 * Sites that still match module bytes, as `<repo-relative file>:<line>`.
 *
 * SHRINK ONLY. Each row is a conversion nobody has done yet, not a licensed exception: convert it to
 * a query from `module-reach.ts` or `source-declarations.ts`, replace it with a behavioural
 * assertion, or delete the assertion, then delete the row. A new row means a test went back to
 * matching formatting, which is what this gate exists to refuse.
 */
const ALLOWED: readonly string[] = [];

/**
 * Every test file under `root` that could hold one of these assertions.
 *
 * Parsing all 1,400 test files costs more than the whole scripts bucket, so a file reaches the parser
 * only when its text holds a read and the word `src`. A matcher is not part of the filter: the
 * boolean spelling of a scan (`expect(source.includes(...)).toBe(true)`) carries no text matcher at
 * all, and dropping those files is how a filter turns a gate into a decoration.
 */
function testFiles(root: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf-8" })) {
		if (!entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) continue;
		if (entry.includes(`node_modules${path.sep}`) || entry.includes("node_modules/")) continue;
		const file = path.join(root, entry);
		const text = fs.readFileSync(file, "utf-8");
		if (!/readFileSync|readFile\(/.test(text)) continue;
		if (!text.includes("src")) continue;
		found.push(file);
	}
	return found.sort();
}

/** The string fragments a path expression is built from, following consts declared in the same file. */
function pathFragments(node: Node, seen: Set<string>): string[] {
	if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return [node.getLiteralText()];
	if (Node.isIdentifier(node)) {
		const name = node.getText();
		if (seen.has(name)) return [];
		seen.add(name);
		const declaration = node
			.getSourceFile()
			.getVariableDeclarations()
			.find(candidate => candidate.getName() === name);
		const initializer = declaration?.getInitializer();
		return initializer ? pathFragments(initializer, seen) : [];
	}
	const fragments: string[] = [];
	for (const child of node.getChildren()) fragments.push(...pathFragments(child, seen));
	return fragments;
}

/** Whether `call` reads a `.ts`/`.tsx` module out of a package's `src`. */
function readsAModule(call: Node): boolean {
	if (!Node.isCallExpression(call)) return false;
	const callee = call.getExpression().getText();
	if (!/(^|\.)readFileSync$|(^|\.)readFile$/.test(callee)) return false;
	const target = call.getArguments()[0];
	if (target === undefined) return false;
	const fragments = pathFragments(target, new Set());
	const joined = fragments.join("/");
	return /\.tsx?($|["'])/.test(joined) && /(^|\/|\.\.)src(\/|$)/.test(joined);
}

/** Whether the expression handed to `expect` is module source rather than an answer about it. */
function isModuleSource(node: Node, locals: Map<string, boolean>): boolean {
	if (Node.isCallExpression(node)) {
		const name = node.getExpression().getText().split(".").at(-1) ?? "";
		if (readsAModule(node)) return true;
		// A helper in the same file that reads for its caller: `read("env.ts")`.
		if (locals.get(name) === true) return true;
		// `read(...).toLowerCase()`, `source.split("\n")`: the receiver decides.
		const receiver = Node.isPropertyAccessExpression(node.getExpression())
			? node.getExpression().asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression()
			: undefined;
		return receiver === undefined ? false : isModuleSource(receiver, locals);
	}
	if (Node.isPropertyAccessExpression(node)) return isModuleSource(node.getExpression(), locals);
	if (Node.isIdentifier(node)) return locals.get(node.getText()) === true;
	if (Node.isParenthesizedExpression(node)) return isModuleSource(node.getExpression(), locals);
	return false;
}

/** Every local name in `file` bound to module source, directly or through another such name. */
function moduleSourceLocals(file: SourceFile): Map<string, boolean> {
	const locals = new Map<string, boolean>();
	// Two passes: a variable may be declared after the helper that reads for it.
	for (let round = 0; round < 2; round += 1) {
		for (const declaration of file.getVariableDeclarations()) {
			const initializer = declaration.getInitializer();
			if (initializer && isModuleSource(initializer, locals)) locals.set(declaration.getName(), true);
		}
		for (const fn of file.getFunctions()) {
			const returns = fn.getDescendantsOfKind(SyntaxKind.ReturnStatement);
			const reads = returns.some(statement => {
				const value = statement.getExpression();
				return value !== undefined && isModuleSource(value, locals);
			});
			const name = fn.getName();
			if (reads && name) locals.set(name, true);
		}
	}
	return locals;
}

/**
 * String scans that turn module bytes into a value some other matcher then checks.
 *
 * `expect(source.includes("import x")).toBe(true)` is the same assertion as `toContain`, spelled so a
 * matcher list alone would miss it.
 */
const STRING_SCANS = new Set(["includes", "match", "matchAll", "search", "indexOf", "startsWith", "endsWith"]);

/** Whether `node` is `<something>.includes(...)`-shaped, one of the scans that reads text. */
function isStringScan(node: Node): boolean {
	if (!Node.isCallExpression(node)) return false;
	const callee = node.getExpression();
	return Node.isPropertyAccessExpression(callee) && STRING_SCANS.has(callee.getName());
}

/** The lines of `source` where a matcher decides a module's bytes. */
function byteMatchLines(source: SourceFile): number[] {
	const locals = moduleSourceLocals(source);
	const lines: number[] = [];
	for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		if (call.getExpression().getText() !== "expect") continue;
		const subject = call.getArguments()[0];
		if (subject === undefined || !isModuleSource(subject, locals)) continue;
		const matcher = call
			.getAncestors()
			.filter(Node.isPropertyAccessExpression)
			.map(access => access.getName())
			.find(name => TEXT_MATCHERS.has(name));
		// Either the matcher reads the text, or the subject already scanned it and any matcher will do.
		if (matcher !== undefined || isStringScan(subject)) lines.push(call.getStartLineNumber());
	}
	return lines;
}

/** Every `expect(<module source>).toContain(...)`-shaped site under `roots`, relative to `base`. */
function byteMatchSites(roots: readonly string[], base: string): string[] {
	const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
	const sites: string[] = [];
	for (const root of roots) {
		for (const file of testFiles(root)) {
			const source = project.addSourceFileAtPath(file);
			for (const line of byteMatchLines(source)) sites.push(`${path.relative(base, file)}:${line}`);
			project.removeSourceFile(source);
		}
	}
	return [...new Set(sites)].sort();
}

/** The path roots every control fixture names, so a fixture is one or two lines of its own shape. */
const PRELUDE = [
	'const SRC = path.join(import.meta.dir, "../src");',
	'const DOCS = path.join(import.meta.dir, "../docs");',
];

/** Whether the detector calls `lines` a byte match, decided the same way the sweep decides a file. */
function flagsAByteMatch(lines: readonly string[]): boolean {
	const project = new Project({ useInMemoryFileSystem: true });
	const file = project.createSourceFile("probe.test.ts", [...PRELUDE, ...lines].join("\n"));
	return byteMatchLines(file).length > 0;
}

describe("an invariant about a module is read from the module graph", () => {
	/**
	 * The gate. Pinned by exact equality, so a conversion shrinks the list and a regression cannot
	 * hide inside a count.
	 */
	it("matches no module's source bytes outside the recorded remainder", () => {
		expect(byteMatchSites([path.join(REPO_ROOT, "packages"), path.join(REPO_ROOT, "scripts")], REPO_ROOT)).toEqual([
			...ALLOWED,
		]);
	});

	/**
	 * Anti-vacuity, and it is the arm the gate needs most. The list above is empty, so a sweep that
	 * reached no file, a prefilter that dropped everything, or a path that stopped resolving all read
	 * as a pass. This plants one offender and one innocent file in a tree of its own and sweeps THAT,
	 * through the same function, so the whole path — the walk, the filter, the parse, the reported
	 * `file:line` — is exercised against a known answer.
	 */
	it("reports a planted byte match, and only it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "byte-match-sweep-"));
		try {
			fs.writeFileSync(
				path.join(root, "offender.test.ts"),
				[
					'const SRC = path.join(import.meta.dir, "../src");',
					'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
					'expect(source).toContain("export function parseEnvFile");',
				].join("\n"),
			);
			fs.writeFileSync(
				path.join(root, "innocent.test.ts"),
				[
					'const SRC = path.join(import.meta.dir, "../src");',
					'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
					'expect(moduleSpecifiersIn(source)).toContain("./dirs");',
				].join("\n"),
			);

			expect(byteMatchSites([root], root)).toEqual(["offender.test.ts:3"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * The control. A gate over a dataflow rule is worth what its detector is worth, so the detector
	 * decides source it is handed rather than the tree, one fixture per shape it has to tell apart.
	 * `PRELUDE` supplies the two path roots every fixture names.
	 */
	it.each([
		[
			"a read stored in a const",
			['const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");', 'expect(source).toContain("x");'],
			true,
		],
		[
			"a read inlined in the expect",
			['expect(fs.readFileSync(path.join(SRC, "env.ts"), "utf-8")).toContain("x");'],
			true,
		],
		[
			"a read through a helper",
			[
				"function read() {",
				"\treturn fs.readFileSync(SRC + '/env.ts', 'utf-8');",
				"}",
				'expect(read()).toContain("x");',
			],
			true,
		],
		[
			"a read a chain lowercased first",
			[
				'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
				'expect(source.toLowerCase()).toContain("x");',
			],
			true,
		],
		[
			"a scan spelled as a boolean",
			[
				'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
				'expect(source.includes("import { x }")).toBe(true);',
			],
			true,
		],
		[
			"a scan spelled as a regex match",
			[
				'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
				"expect(source.match(/export function/)).not.toBeNull();",
			],
			true,
		],
		[
			"a css asset",
			['const source = fs.readFileSync(path.join(SRC, "tokens.css"), "utf-8");', 'expect(source).toContain("x");'],
			false,
		],
		[
			"a file outside src",
			['const source = fs.readFileSync(path.join(DOCS, "guide.ts"), "utf-8");', 'expect(source).toContain("x");'],
			false,
		],
		[
			"a query's answer",
			[
				'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
				'expect(moduleSpecifiersIn(source)).toContain("./dirs");',
			],
			false,
		],
		[
			"a read asserted by identity rather than by text",
			[
				'const source = fs.readFileSync(path.join(SRC, "env.ts"), "utf-8");',
				"expect(source.length).toBeGreaterThan(0);",
			],
			false,
		],
	])("tells %s from the rest", (_why, lines, expected) => {
		expect(flagsAByteMatch(lines)).toBe(expected);
	});
});
