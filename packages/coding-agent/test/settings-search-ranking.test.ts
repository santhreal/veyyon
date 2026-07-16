import { describe, expect, it } from "bun:test";
import { SETTING_TABS } from "@veyyon/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/pi-coding-agent/modes/components/settings-defs";
import { fuzzyRank, getSettingItemFilterText, type SettingItem } from "@veyyon/pi-tui";

/**
 * Search over the REAL settings surface, using the same filter text the
 * settings selector feeds to fuzzyRank. Regression for the loose matcher that
 * let the query "theme" hit 121 of ~130 settings (the stopword "the" in nearly
 * every description absorbed the token).
 */
function allSettingItems(): SettingItem[] {
	const items: SettingItem[] = [];
	for (const tab of SETTING_TABS) {
		for (const def of getSettingsForTab(tab)) {
			items.push({
				id: def.path,
				label: def.label,
				description: def.description,
				currentValue: "",
				values: def.type === "enum" ? [...def.values] : undefined,
			});
		}
	}
	return items;
}

describe("settings search ranking", () => {
	it("query 'theme' matches only genuinely theme-related settings, best first", () => {
		const items = allSettingItems();
		expect(items.length).toBeGreaterThan(80);

		const ranked = fuzzyRank(items, "theme", getSettingItemFilterText);
		const ids = ranked.map(r => r.item.id);

		expect(ranked.length).toBeLessThan(20);
		expect(ids.slice(0, 2).sort()).toEqual(["theme.dark", "theme.light"]);
		for (const r of ranked) {
			expect(getSettingItemFilterText(r.item).toLowerCase()).toContain("theme");
		}
	});

	it("query 'model' stays scoped, with literal-model settings ranked on top", () => {
		const items = allSettingItems();
		const ranked = fuzzyRank(items, "model", getSettingItemFilterText);
		expect(ranked.length).toBeLessThan(items.length / 2);
		// Cross-word compact adjacency (e.g. "model" spanning loop.mode's
		// "modeloop…") may admit a few extras, but every top-10 hit must
		// contain the literal word.
		for (const r of ranked.slice(0, 10)) {
			expect(getSettingItemFilterText(r.item).toLowerCase()).toMatch(/model/);
		}
	});
});
