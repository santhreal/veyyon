import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
	namedImportsFrom,
	resolveModuleSpecifier,
	typeOnlyModuleSpecifiersIn,
} from "@veyyon/utils/module-reach";

/**
 * Contracts: the static import walk three architecture gates are built on.
 *
 * WHY THIS SUITE EXISTS, and it is the sharpest reason a helper can have one. Every gate that uses
 * `moduleReach` asserts an UPPER BOUND: "this module reaches at most N". So a walker that resolves
 * LESS than the runtime does reports a smaller number, and every one of those gates passes while
 * measuring less than it claims. There is no failure to notice. The coding-agent suite records this
 * happening for real: its first version read 774,730 modules instead of 1,020,705, because it resolved
 * `@veyyon/utils/dirs` and not the bare `@veyyon/utils`, and a quarter of the graph went unmeasured
 * behind a green gate.
 *
 * That is why the walk is one module and why it is tested here rather than through the gates. A gate
 * cannot test its own walker: if the walker under-resolves, the gate's number is simply lower and
 * still under the ceiling. Only a fixture with a known answer can catch it.
 *
 * THE FIXTURES ARE REAL FILES on purpose. The walk reads from disk and resolves the extensions the
 * runtime resolves, so a fake filesystem would test a different function than the one that ships.
 */

let root = "";

