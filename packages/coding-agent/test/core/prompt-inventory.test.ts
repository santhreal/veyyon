/**
 * SYSPROMPT-5: the set of prompt templates must be knowable, and checked.
 *
 * There are 175 prompt files across five directories and around a hundred
 * modules that import one. Every file was referenced by something, but nothing
 * stated what the set WAS — which prompt a file contributes to, what renders
 * it, what variables it takes, or whether it is live at all. The section
 * registry is self-describing for its nine sections; everything else was
 * discoverable only by grep, which is why a variable rename could not be
 * checked against its callers and why the silent-hole defect (SYSPROMPT-1) was
 * hard to reason about in the first place.
 *
 * The inventory is generated rather than written down, because a hand-kept list
 * would be wrong within a week and would then be worse than nothing: it would
 * look authoritative while being stale. What a generated inventory buys, and
 * what these tests enforce, is that two whole classes of rot become impossible
 * to land quietly:
 *
 *   - A template with no module that renders it. Either dead bytes shipped in
 *     the binary, or wiring that was removed and left the file behind.
 *   - An import naming a template that does not exist. This one is worse than
 *     it sounds: with `with { type: "text" }` imports the failure surfaces at
 *     load time in whichever code path first touches that module, which can be
 *     a rarely-taken one.
 *
 * The test asserts EMPTY sets rather than a snapshot count, so adding a prompt
 * is never a test failure and removing a renderer always is.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildPromptInventory, REGISTRY_LOOKUP } from "../../scripts/prompt-inventory";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const inventory = await buildPromptInventory(REPO_ROOT);

describe("every prompt template is wired to something", () => {
	it("has no template that no module imports", () => {
		// Listed by name rather than counted, so a failure says which file to fix.
		expect(inventory.orphans).toEqual([]);
	});

	it("has no template that only a test renders", () => {
		// Passes the reference check and is still dead in production: nothing on a
		// real path renders it. Usually a production caller that was deleted and
		// left its test behind.
		expect(inventory.testOnly).toEqual([]);
	});

	it("has no import naming a template that is not there", () => {
		// These fail at module load in whatever path first touches the importer,
		// which can be a rare one, so a missing file can sit unnoticed.
		expect(inventory.danglingReferences).toEqual([]);
	});
});

describe("the inventory describes what it found", () => {
	it("covers every prompts directory rather than one of them", () => {
		// A scan silently narrowed to a single directory would report zero orphans
		// for the trivial reason that it looked almost nowhere.
		const dirs = new Set(inventory.templates.map(entry => path.dirname(entry.file).split("/prompts")[0]));

		expect(dirs.size).toBeGreaterThan(1);
		expect(inventory.templates.length).toBeGreaterThan(150);
	});

	it("records a variable contract for each template", () => {
		// The contract is what makes a rename checkable against callers. Required
		// and optional must both be present, even when empty.
		for (const entry of inventory.templates) {
			expect(Array.isArray(entry.required)).toBe(true);
			expect(Array.isArray(entry.optional)).toBe(true);
		}
	});

	it("never lists a name as both required and optional", () => {
		// The two sets answer one question about one name. Overlap would mean the
		// analyzer disagreed with itself and the contract could not be trusted.
		for (const entry of inventory.templates) {
			const optional = new Set(entry.optional);
			for (const name of entry.required) expect(optional.has(name)).toBe(false);
		}
	});

	/**
	 * The zero-prose outer template must expose exactly its structural slot.
	 * Statement files are inventoried separately and own all prompt variables.
	 */
	it("reads the modular system prompt scaffold contract correctly", () => {
		const entry = inventory.templates.find(template => template.file.endsWith("prompts/session/system-prompt.md"));

		expect(entry).toBeDefined();
		expect(entry?.required).toEqual(["templateSections"]);
		expect(entry?.optional).toEqual([]);
		expect(entry?.renderers).toContain("packages/coding-agent/src/system-prompt-builder/default-template.ts");
	});
});

/**
 * The pattern that finds a registry lookup has to match EVERY registry's table.
 *
 * WHY THIS EXISTS. The inventory finds a template's renderers by matching a registry table
 * indexed by an id string in every source file, and the pattern named exactly two tables
 * (`PROMPTS|AGENT_PROMPTS`). Three more registries shipped, so their templates were
 * reported as rendered only by their own registry module, which is the inventory quietly
 * answering a narrower question than the one it claims to answer. Generalising it then
 * introduced the opposite bug: written `[A-Z][A-Z_]*PROMPTS` the greedy class eats the
 * letters the literal needs, so the bare `PROMPTS` stopped matching and 189 call sites
 * disappeared at once. Only a pinned assertion elsewhere caught that.
 *
 * Both failure directions are covered: every table name in use must match, and a name that
 * is not a registry table must not.
 *
 * EVERY SAMPLE IS BUILT, never written as a literal, and the prose above avoids spelling
 * one out. The inventory scans this file too, and it reads raw text rather than parsing, so
 * a written-out lookup anywhere in it -- including inside a comment -- is read as a real
 * call site and reported as an import naming a template that does not exist. Composing each
 * sample keeps the fixture out of the corpus it is testing.
 */
