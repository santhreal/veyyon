/**
 * A build-time payload is linked only when it is read.
 *
 * WHY THIS SUITE EXISTS. The release builds replace `process.env.VEYYON_DOCS_EMBED` with the docs
 * index, a 1.4 MB string literal, and Bun's code splitting links a module's chunk when the first module
 * that imports it statically is linked. `internal-urls/router.ts` registers `VeyyonProtocolHandler` for
 * every session, and the handler imported `./docs-index` statically, so every launch linked the
 * payload's chunk for a `veyyon://` URL it never resolved. In the release binary, an idle session five
 * seconds after launch held 0.8 MiB more RSS (median of seven) with the module linked; the JS heap and
 * the RSS after the idle trim were unchanged.
 *
 * THE CLASS. Any product module that imports a payload's reader statically. The payloads are the keys
 * of `buildPayloadDefines()`, the map both release builds spread into `define`, so a new payload is
 * covered without an edit here. A reader is any product module in which the transpiler, given the same
 * define, substitutes the payload. The product is every module the package's `bin` and `main` entries
 * reach through a static or an `import()` edge, across workspace packages. A reader is entered only
 * through `import()`. Reintroducing the handler's static import, a static import from the router, the
 * same import through the `@veyyon/coding-agent/...` alias, and the read moved into a module the router
 * imports each fail here naming the edge.
 *
 * WHAT IT DOES NOT CATCH. A payload define added to a build without `buildPayloadDefines()`; a reader
 * reached only through a specifier the walk cannot resolve; and a static import written below a string
 * containing `/*`, which `moduleSpecifiersIn` reads as a comment. The rule is stricter than the launch
 * graph: a reader imported statically by a module that is itself loaded only through `import()` fails
 * here, although its chunk would not link at launch.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn, resolveModuleSpecifier } from "@veyyon/utils/module-reach";
import { buildPayloadDefines } from "../../scripts/generate-docs-index";
import { RESOLUTION } from "../helpers/module-reach-gate";
import { repoPath, repoRelative } from "./helpers/module-graph";

interface ProductModule {
	/** The file as written, comments included: see {@link readersOf} for why it is not stripped here. */
	source: string;
	staticImports: string[];
}

function entryPoints(): string[] {
	const manifest = JSON.parse(readFileSync(repoPath("packages", "coding-agent", "package.json"), "utf8")) as {
		bin: Record<string, string>;
		main: string;
	};
	return [...Object.values(manifest.bin), manifest.main].map(entry => repoPath("packages", "coding-agent", entry));
}

/** Every module the entries reach through a static or an `import()` edge, with its static edges. */
function productModules(): Map<string, ProductModule> {
	const modules = new Map<string, ProductModule>();
	const pending = entryPoints().map(entry => path.resolve(entry));
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (modules.has(file)) continue;
		const source = readFileSync(file, "utf8");
		const resolve = (specifiers: string[]) =>
			specifiers.flatMap(specifier => resolveModuleSpecifier(file, specifier, RESOLUTION) ?? []);
		const staticImports = resolve(moduleSpecifiersIn(source));
		modules.set(file, { source, staticImports });
		pending.push(...staticImports, ...resolve(dynamicImportSpecifiersIn(source)));
	}
	return modules;
}

/** Text the transpiler substitutes for a payload, which no source file contains. */
const SENTINEL = "__a_build_time_payload__";

/**
 * The product modules where the build replaces `payload`: the transpiler applies the same `define` the
 * release build does, with a sentinel value, and a module reads the payload when the sentinel comes out.
 * A text search on comment-stripped source is not enough: `withoutComments` reads the `/*` in a string
 * such as `"**\/*.md"` as a comment opener and drops the code after it, which hides the read in
 * `internal-urls/docs-index.ts`.
 */
function readersOf(payload: string, modules: Map<string, ProductModule>): Set<string> {
	const transpiler = new Bun.Transpiler({ define: { [payload]: JSON.stringify(SENTINEL) } });
	const readers = new Set<string>();
	for (const [file, module] of modules) {
		const loader = file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : undefined;
		if (loader === undefined || !module.source.includes(payload)) continue;
		if (transpiler.transformSync(module.source, loader).includes(SENTINEL)) readers.add(file);
	}
	return readers;
}

const payloads = Object.keys(await buildPayloadDefines());
const modules = productModules();

describe("a build-time payload is linked only when it is read", () => {
	it("reads every payload somewhere in the product", () => {
		// A walk that resolves no workspace edge stops at the entries and finds no reader of anything.
		expect(modules.size).toBeGreaterThan(1000);
		expect(payloads.length).toBeGreaterThan(0);
		const unread = payloads.filter(payload => readersOf(payload, modules).size === 0);
		expect(unread).toEqual([]);
	});

	it("enters every reader of a payload through import()", () => {
		const staticEdges: string[] = [];
		for (const payload of payloads) {
			const readers = readersOf(payload, modules);
			for (const [file, module] of modules) {
				for (const target of module.staticImports) {
					if (readers.has(target))
						staticEdges.push(`${repoRelative(file)} -> ${repoRelative(target)} (${payload})`);
				}
			}
		}
		expect(staticEdges).toEqual([]);
	});
});