/** Write `source` to `relative` inside the fixture tree, creating directories as needed. */
function write(relative: string, source: string): string {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
	return file;
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "module-reach-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("moduleSpecifiersIn", () => {
	/** The ordinary forms, all of which instantiate the module. */
	it("finds named, default, namespace, side-effect and re-export specifiers", () => {
		const source = [
			'import { a } from "./named";',
			'import b from "./default";',
			'import * as c from "./namespace";',
			'import "./side-effect";',
			'export { d } from "./re-export";',
			'export * from "./star";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([
			"./side-effect",
			"./named",
			"./default",
			"./namespace",
			"./re-export",
			"./star",
		]);
	});

	/**
	 * IT MUST CROSS NEWLINES. A formatter breaks an import across lines the moment the braces get long
	 * enough, and a pattern anchored on `[^;\n]` stops seeing it then -- silently, reporting the edge is
	 * gone when only its formatting changed. That is a gate passing for the wrong reason.
	 */
	it("finds a specifier in a multi-line braced import", () => {
		const source = ["import {", "\talpha,", "\tbeta,", "\tgamma,", '} from "./wrapped";'].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual(["./wrapped"]);
	});

	/**
	 * `import type` is ERASED, so it costs nothing at runtime and must not be counted. Counting it
	 * would fail the sanctioned fix of narrowing a value import to a type import.
	 */
	it("ignores type-only imports in every form", () => {
		const source = [
			'import type { A } from "./type-named";',
			'import type A from "./type-default";',
			'import type * as ns from "./type-namespace";',
			'export type { B } from "./type-re-export";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/**
	 * An INLINE type specifier is a value import that happens to carry a type, so the module IS
	 * instantiated and it counts. `import { type A, b }` is not `import type { A, b }`.
	 */
	it("counts an import that mixes inline type specifiers with values", () => {
		expect(moduleSpecifiersIn('import { type A, b } from "./mixed";')).toEqual(["./mixed"]);
	});

	/**
	 * `await import()` DEFERS instantiation, and deferring is one of the two sanctioned ways to cut a
	 * graph. Counting it would fail the fix.
	 */
	it("ignores a dynamic import", () => {
		const source = ['const mod = await import("./deferred");', 'void import("./also-deferred");'].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/**
	 * An ordinary string must not be mistaken for a specifier. Allowing newlines in the pattern makes
	 * this worse if the pattern is loose: an exported constant holding a URL, or any string inside a
	 * function body, starts looking like an import.
	 */
	it("ignores strings that merely look like specifiers", () => {
		const source = [
			'export const DOCS = "https://example.com/from/somewhere";',
			"export function describe() {",
			'\treturn "imported from ./not-a-module";',
			"}",
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/** Bare and subpath package specifiers are reported; whether they RESOLVE is a separate decision. */
	it("reports non-relative specifiers too, leaving resolution to the caller", () => {
		const source = ['import { x } from "@scope/pkg";', 'import { y } from "@scope/pkg/leaf";'].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual(["@scope/pkg", "@scope/pkg/leaf"]);
	});
});

describe("typeOnlyModuleSpecifiersIn", () => {
	/** The erased forms, which is the whole set this reports. */
	it("finds statement-leading type imports and type re-exports", () => {
		const source = [
			'import type { A } from "./named-type";',
			'import type B from "./default-type";',
			'import type * as C from "./namespace-type";',
			'export type { D } from "./reexported-type";',
		].join("\n");

		expect(typeOnlyModuleSpecifiersIn(source)).toEqual([
			"./named-type",
			"./default-type",
			"./namespace-type",
			"./reexported-type",
		]);
	});

	/** The complement half: a runtime import is not a type edge, so the two lists never overlap. */
	it("reports nothing for imports that instantiate the module", () => {
		const source = ['import "./side-effect";', 'import { a } from "./named";', 'import D from "./default";'].join(
			"\n",
		);

		expect(typeOnlyModuleSpecifiersIn(source)).toEqual([]);
	});

	/**
	 * The inline form still instantiates the module for its value binding, so it belongs to
	 * `moduleSpecifiersIn` and must NOT be double-counted as free here. Counting it would let a gate
	 * call a real runtime edge erased.
	 */
	it("does not claim a mixed inline-type import is free", () => {
		const source = 'import { type A, b } from "./mixed";';

		expect(typeOnlyModuleSpecifiersIn(source)).toEqual([]);
		expect(moduleSpecifiersIn(source)).toEqual(["./mixed"]);
	});

	/** Prose about a type import is prose, for the same reason it is in the runtime walk. */
	it("ignores a type import written inside a comment", () => {
		const source = ['/** Take it with `import type { A } from "./doc-only";`. */', "export type B = 1;"].join("\n");

		expect(typeOnlyModuleSpecifiersIn(source)).toEqual([]);
	});
});

describe("namedImportsFrom", () => {
	/** The forms a gate meets: single, multiline braces, aliased, and inline-type. */
	it("reports the bindings taken from one specifier, aliases under the bound name", () => {
		const source = [
			'import { A } from "./owner";',
			"import {",
			"\tB,",
			"\tC as renamedC,",
			"\ttype D,",
			'} from "./owner";',
			'import { Elsewhere } from "./other";',
		].join("\n");

		expect(namedImportsFrom(source, "./owner")).toEqual(["A", "B", "renamedC", "D"]);
	});

	/** A different specifier is a different owner; near-misses must not be credited. */
	it("does not credit a specifier that merely shares a prefix", () => {
		const source = 'import { A } from "./owner-extra";\nimport { B } from "./owner";';

		expect(namedImportsFrom(source, "./owner")).toEqual(["B"]);
	});

	/**
	 * A namespace import binds the namespace, not its members, so no claim about an individual name
	 * can be read off it. Reporting `X` here would let a gate believe a name is imported when the
	 * module is free to declare its own.
	 */
	it("reports nothing for a namespace import", () => {
		expect(namedImportsFrom('import * as owner from "./owner";', "./owner")).toEqual([]);
	});

	/** Prose is prose here too. */
	it("ignores an import written inside a comment", () => {
		const source = ['/** Use `import { A } from "./owner";`. */', "export const B = 1;"].join("\n");

		expect(namedImportsFrom(source, "./owner")).toEqual([]);
	});
});

describe("resolveModuleSpecifier", () => {
	let from = "";

	beforeAll(() => {
		from = write("resolve/entry.ts", "");
		write("resolve/sibling.ts", "");
		write("resolve/component.tsx", "");
		write("resolve/folder/index.ts", "");
		write("resolve/exact.json", "{}");
		write("pkg/index.ts", "");
		write("pkg/leaf.ts", "");
		write("pkg/nested/deep.ts", "");
	});

	it("resolves a relative specifier by adding .ts", () => {
		expect(resolveModuleSpecifier(from, "./sibling")).toBe(path.join(root, "resolve/sibling.ts"));
	});

	it("resolves a .tsx module", () => {
		expect(resolveModuleSpecifier(from, "./component")).toBe(path.join(root, "resolve/component.tsx"));
	});

	it("resolves a directory to its index", () => {
		expect(resolveModuleSpecifier(from, "./folder")).toBe(path.join(root, "resolve/folder/index.ts"));
	});

	/** An extension already present is used as written, which is how `.json` modules resolve. */
	it("resolves a specifier that already carries its extension", () => {
		expect(resolveModuleSpecifier(from, "./exact.json")).toBe(path.join(root, "resolve/exact.json"));
	});

	it("returns undefined for a relative path that is not there", () => {
		expect(resolveModuleSpecifier(from, "./missing")).toBeUndefined();
	});

	/**
	 * THE OMISSION THAT UNDER-COUNTED A QUARTER OF A GRAPH. A BARE package name resolves to the whole
	 * barrel, which is the most expensive import style there is. It has to be matched, and it has to be
	 * matched BEFORE the subpath prefix, or `@scope/pkg` falls through to the alias rule, resolves to
	 * nothing, and every barrel import silently costs zero.
	 */
	it("resolves a bare package name to its barrel", () => {
		const resolved = resolveModuleSpecifier(from, "@scope/pkg", {
			packages: [["@scope/pkg", path.join(root, "pkg/index.ts")]],
			aliases: [["@scope/pkg/", path.join(root, "pkg/")]],
		});

		expect(resolved).toBe(path.join(root, "pkg/index.ts"));
	});

	it("resolves a subpath specifier through the alias, not the barrel", () => {
		const resolved = resolveModuleSpecifier(from, "@scope/pkg/leaf", {
			packages: [["@scope/pkg", path.join(root, "pkg/index.ts")]],
			aliases: [["@scope/pkg/", path.join(root, "pkg/")]],
		});

		expect(resolved).toBe(path.join(root, "pkg/leaf.ts"));
	});

	it("resolves a nested subpath", () => {
		const resolved = resolveModuleSpecifier(from, "@scope/pkg/nested/deep", {
			aliases: [["@scope/pkg/", path.join(root, "pkg/")]],
		});

		expect(resolved).toBe(path.join(root, "pkg/nested/deep.ts"));
	});

	/**
	 * LONGEST PREFIX WINS, which matters as soon as one package's alias is a prefix of another's. With
	 * shortest-match, `@scope/pkg-extra/thing` resolves under `@scope/pkg`'s directory and finds
	 * nothing, so the whole package silently drops out of the count.
	 */
	it("prefers the longest matching alias prefix", () => {
		write("pkg-extra/thing.ts", "");
		const resolved = resolveModuleSpecifier(from, "@scope/pkg-extra/thing", {
			aliases: [
				["@scope/pkg", path.join(root, "pkg/")],
				["@scope/pkg-extra/", path.join(root, "pkg-extra/")],
			],
		});

		expect(resolved).toBe(path.join(root, "pkg-extra/thing.ts"));
	});

	/** An unmapped package is outside the measured world and resolves to nothing, by design. */
	it("returns undefined for a package the caller did not map", () => {
		expect(resolveModuleSpecifier(from, "arktype")).toBeUndefined();
		expect(resolveModuleSpecifier(from, "node:fs")).toBeUndefined();
	});
});

describe("moduleReach", () => {
	/** A file with no imports reaches exactly itself, which is the floor every gate needs. */
	it("counts a leaf as one module", () => {
		const leaf = write("reach/leaf.ts", "export const x = 1;\n");

		expect(moduleReachCount(leaf)).toBe(1);
	});

	/** A chain is followed to the end, so an edge three modules deep is still paid for. */
	it("follows a transitive chain", () => {
		const entry = write("reach/chain/a.ts", 'import "./b";\n');
		write("reach/chain/b.ts", 'import "./c";\n');
		write("reach/chain/c.ts", "export const c = 1;\n");

		expect(moduleReachCount(entry)).toBe(3);
	});

	/** A module reached twice is counted once, which is what makes reach a set and not a sum. */
	it("counts a diamond once", () => {
		const entry = write("reach/diamond/a.ts", 'import "./b";\nimport "./c";\n');
		write("reach/diamond/b.ts", 'import "./shared";\n');
		write("reach/diamond/c.ts", 'import "./shared";\n');
		write("reach/diamond/shared.ts", "export const s = 1;\n");

		expect(moduleReachCount(entry)).toBe(4);
	});

	/** A cycle terminates. Import cycles exist in this repo, so a walker that hangs on one is useless. */
	it("terminates on a cycle and counts each module once", () => {
		const entry = write("reach/cycle/a.ts", 'import "./b";\n');
		write("reach/cycle/b.ts", 'import "./a";\n');

		expect(moduleReachCount(entry)).toBe(2);
	});

	/**
	 * A MISSING module never reaches the read at all: `resolveFile` requires the path to exist, so the
	 * specifier resolves to nothing and the edge is not followed. Worth a case of its own because it is
	 * the behaviour people assume the try/catch is for, and it is not.
	 */
	it("does not follow an edge whose module is not there", () => {
		const entry = write("reach/missing/a.ts", 'import "./generated.json";\n');

		expect(moduleReachCount(entry)).toBe(1);

		// And with the file present it is counted, which is what makes the assertion above meaningful.
		write("reach/missing/generated.json", "{}");
		expect(moduleReachCount(entry)).toBe(2);
	});

	/**
	 * THE CASE THE TRY/CATCH IS ACTUALLY FOR, and it had no coverage until a mutation run said so:
	 * removing the guard entirely broke nothing, because the test above never reached the read.
	 *
	 * A module that existed when it was resolved and cannot be read a moment later is real in this repo,
	 * where builds rewrite generated modules while tests run, and it must not turn an architecture
	 * ceiling into a crash. It is counted and not followed, so the edge that named it is still on the
	 * record.
	 *
	 * The precondition is ASSERTED rather than assumed. Running as root would make the file readable
	 * regardless, and a test that silently passes because its setup did not take is worse than no test:
	 * this one fails instead.
	 */
	it("counts a file it cannot read, and keeps walking", () => {
		const entry = write("reach/unreadable/a.ts", 'import "./locked";\nimport "./sibling";\n');
		const locked = write("reach/unreadable/locked.ts", 'import "./never-followed";\n');
		write("reach/unreadable/never-followed.ts", "export const x = 1;\n");
		write("reach/unreadable/sibling.ts", "export const y = 1;\n");
		fs.chmodSync(locked, 0o000);

		try {
			expect(() => fs.readFileSync(locked, "utf-8"), "the fixture is readable, so this proves nothing").toThrow();

			// entry + locked + sibling. `never-followed` is behind the unreadable module, so it is not
			// reached, and the walk still continues past `locked` to `sibling`.
			expect([...moduleReach(entry)].map(file => path.basename(file)).sort()).toEqual([
				"a.ts",
				"locked.ts",
				"sibling.ts",
			]);
		} finally {
			fs.chmodSync(locked, 0o644);
		}
	});

	/** The set holds absolute paths, so a caller can name what regressed rather than print a number. */
	it("returns the reached files, entry included", () => {
		const entry = write("reach/named/a.ts", 'import "./b";\n');
		const b = write("reach/named/b.ts", "export const b = 1;\n");

		expect([...moduleReach(entry)].sort()).toEqual([entry, b].sort());
	});

	/** Type-only edges are not followed, so narrowing an import to a type really does cut the graph. */
	it("does not follow a type-only edge", () => {
		const entry = write("reach/typed/a.ts", 'import type { B } from "./b";\nexport type A = B;\n');
		write("reach/typed/b.ts", 'import "./heavy";\nexport type B = 1;\n');
		write("reach/typed/heavy.ts", "export const heavy = 1;\n");

		expect(moduleReachCount(entry)).toBe(1);
	});

	/** Nor a deferred one, which is the other sanctioned cut. */
	it("does not follow a dynamic import", () => {
		const entry = write("reach/deferred/a.ts", 'export const load = () => import("./b");\n');
		write("reach/deferred/b.ts", 'import "./heavy";\n');
		write("reach/deferred/heavy.ts", "export const heavy = 1;\n");

		expect(moduleReachCount(entry)).toBe(1);
	});

	/**
	 * THE CASE THE MISSING RULE BROKE. A bare barrel import reaches the barrel and everything the
	 * barrel re-exports. Without the `packages` mapping this entry reads as 1 module while really
	 * costing 4, which is the exact shape of the 774,730-instead-of-1,020,705 under-count.
	 */
	it("reaches a whole barrel through a bare package specifier", () => {
		const entry = write("reach/barrel/consumer.ts", 'import { a } from "@fixture/lib";\nexport const use = a;\n');
		write("reach/barrel/lib/index.ts", 'export * from "./a";\nexport * from "./b";\n');
		write("reach/barrel/lib/a.ts", "export const a = 1;\n");
		write("reach/barrel/lib/b.ts", "export const b = 2;\n");
		const resolution = {
			packages: [["@fixture/lib", path.join(root, "reach/barrel/lib/index.ts")] as const],
			aliases: [["@fixture/lib/", path.join(root, "reach/barrel/lib/")] as const],
		};

		expect(moduleReachCount(entry, resolution)).toBe(4);
		// Without the mapping the same file reads as a leaf, which is the silent under-count.
		expect(moduleReachCount(entry)).toBe(1);
	});

	/** And the subpath import of the same package pays only for the leaf, which is the whole point. */
	it("reaches one module through a subpath specifier where the barrel costs three", () => {
		const entry = write("reach/subpath/consumer.ts", 'import { a } from "@fixture/lib/a";\nexport const use = a;\n');
		const resolution = {
			packages: [["@fixture/lib", path.join(root, "reach/barrel/lib/index.ts")] as const],
			aliases: [["@fixture/lib/", path.join(root, "reach/barrel/lib/")] as const],
		};

		expect(moduleReachCount(entry, resolution)).toBe(2);
	});
});
