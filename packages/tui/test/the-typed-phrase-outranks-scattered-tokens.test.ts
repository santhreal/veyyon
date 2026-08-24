/**
 * The typed phrase outranks scattered token hits.
 *
 * WHY THIS SUITE EXISTS. Multi-word settings queries are scored as an AND of
 * per-token bests summed across fields. That rewarded scattering: `compaction
 * model` ranked Compaction Fallback ABOVE Compaction Model, because "model"
 * hit Fallback's keyword at prefix strength while the exact two-word label
 * only summed a prefix token and a substring token. The query a person types
 * after reading a label is that label — the phrase, when one field carries it
 * whole, must beat any field-scattered sum.
 *
 * The guard drives the real rankSettingItems over hand-built items; mutating
 * the phrase path (dropping the min with the whole-query score) restores the
 * inverted order and fails the first test.
 *
 * What this does not catch: interaction with the live settings catalog, which
 * only adds more items to the same comparator.
 */
import { describe, expect, it } from "bun:test";
import type { SettingItem } from "../src/components/settings-list";
import { rankSettingItems } from "../src/components/settings-search";

function item(partial: Partial<SettingItem> & { id: string; label: string }): SettingItem {
	return { currentValue: "", ...partial };
}

describe("settings search phrase ranking", () => {
	it("ranks the exact phrase label above a keyword-scattered match", () => {
		const items = [
			item({ id: "compaction.modelFallbackStrategy", label: "Compaction Fallback", keywords: ["model"] }),
			item({ id: "compaction.model", label: "Compaction Model" }),
		];
		const ranked = rankSettingItems(items, "compaction model");
		expect(ranked.map(result => result.item.id)).toEqual(["compaction.model", "compaction.modelFallbackStrategy"]);
	});

	it("still ranks a strong label hit first when no field carries the phrase", () => {
		const items = [
			item({ id: "a", label: "Auto-Compaction Threshold", description: "When the session compacts" }),
			item({ id: "b", label: "Zebra", description: "auto compaction in prose" }),
		];
		const ranked = rankSettingItems(items, "auto compaction");
		expect(ranked[0]?.item.id).toBe("a");
	});

	it("keeps the every-token-must-match rule", () => {
		const items = [item({ id: "a", label: "Dark Theme" }), item({ id: "b", label: "Light Theme" })];
		const ranked = rankSettingItems(items, "dark theme");
		expect(ranked.map(result => result.item.id)).toEqual(["a"]);
	});

	it("matches a phrase carried by the id, not only the label", () => {
		const items = [
			item({ id: "bash.autoBackground.thresholdMs", label: "Auto-Background After" }),
			item({ id: "other.setting", label: "Something Else", description: "background mention" }),
		];
		const ranked = rankSettingItems(items, "autobackground threshold");
		expect(ranked[0]?.item.id).toBe("bash.autoBackground.thresholdMs");
	});
});
