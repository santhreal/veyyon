/**
 * WHY: the compiled binary's legacy-extension table imported every retained host module as a
 * namespace (`import * as`). The bundler builds a namespace import of an ES module as an export
 * object holding one getter closure per export, emitted in the imported module's own chunk and
 * built when that chunk loads, which is at startup for most of the thousand-odd retained modules,
 * whether or not a legacy extension ever loads. The table now imports each export by name and
 * builds a key's export record when an extension imports that key.
 *
 * THE CLASS THIS CLOSES: a table record that differs from what a namespace import of the same
 * module returns (a missing name, an extra name, another value) for any export form: declarations,
 * a renamed re-export, an `export *` chain, `export * as`, default only, default beside names, an
 * empty file, a CommonJS module, a module with no export, and every real entry the binary retains,
 * swept from `collectBundledPiEntries()` at run time through the binary's own plugin. Also a table
 * that brings a namespace object back into a host module, and an export-less module the table
 * stops evaluating.
 *
 * WHAT IT DOES NOT CATCH: the `--compile --bytecode` link of the real binary, which only a binary
 * build performs, and the runtime synthesis of `veyyon-legacy-pi-bundled:<key>` modules from a
 * record, which `legacy-pi-bundled-virtual.test.ts` drives.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	type BundledPiEntry,
	collectBundledPiEntries,
	LEGACY_PI_MODULES_SPECIFIER,
	renderBundledPiModules,
	resolveBundledPiExports,
} from "../../scripts/legacy-pi-virtual-module";
import {
	bundleEntry,
	differingRecords,
	LEGACY_TABLE_EXTERNAL,
	NAMESPACES_SPECIFIER,
	namespaceSource,
	TABLE_AND_NAMESPACES,
	tablePlugin,
} from "../fixtures/legacy-module-table";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "legacy-module-table.ts");
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const EVALUATED = "__legacyTableEvaluated";

/** Every export form a host module can take. */
const FIXTURES: Record<string, string> = {
	"named.ts": [
		'export const value = { tag: "value" };',
		"export function fn() { return 1; }",
		"export class Klass {}",
		"export let counter = 0;",
		"export const bump = () => ++counter;",
	].join("\n"),
	"renamed.ts": 'export { value as aliased, fn } from "./named";',
	"star.ts": 'export * from "./named";\nexport const own = "own";',
	"star-chain.ts": 'export * from "./star";\nexport * as nested from "./renamed";',
	"default-only.ts": 'export default function legacyDefault() { return "d"; }',
	"default-and-named.ts": 'export default { kind: "object-default" };\nexport const named = 1;',
	"empty.ts": "",
	"commonjs.cjs": "module.exports = { cjsValue: 1 };\nmodule.exports.extra = 2;",
	"side-effect-only.ts": `Reflect.set(globalThis, "${EVALUATED}", (Reflect.get(globalThis, "${EVALUATED}") ?? 0) + 1);\nexport {};`,
};

/** `export * as` declares a namespace object in the module itself, whoever imports it. */
const DECLARES_A_NAMESPACE = new Set(["star-chain.ts"]);

let scratch: TempDir;

beforeEach(() => {
	scratch = TempDir.createSync("@veyyon-legacy-table-");
});

afterEach(() => {
	scratch.removeSync();
	Reflect.deleteProperty(globalThis, EVALUATED);
});

function writeFixtures(): BundledPiEntry[] {
	const dir = path.join(scratch.path(), "fixtures");
	fs.mkdirSync(dir, { recursive: true });
	return Object.entries(FIXTURES).map(([file, source]) => {
		fs.writeFileSync(path.join(dir, file), source);
		return { key: `fixture/${file}`, importSpecifier: path.join(dir, file) };
	});
}

const countNamespaceObjects = (text: string): number => text.split("__export(").length - 1;

describe("the compiled legacy module table", () => {
	it("serves, for every export form, the names and values a namespace import serves", async () => {
		const entries = writeFixtures();
		const table = renderBundledPiModules(await resolveBundledPiExports(entries, LEGACY_TABLE_EXTERNAL));
		const { loaded } = await bundleEntry(
			path.join(scratch.path(), "equivalence"),
			TABLE_AND_NAMESPACES,
			{ [NAMESPACES_SPECIFIER]: namespaceSource(entries) },
			tablePlugin(table),
		);
		const keys = entries.map(entry => entry.key);
		expect(Object.keys(loaded.BUNDLED_PI_MODULES!).sort()).toEqual([...keys].sort());
		expect(differingRecords(loaded, keys)).toEqual([]);
		// Non-vacuity: the `export *`, default and CommonJS names arrived, so the comparison saw real records.
		expect(Object.keys(loaded.BUNDLED_PI_MODULES!["fixture/star-chain.ts"]!()).sort()).toEqual(
			["Klass", "bump", "counter", "fn", "nested", "own", "value"].sort(),
		);
		expect(loaded.BUNDLED_PI_MODULES!["fixture/default-and-named.ts"]!().default).toEqual({ kind: "object-default" });
		expect(loaded.BUNDLED_PI_MODULES!["fixture/commonjs.cjs"]!().extra).toBe(2);
	});

	it("adds no namespace object to a host module and still evaluates a module with no export", async () => {
		const entries = writeFixtures().filter(entry => !DECLARES_A_NAMESPACE.has(path.basename(entry.importSpecifier)));
		const SIDE_EFFECTS = "legacy-table-test-side-effects";
		const baseline = await bundleEntry(path.join(scratch.path(), "baseline"), [`import "${SIDE_EFFECTS}";`], {
			[SIDE_EFFECTS]: entries.map(entry => `import ${JSON.stringify(entry.importSpecifier)};`).join("\n"),
		});
		const namespaces = await bundleEntry(
			path.join(scratch.path(), "namespaces"),
			[`export { NAMESPACES } from "${NAMESPACES_SPECIFIER}";`],
			{ [NAMESPACES_SPECIFIER]: namespaceSource(entries) },
		);
		Reflect.deleteProperty(globalThis, EVALUATED);
		const table = renderBundledPiModules(await resolveBundledPiExports(entries, LEGACY_TABLE_EXTERNAL));
		const tableOnly = await bundleEntry(
			path.join(scratch.path(), "table"),
			[`export { BUNDLED_PI_MODULES } from "${LEGACY_PI_MODULES_SPECIFIER}";`],
			{},
			tablePlugin(table),
		);

		// Control: a namespace import of these modules does add namespace objects.
		expect(countNamespaceObjects(namespaces.text)).toBeGreaterThan(countNamespaceObjects(baseline.text));
		expect(countNamespaceObjects(tableOnly.text)).toBe(countNamespaceObjects(baseline.text));
		expect(Reflect.get(globalThis, EVALUATED)).toBe(1);
		expect(tableOnly.loaded.BUNDLED_PI_MODULES!["fixture/side-effect-only.ts"]!()).toEqual({});
	});

	it("serves every real retained entry what a namespace import of it serves", async () => {
		const run = spawnSync(process.execPath, [FIXTURE, path.join(scratch.path(), "real")], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(run.status, run.stderr).toBe(0);
		const report = JSON.parse(run.stdout) as { keys: string[]; entries: string[]; differing: string[] };
		const entries = (await collectBundledPiEntries()).map(entry => entry.key);
		expect(report.entries).toEqual(entries);
		expect([...report.keys].sort()).toEqual([...entries].sort());
		expect(report.differing).toEqual([]);
	});
});
