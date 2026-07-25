/**
 * The documented-import gate: every named import from a `@veyyon/*` package that
 * appears in a README, a doc page, or an example must actually be exported.
 *
 * Why this suite exists: `getModel`/`getModels`/`getProviders` were renamed to
 * `getBundledModel`/`getBundledModels`/`getBundledProviders` and moved from
 * `@veyyon/ai` to `@veyyon/catalog`. The CHANGELOGs recorded it. The docs did
 * not: `packages/ai/README.md` taught the old import about thirty times, its
 * quick start's FIRST line among them, and `"getModel" in await
 * import("@veyyon/ai")` is `false`. `packages/agent/README.md` opened with
 * `import { Agent } from "@veyyon/agent"` while the package is named
 * `@veyyon/agent-core`. `packages/tui/README.md` documented thirty-four key
 * helpers (`isEnter`, `isCtrlC`, …) that do not exist under any name — the real
 * API is `matchesKey(data, Key.enter)`. Fifteen hook examples annotated their
 * default export with `HookAPI` imported from `@veyyon/coding-agent`, which had
 * stopped exporting it: the barrel still carried the comment
 * `// Hook system types (legacy re-export)` with the export line deleted under
 * it. Sixty-nine broken imports in total, none of which any gate could see,
 * because no gate read the code inside a fenced block.
 *
 * The tests below pin the parts that were subtly wrong while the gate was being
 * built (a lazy multi-line clause swallowing a whole file, `export *` hops
 * between packages) and end with a lock on the real repository.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "../packages/utils/src/temp";
import { checkDocImports, documentationFiles, fencedOnly, lineAt, parseImportedNames } from "./check-doc-imports";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

describe("parseImportedNames", () => {
	/** The name the MODULE must export is the one before `as`; the local alias is
	 *  the reader's business, not the module's. */
	it("takes the exported name, not the local alias", () => {
		expect(parseImportedNames("getBundledModel as getModel, stream")).toEqual(["getBundledModel", "stream"]);
	});

	/** `import { type Foo, bar }` is one clause with a type in it. Keeping the
	 *  `type` keyword in the name would make every such import unresolvable. */
	it("strips an inline type keyword", () => {
		expect(parseImportedNames("type OAuthProvider, refreshOAuthToken")).toEqual([
			"OAuthProvider",
			"refreshOAuthToken",
		]);
	});

	/**
	 * Documented clauses annotate their entries. `packages/ai/README.md` had
	 * `refreshOAuthToken, // (provider, credentials) => new credentials`, and
	 * reading the comment as names produced findings like "exports no `provider`".
	 */
	it("ignores // comments inside the clause", () => {
		const clause = "\n\trefreshOAuthToken, // (provider, credentials) => new credentials\n\tgetOAuthApiKey,\n";

		expect(parseImportedNames(clause)).toEqual(["refreshOAuthToken", "getOAuthApiKey"]);
	});

	it("returns nothing for an empty clause", () => {
		expect(parseImportedNames("   \n  ")).toEqual([]);
	});
});

describe("fencedOnly", () => {
	/** Prose that MENTIONS an import must not be scanned: this gate's own
	 *  documentation quotes the broken form it exists to prevent. */
	it("keeps fenced lines and blanks prose", () => {
		const markdown = [
			'the old `import { getModel } from "@veyyon/ai"` form',
			"```ts",
			'import { stream } from "@veyyon/ai";',
			"```",
			"trailing prose",
		].join("\n");

		expect(fencedOnly(markdown).trim()).toBe('import { stream } from "@veyyon/ai";');
	});

	/** Line numbers must survive the blanking, or every finding points at the
	 *  wrong line and the report is useless. */
	it("preserves line numbers", () => {
		const markdown = ["prose", "```ts", 'import { stream } from "@veyyon/ai";', "```"].join("\n");
		const masked = fencedOnly(markdown);

		expect(lineAt(masked, masked.indexOf("import"))).toBe(3);
	});

	it("handles tilde fences as well as backticks", () => {
		const markdown = ["~~~ts", 'import { stream } from "@veyyon/ai";', "~~~"].join("\n");

		expect(fencedOnly(markdown).trim()).toBe('import { stream } from "@veyyon/ai";');
	});
});

/** Writes a throwaway repo-shaped tree so the checker can be driven on exact input. */
async function withFixture(
	files: Record<string, string>,
	run: (repoRoot: string, rel: string[]) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@veyyon-doc-imports-");
	const root = tempDir.path();
	// A minimal `packages/` so package-name resolution has something real to read.
	// `@veyyon/utils` is used as the subject because it is loadable from here.
	fs.mkdirSync(path.join(root, "packages", "utils"), { recursive: true });
	fs.writeFileSync(path.join(root, "packages", "utils", "package.json"), JSON.stringify({ name: "@veyyon/utils" }));
	fs.mkdirSync(path.join(root, "packages", "utils", "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "packages", "utils", "src", "types.ts"), "export interface OnlyAType { a: 1 }\n");
	for (const [rel, contents] of Object.entries(files)) {
		fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), contents);
	}
	await run(root, Object.keys(files));
}

