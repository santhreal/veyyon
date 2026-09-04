import { describe, expect, it } from "bun:test";
import type { SettingItem } from "@veyyon/tui";
import { filterSettingItems, rankSettingItems } from "@veyyon/tui";

/**
 * What settings search treats as a match, and in what order.
 *
 * Ranking used to concatenate label, id, CURRENT VALUE, description and every
 * enum value into one string and fuzzy-score the blob, which is why settings
 * search ranked badly. Each case below pins
 * one of the specific ways that behaved wrongly, so the blob cannot come back.
 */

const item = (over: Partial<SettingItem> & { id: string; label: string }): SettingItem => ({
	currentValue: "",
	...over,
});

const THEME = item({ id: "theme.dark", label: "Dark Theme", description: "Theme used on a dark terminal" });
const MENTIONS_THEME = item({
	id: "tui.tight",
	label: "Tight Layout",
	description: "Denser spacing; independent of the theme you chose",
});
const EFFORT = item({
	id: "defaultEffort",
	label: "Default Effort",
	group: "Thinking",
	description: "Effort per model, applied when a run does not ask for one",
	keywords: ["thinking", "reasoning"],
});
const SET_TO_HIGH = item({
	id: "compaction.threshold",
	label: "Compaction Threshold",
	currentValue: "high",
	values: ["low", "medium", "high"],
	description: "When to compact",
});

describe("ranking settings for a query", () => {
	it("puts a label match above a setting that only mentions the word", () => {
		// The core complaint: typing a word buried the setting NAMED that word
		// under every setting whose prose happens to contain it.
		const ranked = rankSettingItems([MENTIONS_THEME, THEME], "theme");
		expect(ranked.map(r => r.item.id)).toEqual(["theme.dark", "tui.tight"]);
	});

	it("does not match a setting by its current value", () => {
		// `high` used to match everything currently set to high, so results moved
		// as you changed values and typing a value found unrelated settings.
		expect(filterSettingItems([SET_TO_HIGH], "high")).toEqual([]);
	});

	it("does not match a setting by its enum values", () => {
		// Every boolean-ish setting carries `off`/`false`, so those were matching
		// nearly the whole list.
		expect(filterSettingItems([SET_TO_HIGH], "medium")).toEqual([]);
	});

	it("finds a setting by a word a user would type but the label lacks", () => {
		// "Default Effort" contains neither "thinking" nor "reasoning", the two
		// words people actually search for it by.
		expect(filterSettingItems([THEME, EFFORT], "reasoning").map(i => i.id)).toEqual(["defaultEffort"]);
		expect(filterSettingItems([THEME, EFFORT], "thinking").map(i => i.id)).toEqual(["defaultEffort"]);
	});

	it("ranks a declared synonym above a description hit", () => {
		const withProse = item({
			id: "some.setting",
			label: "Some Setting",
			description: "Adjusts reasoning indirectly in some fashion",
		});
		expect(rankSettingItems([withProse, EFFORT], "reasoning").map(r => r.item.id)).toEqual([
			"defaultEffort",
			"some.setting",
		]);
	});

	it("finds a setting by its group when nothing else carries the word", () => {
		const grouped = item({ id: "x.y", label: "Some Knob", group: "Sampling", description: "no such word here" });
		expect(filterSettingItems([grouped], "sampling").map(i => i.id)).toEqual(["x.y"]);
	});

	it("matches the exact config path a user pasted", () => {
		expect(filterSettingItems([THEME, EFFORT, SET_TO_HIGH], "compaction.threshold").map(i => i.id)).toEqual([
			"compaction.threshold",
		]);
	});

	it("prefers a prefix hit over a mid-string hit", () => {
		// Typing the start of a name is the strongest signal of intent.
		const mid = item({ id: "a.b", label: "Enable Dark Mode Banner" });
		const prefix = item({ id: "c.d", label: "Dark Theme" });
		expect(rankSettingItems([mid, prefix], "dark").map(r => r.item.id)).toEqual(["c.d", "a.b"]);
	});

	it("returns nothing for a punctuation-only query instead of everything", () => {
		// The fuzzy matcher treats such a query as matching all text with score 0,
		// which reported every setting as a match and a count that read like success.
		expect(filterSettingItems([THEME, EFFORT], ".")).toEqual([]);
		expect(filterSettingItems([THEME, EFFORT], "...")).toEqual([]);
		expect(filterSettingItems([THEME, EFFORT], " ")).toEqual([]);
	});

	it("drops heading rows, which are chrome rather than settings", () => {
		// A matched heading would strand a section label with no rows beneath it,
		// and headings are not selectable, so a "match" you cannot open is a lie.
		const heading = item({ id: "__tab:model", label: "Model", heading: true });
		expect(filterSettingItems([heading, EFFORT], "model").map(i => i.id)).toEqual(["defaultEffort"]);
	});

	it("orders ties by label so the list does not reshuffle between renders", () => {
		const b = item({ id: "b", label: "Bravo Setting", description: "zzz" });
		const a = item({ id: "a", label: "Alpha Setting", description: "zzz" });
		expect(rankSettingItems([b, a], "setting").map(r => r.item.label)).toEqual(["Alpha Setting", "Bravo Setting"]);
	});

	it("still matches loosely, so weighting has not become substring-only", () => {
		// Field weighting must not narrow matching itself. `thm` (dropped vowels)
		// and out-of-order words both still reach "Dark Theme", which is what the
		// shared matcher supports; only the ORDER of results changed.
		expect(filterSettingItems([THEME], "thm").map(i => i.id)).toEqual(["theme.dark"]);
		expect(filterSettingItems([THEME], "theme dark").map(i => i.id)).toEqual(["theme.dark"]);
	});
});

