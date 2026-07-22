/**
 * Slash-command category grouping — the approved / menu "grouped by purpose"
 * design. `SlashCommand.category` becomes `AutocompleteItem.group` ONLY while
 * the menu is browsed with no filter; a scored filter interleaves categories,
 * and per-run group headers over a scattered order would fragment into
 * duplicate headers (SelectList renders one header per RUN).
 *
 * Locks:
 *  1. Browse view (bare "/"): items come back category-contiguous, category
 *     order = first appearance in the command list, untagged commands last
 *     with no group at all.
 *  2. Registry order is preserved inside a category (stable partition).
 *  3. Any filter prefix strips groups entirely — ranking stays flat, so the
 *     best match is always the first row regardless of its category.
 *  4. Commands without categories behave exactly as before the feature.
 */
import { describe, expect, it } from "bun:test";
import { CombinedAutocompleteProvider, type SlashCommand } from "@veyyon/tui/autocomplete";

const COMMANDS: SlashCommand[] = [
	{ name: "settings", description: "Open settings menu", category: "setup" },
	{ name: "plan", description: "Enter plan mode", category: "modes" },
	{ name: "model", description: "Switch model", category: "model" },
	{ name: "mystery", description: "No category on purpose" },
	{ name: "statusline", description: "Configure the status line", category: "setup" },
	{ name: "vibe", description: "Enter vibe mode", category: "modes" },
];

async function suggest(commands: SlashCommand[], typed: string, categoryOrder?: readonly string[]) {
	const provider = new CombinedAutocompleteProvider(commands, process.cwd(), { categoryOrder });
	const result = await provider.getSuggestions([typed], 0, typed.length);
	if (!result) throw new Error(`expected suggestions for ${JSON.stringify(typed)}`);
	return result.items;
}

describe("slash-command category grouping", () => {
	it("browse view is category-contiguous in first-appearance order, untagged last", async () => {
		const items = await suggest(COMMANDS, "/");
		expect(items.map(i => i.value)).toEqual(["settings", "statusline", "plan", "vibe", "model", "mystery"]);
		expect(items.map(i => i.group)).toEqual(["setup", "setup", "modes", "modes", "model", undefined]);
	});

	it("preserves registry order inside a category (stable partition)", async () => {
		const items = await suggest(COMMANDS, "/");
		const setup = items.filter(i => i.group === "setup").map(i => i.value);
		expect(setup).toEqual(["settings", "statusline"]);
	});

	it("strips groups the moment a filter prefix exists so ranking stays flat", async () => {
		const items = await suggest(COMMANDS, "/s");
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) expect(item.group).toBeUndefined();
		// Prefix matches outrank subsequence matches regardless of category.
		expect(items[0]?.value).toBe("settings");
	});

	/**
	 * The app can hand the provider a deliberate browse sequence
	 * (categoryOrder) so the menu's shape is a design decision, not a registry
	 * accident. Unlisted categories trail in first-appearance order, and a
	 * filter prefix still ignores the whole mechanism.
	 */
	it("honors a preferred categoryOrder for browsing, unlisted categories trailing", async () => {
		const items = await suggest(COMMANDS, "/", ["model", "modes"]);
		expect(items.map(i => i.group)).toEqual(["model", "modes", "modes", "setup", "setup", undefined]);
		expect(items[0]?.value).toBe("model");
		// Filtering is untouched by the preferred order.
		const filtered = await suggest(COMMANDS, "/s", ["model", "modes"]);
		expect(filtered[0]?.value).toBe("settings");
		for (const item of filtered) expect(item.group).toBeUndefined();
	});

	it("uncategorized command lists render exactly as before the feature", async () => {
		const flat = COMMANDS.map(({ category: _category, ...rest }) => rest);
		const items = await suggest(flat, "/");
		expect(items.map(i => i.value)).toEqual(["settings", "plan", "model", "mystery", "statusline", "vibe"]);
		for (const item of items) expect(item.group).toBeUndefined();
	});
});