describe("checkDocImports", () => {
	/** THE contract: a documented name the package does not export is a finding,
	 *  with the file and the line, and a real export beside it is not. */
	it("reports a missing export and passes a real one", async () => {
		await withFixture(
			{
				"docs/x.md": ["```ts", 'import { collapseWhitespace, getModel } from "@veyyon/utils";', "```"].join("\n"),
			},
			async (root, rel) => {
				const result = await checkDocImports(root, rel);

				expect(result.bad).toEqual([
					{
						file: "docs/x.md",
						line: 2,
						specifier: "@veyyon/utils",
						name: "getModel",
						reason: "@veyyon/utils exports no `getModel` (neither a runtime export nor a declared type)",
					},
				]);
				expect(result.importsChecked).toBe(2);
			},
		);
	});

	/**
	 * A type has no runtime existence, so it can only be found in the sources. A
	 * gate that flagged every documented type import would be turned off within a
	 * day.
	 */
	it("accepts a type-only export found in the package sources", async () => {
		await withFixture(
			{ "docs/x.md": ["```ts", 'import type { OnlyAType } from "@veyyon/utils";', "```"].join("\n") },
			async (root, rel) => {
				expect((await checkDocImports(root, rel)).bad).toEqual([]);
			},
		);
	});

	/**
	 * The regression that made the gate cry wolf: the multi-line clause pattern is
	 * lazy, so it ran from a RELATIVE import's `{` to the next `@veyyon/...`
	 * specifier further down and reported every name in between.
	 * `docs/internal/testing.md` produced 32 findings that way, all of them names
	 * from an unrelated block.
	 */
	it("does not let a clause span past an intervening import", async () => {
		await withFixture(
			{
				"docs/x.md": [
					"```ts",
					'import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";',
					"",
					'import { collapseWhitespace } from "@veyyon/utils";',
					"```",
				].join("\n"),
			},
			async (root, rel) => {
				expect((await checkDocImports(root, rel)).bad).toEqual([]);
			},
		);
	});

	/**
	 * The case a line-anchored pattern missed entirely: nineteen of the twenty
	 * names in `packages/ai/README.md`'s OAuth block were invisible, and only the
	 * one-line import twenty lines below it was reported.
	 */
	it("reads a clause that spans many lines", async () => {
		await withFixture(
			{
				"docs/x.md": [
					"```ts",
					"import {",
					"\tcollapseWhitespace,",
					"\tloginNoSuchProvider,",
					'} from "@veyyon/utils";',
					"```",
				].join("\n"),
			},
			async (root, rel) => {
				const result = await checkDocImports(root, rel);

				expect(result.bad.map(b => b.name)).toEqual(["loginNoSuchProvider"]);
				expect(result.bad[0].line).toBe(2);
			},
		);
	});

	/**
	 * A specifier naming no package at all is a finding, not a note. The
	 * `@veyyon/agent` case sat in the "reported but passing" bucket while every
	 * snippet in that README was unresolvable.
	 */
	it("fails on a @veyyon package that does not exist", async () => {
		await withFixture(
			{ "docs/x.md": ["```ts", 'import { Agent } from "@veyyon/nonexistent";', "```"].join("\n") },
			async (root, rel) => {
				const result = await checkDocImports(root, rel);

				expect(result.unknownPackages).toEqual(["@veyyon/nonexistent"]);
				expect(result.bad).toHaveLength(1);
				expect(result.bad[0].reason).toContain("no package under packages/ is named `@veyyon/nonexistent`");
			},
		);
	});

	/** Non-`@veyyon` imports are out of scope: this gate cannot verify npm. */
	it("ignores third-party and relative imports", async () => {
		await withFixture(
			{
				"docs/x.md": ["```ts", 'import { z } from "zod";', 'import { thing } from "./local";', "```"].join("\n"),
			},
			async (root, rel) => {
				const result = await checkDocImports(root, rel);

				expect(result.bad).toEqual([]);
				expect(result.importsChecked).toBe(0);
			},
		);
	});

	/** An example source file is scanned whole, not just its fenced blocks —
	 *  there are none. `02-custom-model.ts` was broken this way. */
	it("scans example sources without needing fences", async () => {
		await withFixture(
			{ "packages/utils/examples/demo.ts": 'import { getModel } from "@veyyon/utils";\n' },
			async (root, rel) => {
				expect((await checkDocImports(root, rel)).bad.map(b => b.name)).toEqual(["getModel"]);
			},
		);
	});
});

describe("documentationFiles", () => {
	/** The gate must cover the surfaces the breakage was on: package READMEs, doc
	 *  pages, and runnable examples. */
	it("includes package READMEs, docs pages, and example sources", () => {
		const files = documentationFiles(REPO_ROOT);

		expect(files).toContain("packages/ai/README.md");
		expect(files).toContain("docs/internal/testing.md");
		expect(files).toContain("packages/coding-agent/examples/sdk/02-custom-model.ts");
	});

	/** CHANGELOGs name old APIs on purpose — that is what a changelog is for. */
	it("excludes CHANGELOGs and vendored trees", () => {
		const files = documentationFiles(REPO_ROOT);

		expect(files.some(f => f.endsWith("CHANGELOG.md"))).toBe(false);
		expect(files.some(f => f.includes("node_modules/") || f.includes("repo-cache/"))).toBe(false);
	});
});

describe("the repository's own documentation", () => {
	/**
	 * The lock. Every documented `@veyyon/*` import in the tree resolves to
	 * something that exists — which was false for sixty-nine of them when this
	 * gate was written.
	 */
	it("documents only imports that exist", async () => {
		const result = await checkDocImports(REPO_ROOT);

		expect(result.bad.map(b => `${b.file}:${b.line} ${b.specifier} -> ${b.name}`)).toEqual([]);
		// And it actually looked at a meaningful amount of documentation.
		expect(result.importsChecked).toBeGreaterThan(200);
	}, 120_000);
});
