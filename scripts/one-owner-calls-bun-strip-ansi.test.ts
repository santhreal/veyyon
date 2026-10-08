/**
 * Shipped source reaches `Bun.stripANSI` in one place: `sanitizeText` in
 * `packages/utils/src/sanitize-text.ts`. Every other caller strips ANSI through `stripAnsi` from
 * `@veyyon/utils`.
 *
 * WHY THIS SUITE EXISTS. The Bun-surface rule keeps a Bun API with a portable equivalent out of new
 * code, and keeps it in one place when a measured reason holds it. `Bun.stripANSI` has a portable
 * equivalent, and the debug-transcript dump and the gallery's `--plain` output called it directly
 * anyway, so the call sites grew one reviewer-invisible line at a time. The sweep reads the shipped
 * source of every workspace member and fails on a reference outside the owner.
 *
 * THE CLASS is any reference to the Bun method, in each spelling that reaches it: a property access
 * (`Bun.stripANSI(x)`, `globalThis.Bun.stripANSI`), an alias (`const strip = Bun.stripANSI`), a
 * destructure (`const { stripANSI } = Bun`) and an element access (`Bun["stripANSI"]`). All four put
 * the name `stripANSI` into the code as an identifier or a string literal, which is what the sweep
 * matches after parsing, so a comment naming the method does not count.
 *
 * WHAT THIS DOES NOT CATCH. A name assembled at run time (`Bun["strip" + "ANSI"]`), a reference in a
 * `.js` or `.mjs` file, and test code: files under `test/`, `*.test.ts`, and the members under
 * `tests/`, which ship nowhere. The benches beside a member's `src/` are not shipped and are not swept.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project } from "ts-morph";
import { collectSourceFiles, REPO_ROOT, typeScriptMembers, typeScriptMemberTopLevels } from "./workspace-layout";

/** The one file allowed to reference the Bun method. */
const OWNER = "packages/utils/src/sanitize-text.ts";

/** The method name every spelling of the reference carries. */
const METHOD = "stripANSI";

/** Members that ship nowhere: the eval suites and the offline simulations. */
const SHIPPED_MEMBERS = typeScriptMembers().filter(member => !member.startsWith("tests/"));

/** Each `stripANSI` identifier or string literal in `source`, as the text of the line holding it. */
function references(project: Project, source: string): string[] {
	if (!source.includes(METHOD)) return [];
	const file = project.createSourceFile("probe.ts", source, { overwrite: true });
	const found: string[] = [];
	file.forEachDescendant(node => {
		const named =
			(Node.isIdentifier(node) && node.getText() === METHOD) ||
			(Node.isStringLiteral(node) && node.getLiteralValue() === METHOD);
		if (!named) return;
		const line = node.getStartLineNumber();
		found.push(`${line}: ${source.split("\n")[line - 1]?.trim() ?? ""}`);
	});
	return found;
}

interface Sweep {
	readonly scanned: string[];
	/** `<file>:<line>: <text>` for every reference outside the owner. */
	readonly outside: string[];
	/** References inside the owner, which prove the sweep can see one. */
	readonly inOwner: string[];
}

function sweep(): Sweep {
	const project = new Project({ useInMemoryFileSystem: true });
	const scanned = collectSourceFiles(SHIPPED_MEMBERS, REPO_ROOT)
		.map(file => path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"))
		.sort();
	const outside: string[] = [];
	const inOwner: string[] = [];
	for (const rel of scanned) {
		const found = references(project, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
		if (rel === OWNER) inOwner.push(...found);
		else for (const reference of found) outside.push(`${rel}:${reference}`);
	}
	return { scanned, outside, inOwner };
}

describe("one owner calls Bun.stripANSI", () => {
	const result = sweep();

	it("reads every tree that holds a shipped TypeScript member", () => {
		expect(result.scanned.length).toBeGreaterThan(1000);
		const roots = new Set(result.scanned.map(rel => rel.split("/")[0]));
		const withSource = typeScriptMemberTopLevels().filter(root =>
			SHIPPED_MEMBERS.some(
				member => member.startsWith(`${root}/`) && fs.existsSync(path.join(REPO_ROOT, member, "src")),
			),
		);
		expect(withSource.filter(root => !roots.has(root))).toEqual([]);
	});

	it("finds the call inside the owner, so a green sweep is a sweep that can see one", () => {
		expect(result.scanned).toContain(OWNER);
		expect(result.inOwner).toHaveLength(1);
		expect(result.inOwner[0]).toContain("Bun.stripANSI(text)");
	});

	it("finds no reference outside the owner", () => {
		expect(result.outside, "Strip through stripAnsi from @veyyon/utils instead of calling Bun.stripANSI").toEqual([]);
	});
});

describe("what counts as a reference", () => {
	const project = new Project({ useInMemoryFileSystem: true });
	const count = (source: string): number => references(project, source).length;

	it("matches each spelling that reaches the method", () => {
		expect(count("const plain = Bun.stripANSI(line);")).toBe(1);
		expect(count("const plain = globalThis.Bun.stripANSI(line);")).toBe(1);
		expect(count("const strip = Bun.stripANSI;")).toBe(1);
		expect(count("const { stripANSI } = Bun;")).toBe(1);
		expect(count('const plain = Bun["stripANSI"](line);')).toBe(1);
	});

	it("leaves comments, the portable helper and unrelated strings alone", () => {
		expect(count("// calls Bun.stripANSI when an escape is present\nconst x = 1;")).toBe(0);
		expect(count("/** Bun.stripANSI */\nexport const y = 2;")).toBe(0);
		expect(count("const plain = stripAnsi(line);")).toBe(0);
		expect(count('const label = "Bun.stripANSI";')).toBe(0);
	});
});