describe("multi-word queries", () => {
	const AUTO_COMPACTION = item({
		id: "compaction.threshold",
		label: "Auto-Compaction Threshold",
		group: "Compaction",
		description: "When auto-compaction triggers",
	});
	const SEPARATOR = item({
		id: "statusLine.separator",
		label: "Status Line Separator",
		group: "Status Line",
		description: "Style of separators between segments",
	});

	/**
	 * The query a person types after reading a label. The one-needle scorer
	 * looked for the literal pair "auto compaction" — space included — and the
	 * label "Auto-Compaction Threshold" contains neither, so the exact setting
	 * the user was staring at matched NOTHING.
	 */
	it("matches the hyphenated label its own words suggest", () => {
		expect(filterSettingItems([AUTO_COMPACTION, THEME], "auto compaction").map(i => i.id)).toEqual([
			"compaction.threshold",
		]);
	});

	/**
	 * AND, not OR: every word must match somewhere. `theme separator` names no
	 * setting, and an OR of the words would drown the answer in everything
	 * that matches either half.
	 */
	it("requires every word to match, so unrelated words find nothing", () => {
		expect(filterSettingItems([THEME, SEPARATOR], "theme separator")).toEqual([]);
	});

	/**
	 * Words may land in DIFFERENT fields: `status separator` is a group word
	 * plus a label word. Scoring each word in isolation is what lets a query
	 * read the way the settings screen reads.
	 */
	it("lets one word hit the group and another the label", () => {
		expect(filterSettingItems([AUTO_COMPACTION, SEPARATOR], "status separator").map(i => i.id)).toEqual([
			"statusLine.separator",
		]);
	});

	/**
	 * Word order carries no meaning in a find box, so it must carry no weight:
	 * `dark theme` and `theme dark` are the same query.
	 */
	it("ranks word orders alike", () => {
		const forward = rankSettingItems([THEME, AUTO_COMPACTION], "dark theme");
		const backward = rankSettingItems([THEME, AUTO_COMPACTION], "theme dark");
		expect(forward.map(r => r.item.id)).toEqual(backward.map(r => r.item.id));
	});

	/**
	 * Stray punctuation between words is not a word: `auto - compaction` is
	 * still the two-word query, not a three-token query whose middle token
	 * matches nothing.
	 */
	it("ignores punctuation-only tokens", () => {
		expect(filterSettingItems([AUTO_COMPACTION], "auto - compaction").map(i => i.id)).toEqual([
			"compaction.threshold",
		]);
	});

	/**
	 * A third of real queries are a pasted pair like `threshold 85` — one word
	 * naming the setting, one naming the state. The value word matches the
	 * description here (never the current value, pinned above), keeping the
	 * setting findable without making values searchable state.
	 */
	it("narrows with each added word instead of broadening", () => {
		const onlyCompaction = rankSettingItems([AUTO_COMPACTION, SEPARATOR, THEME], "compaction");
		const twoWords = rankSettingItems([AUTO_COMPACTION, SEPARATOR, THEME], "compaction threshold");
		expect(twoWords.length).toBeLessThanOrEqual(onlyCompaction.length);
		expect(twoWords[0]?.item.id).toBe("compaction.threshold");
	});
});
