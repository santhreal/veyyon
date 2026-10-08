/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECTS IT CLOSES. `export/share.ts` imported `buildSessionData` from `export/html`, which
 * text-imports the HTML export template, its stylesheet, its viewer script and the 369 KiB React
 * tool renderers. The builtin `/share` command and the interactive command controller import
 * `export/share`, so every interactive session held those strings and the export module's code on
 * its heap (1.9 MiB of heap and extra memory at idle) for an `/export` or `/share` nobody typed.
 * `@veyyon/catalog/models` text-imported the 2.2 MB `models.json`, so every process held the whole
 * catalog as one string after the registry had parsed the providers it needed; it now imports the
 * file by path and reads it when a consumer builds the registry. The composer's emoji table
 * (`emojis.json`) was a JSON module every interactive session parsed and compiled for a `:name`
 * completion most sessions never type; it is read by path on the first shortcode lookup.
 *
 * THE CLASS. A first-party file that is not TypeScript and is larger than 16 KiB (an embedded
 * template, a generated bundle, a data table) is in the import graph of an idle interactive session
 * only when the first frame needs it. That graph is the CLI entry's plus the interactive mode's,
 * which `main.ts` loads through a dynamic import every interactive launch takes. The sweep reads
 * both graphs at run time, so a new asset, or a new static edge to an existing one, turns this red
 * until the list below records it.
 *
 * WHAT IT DOES NOT CATCH. A TypeScript module that inlines a large string literal, a string defined
 * at build time (`the-embedded-docs-reach-the-heap-on-the-first-docs-read` covers the docs index),
 * and an asset a live session loads after startup.
 * The package-level half of the same class is `a-dependency-nobody-reached-does-not-load-at-startup`.
 */
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildStartupImportGraph } from "./helpers/startup-import-graph";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SRC = join(REPO_ROOT, "packages", "coding-agent", "src");
const ENTRIES = [join(SRC, "main.ts"), join(SRC, "modes", "terminal", "interactive-mode.ts")];
const ASSET_LIMIT_BYTES = 16 * 1024;

/**
 * Large non-TypeScript files the first frame reads. `loader-state.js` is the native addon loader;
 * `package.json` supplies the version the banner prints.
 */
const LARGE_ASSETS_AT_STARTUP = [
	"natives/bridge/bindings/native/loader-state.js",
	"packages/coding-agent/package.json",
];

/**
 * Large files the startup graph imports by path and reads on demand: the bundled model catalog and
 * the emoji shortcode table.
 */
const LARGE_ASSETS_BY_PATH = [
	"packages/catalog/src/models.json",
	"packages/coding-agent/src/modes/terminal/data/emojis.json",
];

const graphs = ENTRIES.map(entry => buildStartupImportGraph(REPO_ROOT, entry));
const files = new Set(graphs.flatMap(graph => [...graph.files]));
const byPath = new Set(graphs.flatMap(graph => [...graph.byPath]));

function largeAssets(set: ReadonlySet<string>): string[] {
	return [...set]
		.filter(file => file.startsWith("/") && !/\.tsx?$/.test(file))
		.filter(file => statSync(file).size > ASSET_LIMIT_BYTES)
		.map(file => relative(REPO_ROOT, file))
		.sort();
}

describe("startup import graph assets", () => {
	test("holds no large asset outside the recorded set", () => {
		expect(largeAssets(files)).toEqual(LARGE_ASSETS_AT_STARTUP);
	});

	test("reaches the model catalog and the emoji table by path, not by their contents", () => {
		expect(largeAssets(byPath)).toEqual(LARGE_ASSETS_BY_PATH);
	});

	test("keeps the HTML export template out of a session that never exports", () => {
		const exportDir = join(REPO_ROOT, "packages", "coding-agent", "src", "export", "html");
		const loaded = [...files].filter(file => file.startsWith(`${exportDir}/`)).map(file => relative(REPO_ROOT, file));
		expect(loaded).toEqual([]);
	});

	test("walks both entries to completion", () => {
		for (const graph of graphs) {
			expect(graph.unscannable).toEqual([]);
			expect(graph.files.size).toBeGreaterThan(1_000);
		}
	});
});