describe("the registry-lookup pattern", () => {
	/** A lookup as a module would write it, composed so no literal lands in this file. */
	const lookup = (table: string, id: string, gap = ""): string => `${table}[${gap}${JSON.stringify(id)}${gap}]`;

	/** A fresh regex per call: a `g` pattern carries `lastIndex` between uses. */
	const idsIn = (source: string): string[] =>
		[...source.matchAll(new RegExp(REGISTRY_LOOKUP))].map(match => match[1] as string);

	it.each(["PROMPTS", "AGENT_PROMPTS", "AI_PROMPTS", "HASHLINE_PROMPTS", "EDIT_BENCHMARK_PROMPTS"])(
		"matches a lookup against %s and captures the id, not the table name",
		table => {
			// The capture is what resolves back to a file, so a group that drifted onto the
			// table name would make every renderer resolve to nothing.
			expect(idsIn(lookup(table, "dialect/pi-native"))).toEqual(["dialect/pi-native"]);
		},
	);

	it("tolerates whitespace inside the brackets, which the formatter can introduce", () => {
		expect(idsIn(lookup("PROMPTS", "titles/system", "\n\t"))).toEqual(["titles/system"]);
	});

	it("does not match something that is not a registry table", () => {
		// A SCREAMING_CASE prefix has to end at `_PROMPTS`, and a camelCase name has to BE one of
		// the row tables that exist. `userPrompts` is the case that matters: it is a plausible local
		// variable, and accepting every `\w*Prompts` would record whatever string it is indexed by as
		// a template, which then surfaces as an import naming a file that is not there.
		for (const table of ["userPrompts", "MCPPROMPTSCACHE", "prompts", "somePROMPTS", "myToolsPrompts"]) {
			expect(idsIn(lookup(table, "a/b")), table).toEqual([]);
		}
	});

	it("matches every per-directory row table that exists on disk", async () => {
		// The coding agent's registry aggregates one row module per prompt directory, and a consumer
		// indexes that module's table (`toolsPrompts["tools/read"]`) instead of the whole registry. A
		// pattern that accepted only SCREAMING_CASE stopped seeing all 95 of those modules at once,
		// and the inventory then reported the system prompt as rendered by its own row module and two
		// tests. Read off the row modules rather than off the pattern's own source, so this asserts
		// against the repository rather than against itself.
		const tables: string[] = [];
		for await (const relative of new Bun.Glob("*/rows.ts").scan({
			cwd: path.join(REPO_ROOT, "packages/coding-agent/src/prompts"),
			onlyFiles: true,
		})) {
			const text = await Bun.file(path.join(REPO_ROOT, "packages/coding-agent/src/prompts", relative)).text();
			const declared = text.match(/^export const (\w+) = \{$/m);

			expect(declared, `${relative} declares no row table`).not.toBeNull();
			tables.push((declared as RegExpMatchArray)[1] as string);
		}

		expect(tables.length).toBeGreaterThanOrEqual(21);
		for (const table of tables) {
			expect(idsIn(lookup(table, "some/id")), `${table} is a row table the pattern does not match`).toEqual([
				"some/id",
			]);
		}
	});

	it("does not match a property access, which names no id at all", () => {
		expect(idsIn("PROMPTS.text")).toEqual([]);
		expect(idsIn("PROMPTS[id]")).toEqual([]);
	});

	it("finds every table name that is actually in use in the repository", async () => {
		// The anti-staleness check, stated against the source rather than a list here. Any
		// registry table a module really indexes has to be a name this pattern accepts,
		// so a sixth registry cannot ship and be silently skipped.
		// Written with the prefix OPTIONAL and `_`-separated for the same reason the
		// pattern under test is: `[A-Za-z_][A-Za-z_]*PROMPTS` requires a character before
		// the literal, so it silently skips the bare `PROMPTS` -- which is the table with
		// 189 call sites. Getting this wrong here would have made the check pass while
		// looking at three names out of five.
		// Deliberately WIDER than the pattern under test, in both spellings: it has to find a table the
		// pattern would miss, which is the only way this check can fail for the right reason. A scan
		// restricted to SCREAMING_CASE passed while twenty-one camelCase row tables went unmatched.
		const anyTable = /\b(?:[A-Za-z_][A-Za-z_]*_)?PROMPTS\[\s*"|\b\w*Prompts\[\s*"/g;
		const inUse = new Set<string>();
		for await (const relative of new Bun.Glob("packages/**/*.ts").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
			if (relative.includes("node_modules") || relative.includes("repo-cache")) continue;
			const text = await Bun.file(path.join(REPO_ROOT, relative)).text();
			for (const match of text.matchAll(anyTable)) inUse.add(match[0].slice(0, match[0].indexOf("[")));
		}

		expect(inUse.size).toBeGreaterThan(3);
		for (const table of inUse) {
			expect(idsIn(lookup(table, "some/id")), `${table} is used but the pattern does not match it`).toEqual([
				"some/id",
			]);
		}
	});
});
