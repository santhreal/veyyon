/**
 * Bundles the compiled binary's legacy module table beside a namespace import of every module it
 * retains, loads the bundle, and compares the two. The suite
 * `the-compiled-legacy-module-table-serves-what-a-namespace-import-would.test.ts` imports the
 * helpers; run as a script, this module sweeps every real retained entry through the binary's own
 * plugin and prints `{ keys, differing }` as JSON.
 *
 *   bun test/fixtures/legacy-module-table.ts <scratch-dir>
 *
 * The real sweep runs as a script because, inside a `bun test` process whose test file sits under a
 * workspace package, the first `Bun.build` over the retained graph reports a varying set of
 * existing relative imports as unresolvable; the same build succeeds as a script.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { COMPILED_EXTERNAL_DEPENDENCIES } from "../../scripts/compile-binary";
import {
	type BundledPiEntry,
	collectBundledPiEntries,
	createLegacyPiVirtualModulePlugin,
	LEGACY_PI_MODULES_SPECIFIER,
} from "../../scripts/legacy-pi-virtual-module";

/** The binary build's externals, with mupdf, which the binary replaces by a stub. */
export const LEGACY_TABLE_EXTERNAL: readonly string[] = [...COMPILED_EXTERNAL_DEPENDENCIES, "mupdf"];

/** The specifier the namespace-import module is served under. */
export const NAMESPACES_SPECIFIER = "legacy-table-test-namespaces";

type ExportRecord = Readonly<Record<string, unknown>>;

/** What a bundled entry exports: the table, the namespaces, or both. */
export interface LoadedBundle {
	readonly BUNDLED_PI_MODULES?: Readonly<Record<string, () => ExportRecord>>;
	readonly NAMESPACES?: Readonly<Record<string, ExportRecord>>;
}

/** A module exporting `NAMESPACES`: each entry's key mapped to a namespace import of its module. */
export function namespaceSource(entries: readonly BundledPiEntry[]): string {
	const imports = entries.map(
		(entry, index) => `import * as ns${index} from ${JSON.stringify(entry.importSpecifier)};`,
	);
	const fields = entries.map((entry, index) => `${JSON.stringify(entry.key)}: ns${index}`);
	return [...imports, `export const NAMESPACES = { ${fields.join(", ")} };`].join("\n");
}

/** A plugin serving `source` as the table module, the way the binary build serves it. */
export function tablePlugin(source: string): Bun.BunPlugin {
	return {
		name: "legacy-table-test-table",
		setup(build) {
			build.onResolve({ filter: /^veyyon-legacy-pi-modules$/ }, () => ({
				path: "table",
				namespace: "legacy-table",
			}));
			build.onLoad({ filter: /.*/, namespace: "legacy-table" }, () => ({ contents: source, loader: "ts" }));
		},
	};
}

/**
 * Bundles an entry made of `lines` into one ES module under `dir` and loads it. `virtual` serves
 * module sources by specifier; `table`, when given, serves the table specifier.
 */
export async function bundleEntry(
	dir: string,
	lines: readonly string[],
	virtual: Readonly<Record<string, string>>,
	table?: Bun.BunPlugin,
): Promise<{ text: string; loaded: LoadedBundle }> {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, "entry.ts");
	fs.writeFileSync(entry, `${lines.join("\n")}\n`);
	const plugins: Bun.BunPlugin[] = [];
	const specifiers = Object.keys(virtual);
	if (specifiers.length > 0) {
		const filter = new RegExp(`^(${specifiers.join("|")})$`);
		plugins.push({
			name: "legacy-table-test-virtual",
			setup(build) {
				build.onResolve({ filter }, args => ({ path: args.path, namespace: "legacy-table-test" }));
				build.onLoad({ filter: /.*/, namespace: "legacy-table-test" }, args => ({
					contents: virtual[args.path]!,
					loader: "ts",
				}));
			},
		});
	}
	if (table) plugins.push(table);
	const output = await Bun.build({
		entrypoints: [entry],
		outdir: path.join(dir, "out"),
		target: "bun",
		format: "esm",
		external: [...LEGACY_TABLE_EXTERNAL],
		plugins,
		throw: false,
	});
	if (!output.success) throw new Error(output.logs.map(log => log.message).join("\n"));
	const file = output.outputs.find(artifact => artifact.kind === "entry-point")!.path;
	return { text: fs.readFileSync(file, "utf8"), loaded: (await import(file)) as LoadedBundle };
}

/** The entry lines exporting both the table and the namespaces. */
export const TABLE_AND_NAMESPACES = [
	`export { BUNDLED_PI_MODULES } from "${LEGACY_PI_MODULES_SPECIFIER}";`,
	`export { NAMESPACES } from "${NAMESPACES_SPECIFIER}";`,
];

/**
 * Each key whose record differs from the namespace import of its module, by name set or by value
 * (`Object.is`), described for an assertion message.
 */
export function differingRecords(loaded: LoadedBundle, keys: readonly string[]): string[] {
	const table = loaded.BUNDLED_PI_MODULES!;
	const namespaces = loaded.NAMESPACES!;
	const differing: string[] = [];
	for (const key of keys) {
		const record = table[key]!();
		const namespace = namespaces[key]!;
		const names = Object.keys(namespace).sort();
		const served = Object.keys(record).sort();
		if (served.join("\n") !== names.join("\n")) {
			differing.push(`${key}: serves [${served.join(",")}], a namespace import holds [${names.join(",")}]`);
			continue;
		}
		for (const name of names) {
			if (!Object.is(record[name], namespace[name])) differing.push(`${key}: ${name} is another value`);
		}
	}
	return differing;
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) throw new Error("usage: legacy-module-table.ts <scratch-dir>");
	const entries = await collectBundledPiEntries();
	const { loaded } = await bundleEntry(
		dir,
		TABLE_AND_NAMESPACES,
		{ [NAMESPACES_SPECIFIER]: namespaceSource(entries) },
		await createLegacyPiVirtualModulePlugin(LEGACY_TABLE_EXTERNAL),
	);
	const keys = entries.map(entry => entry.key);
	process.stdout.write(
		JSON.stringify({
			keys: Object.keys(loaded.BUNDLED_PI_MODULES!),
			entries: keys,
			differing: differingRecords(loaded, keys),
		}),
	);
	process.exit(0);
}
