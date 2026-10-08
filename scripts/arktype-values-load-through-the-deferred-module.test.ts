/**
 * Shipped source loads arktype through one module, which evaluates the package on first use.
 *
 * WHY THIS SUITE EXISTS. Evaluating `arktype` builds its keyword scopes: 115 modules, about 30ms of a
 * compiled binary's launch and 6 MiB of heap. Every schema is built inside a `lazy()` thunk, so a launch
 * needs none of it, and 76 shipped modules still evaluated it at launch through a static value import.
 * `packages/ai/src/utils/schema/arktype.ts` holds the one `require("arktype")` and hands out stand-ins
 * for `type`, `scope` and `Type`; every other module imports those.
 *
 * THE CLASS. A shipped module in any workspace member that loads `arktype` or an `@ark/*` package at run
 * time: a value import, an inline `type` import beside a value, a re-export, a dynamic import or a
 * `require`. Each one evaluates the package whenever that module is evaluated, which is a launch cost the
 * moment the module joins the launch path. Members are read from the workspace manifests, so a new
 * member is swept without an edit; the `tests/*` members ship nowhere and are not swept. `import type`
 * and `export type` are erased and stay allowed.
 *
 * WHAT IT DOES NOT CATCH. A specifier computed at run time, and a dependency that bundles its own copy
 * of arktype. Whether a launch evaluates the package through a schema built while a module evaluates is
 * a runtime question, answered by
 * `packages/coding-agent/test/architecture/a-launch-evaluates-arktype-only-when-a-schema-is-built.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn, withoutComments } from "@veyyon/utils/module-reach";
import { collectSourceFiles, REPO_ROOT, typeScriptMembers } from "./workspace-layout";

const DEFERRED_MODULE = "packages/ai/src/utils/schema/arktype.ts";

/** Members that ship nowhere: the eval suites and the offline simulations. */
const SHIPPED_MEMBERS = typeScriptMembers().filter(member => !member.startsWith("tests/"));

/** `require("x")` with a literal specifier. `moduleSpecifiersIn` does not read `require`. */
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

function isArktypeSpecifier(specifier: string): boolean {
	return specifier === "arktype" || specifier.startsWith("arktype/") || specifier.startsWith("@ark/");
}

/** Every specifier `source` loads at run time. */
function runtimeSpecifiersIn(source: string): string[] {
	const found = [...moduleSpecifiersIn(source), ...dynamicImportSpecifiersIn(source)];
	for (const match of withoutComments(source).matchAll(REQUIRE_RE)) found.push(match[1] as string);
	return found;
}

/** Shipped modules that load arktype at run time, relative to the repository root, sorted. */
function arktypeLoaders(): string[] {
	return collectSourceFiles(SHIPPED_MEMBERS)
		.filter(file => runtimeSpecifiersIn(fs.readFileSync(file, "utf8")).some(isArktypeSpecifier))
		.map(file => path.relative(REPO_ROOT, file))
		.sort();
}

describe("arktype values load through the deferred module", () => {
	it("reads every specifier form a module can load arktype by", () => {
		const forms = [
			'import { type } from "arktype";',
			'import { type Type, type } from "arktype";',
			'import * as ark from "arktype";',
			'export { type } from "arktype";',
			'import "@ark/schema";',
			'const ark = await import("arktype");',
			'const ark = require("arktype");',
		];
		expect(forms.filter(form => !runtimeSpecifiersIn(form).some(isArktypeSpecifier))).toEqual([]);
		expect(runtimeSpecifiersIn('import type { Type } from "arktype";').some(isArktypeSpecifier)).toBe(false);
		expect(runtimeSpecifiersIn('export type { Type } from "arktype";').some(isArktypeSpecifier)).toBe(false);
	});

	it("sweeps the shipped source of every workspace member", () => {
		const files = collectSourceFiles(SHIPPED_MEMBERS).map(file => path.relative(REPO_ROOT, file));
		expect(files).toContain(DEFERRED_MODULE);
		expect(files).toContain("packages/coding-agent/src/tools/agent/todo.ts");
	});

	it("finds the package loaded by the deferred module and nowhere else", () => {
		expect(arktypeLoaders()).toEqual([DEFERRED_MODULE]);
	});
});
