/**
 * Contracts: the generated mupdf asset module stays typecheckable and uncommittable.
 *
 * `scripts/embed-mupdf-wasm.ts --generate` copies three mupdf runtime files next to
 * `src/utils/mupdf-wasm-embed.ts` and rewrites that module to import them with
 * `with { type: "file" }`; `--reset` restores the placeholder and deletes the copies. Between those
 * two commands the working tree holds a module whose header says "Do not edit or commit", which
 * means it cannot carry its own type declarations and must not be added to git. Both halves failed
 * once, in the same tree:
 *
 * 1. No declarations existed for the three imported assets, so `tsc` reported three errors in the
 *    generated file. The binary build typechecks after generating, so its own gate was the tree that
 *    hit this, and the errors pointed at a file the reader is told not to touch.
 * 2. `.gitignore` covered the 10MB wasm and neither of its two JS siblings, so a broad `git add`
 *    committed 130KB of vendored mupdf into `src/`.
 *
 * These are checks on the PAIRING, not on the copies: they read the generator's own emitted source,
 * so adding a fourth embedded asset without declaring and ignoring it fails here rather than in
 * whichever build next generates.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const GENERATOR = path.join(REPO_ROOT, "packages/coding-agent/scripts/embed-mupdf-wasm.ts");
const DECLARATIONS = path.join(REPO_ROOT, "types/assets/index.d.ts");
const GITIGNORE = path.join(REPO_ROOT, ".gitignore");

/** Every `from "..."` specifier in the generator's `generated` template literal. */
function generatedAssetSpecifiers(): string[] {
	const source = fs.readFileSync(GENERATOR, "utf8");
	const start = source.indexOf("const generated = `");
	expect(start).toBeGreaterThan(-1);
	const template = source.slice(start, source.indexOf("`;", start));
	return [...template.matchAll(/from "(\.[^"]+)" with \{ type: "file" \}/g)].map(match => match[1] as string);
}

/** Every `declare module "..."` pattern in the one ambient declaration file. */
function declaredModulePatterns(): string[] {
	const source = fs.readFileSync(DECLARATIONS, "utf8");
	return [...source.matchAll(/^declare module "([^"]+)"/gm)].map(match => match[1] as string);
}

/**
 * TypeScript's ambient wildcard match: one `*`, standing for any run of characters. Reimplemented
 * rather than approximated with `includes`, because `*.wasm` covering `./mupdf-wasm.wasm` is the
 * exact question and a substring test would also accept a pattern that does not apply.
 */
function patternMatches(pattern: string, specifier: string): boolean {
	const star = pattern.indexOf("*");
	if (star === -1) return pattern === specifier;
	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);
	return (
		specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
	);
}

describe("the generated mupdf asset module", () => {
	/**
	 * Pins the three specifiers by value. The list is what the two checks below are about, so a
	 * generator change that renames or adds one has to be seen here first.
	 */
	it("imports exactly the three mupdf runtime assets, by path", () => {
		expect(generatedAssetSpecifiers()).toEqual([
			"./mupdf-embedded.js",
			"./mupdf-wasm-embedded.js",
			"./mupdf-wasm.wasm",
		]);
	});

	/**
	 * The typecheck half. Each imported asset needs an ambient declaration, because the importing
	 * module is generated and cannot hold one.
	 */
	it("has an ambient declaration covering every asset it imports", () => {
		const patterns = declaredModulePatterns();
		const uncovered = generatedAssetSpecifiers().filter(
			specifier => !patterns.some(pattern => patternMatches(pattern, specifier)),
		);

		expect(uncovered).toEqual([]);
	});

	/**
	 * The declarations resolve to a PATH string, not to file contents: `with { type: "file" }` hands
	 * back the asset's location and `loadEmbeddedMupdfWasm` calls `readFileSync` on it. A declaration
	 * typed as the contents would typecheck and be a lie about what the value holds.
	 */
	it("declares the assets as path strings", () => {
		const source = fs.readFileSync(DECLARATIONS, "utf8");
		for (const pattern of ["*mupdf-embedded.js", "*mupdf-wasm-embedded.js", "*.wasm"]) {
			const start = source.indexOf(`declare module "${pattern}"`);
			expect(start).toBeGreaterThan(-1);
			// Bounded at the block's closing brace. An unbounded slice to end-of-file passes on a
			// NEIGHBOURING block's declaration, which is how a mutation that retyped this one as file
			// contents survived: the assertion was reading the next declaration down.
			const block = source.slice(start, source.indexOf("\n}", start));

			expect(block).toContain("const assetPath: string;");
		}
	});

	/**
	 * The git half. All three copies, so a build that dies between `--generate` and `--reset` cannot
	 * leave a committable asset behind.
	 */
	it("ignores every copy the generator writes into src", () => {
		const ignored = fs.readFileSync(GITIGNORE, "utf8").split("\n");
		for (const asset of ["mupdf-wasm.wasm", "mupdf-embedded.js", "mupdf-wasm-embedded.js"]) {
			expect(ignored).toContain(`packages/coding-agent/src/utils/${asset}`);
		}
	});

	/**
	 * The committed placeholder is the state a source checkout, `bun test` and the npm bundle see, and
	 * it must import no assets at all: mupdf stays external there and is loaded from node_modules.
	 * A placeholder that imported the copies would fail to resolve in every tree that has not run
	 * `--generate`, which is nearly all of them.
	 */
	it("restores a placeholder that imports nothing", () => {
		const source = fs.readFileSync(GENERATOR, "utf8");
		const start = source.indexOf("const placeholder = `");
		expect(start).toBeGreaterThan(-1);
		const placeholder = source.slice(start, source.indexOf("`;", start));

		// Import STATEMENTS, not the phrase: the placeholder's header explains the generated form and
		// quotes `with { type: "file" }` in prose, so a substring check passes only by accident.
		const imports = placeholder.split("\n").filter(line => line.startsWith("import "));

		expect(imports).toEqual([]);
		expect(placeholder).toContain("return undefined;");
	});
});
