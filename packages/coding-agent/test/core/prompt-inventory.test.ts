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
import { buildPromptInventory } from "../../scripts/prompt-inventory";

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

	it("reads the shipped system prompt's contract correctly", () => {
		// One known template checked against known values, so the suite fails if
		// the analysis silently degrades to returning nothing for everything —
		// which would satisfy every structural assertion above.
		const entry = inventory.templates.find(t => t.file.endsWith("prompts/session/system-prompt.md"));

		expect(entry).toBeDefined();
		expect(entry?.required).toContain("toolRefs");
		expect(entry?.optional).toContain("secretsEnabled");
		expect(entry?.renderers).toContain("packages/coding-agent/src/system-prompt-builder/default-template.ts");
	});
});
