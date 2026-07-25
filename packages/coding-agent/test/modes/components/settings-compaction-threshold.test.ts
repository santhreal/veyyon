/**
 * The `compaction.threshold` drill-down (Auto / Percent / Tokens) and the
 * "Auto-Compaction Threshold" label.
 *
 * The flat submenu this replaced listed 19 presets of three different
 * semantics in one list, so the mode structure (auto follows the window, a
 * percent scales with it, a token amount is fixed) was invisible unless you
 * read every description. These tests lock the two-level shape: modes on
 * level one with the green check and current amount on the active mode,
 * presets plus Custom on level two, and exact persisted strings
 * (`auto` / `85%` / `200000`) so the session's parser keeps seeing the values
 * it already understands.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getSettingDef } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

function frameText(comp: SettingsSelectorComponent): string {
	return comp.render(120).map(strip).join("\n");
}

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	geometryStub = {
		restore() {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		},
	};
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

function createSelector(onCancel: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel },
	);
}

/** Browse the model tab with the threshold row selected and the drill-down open. */
function openThreshold(): SettingsSelectorComponent {
	const comp = createSelector();
	comp.openTab("model");
	expect(comp.selectSetting("compaction.threshold")).toBe(true);
	comp.handleInput("\n");
	return comp;
}

const DOWN = "\x1b[B";
const ENTER = "\n";
const ESC = "\x1b";

describe("auto-compaction threshold — definition", () => {
	/**
	 * The drill-down is a dedicated widget, not the flat submenu: if it ever
	 * falls back to "submenu" the 19-row mixed-unit list is back and the mode
	 * structure is gone.
	 */
	it("maps compaction.threshold to the compactionThreshold widget with its presets", () => {
		const def = getSettingDef("compaction.threshold");
		expect(def?.type).toBe("compactionThreshold");
		expect(def?.label).toBe("Auto-Compaction Threshold");
		expect(def?.tab).toBe("model");
		expect(def?.group).toBe("Compaction");
		if (def?.type !== "compactionThreshold") throw new Error("unreachable");
		expect(def.options.length).toBeGreaterThan(0);
		expect(def.options.some(option => option.value === "85%")).toBe(true);
		expect(def.options.some(option => option.value === "200000")).toBe(true);
	});
});

describe("auto-compaction threshold — mode view", () => {
	/**
	 * Level one is the three modes, nothing else: the whole point of the
	 * drill-down is that the operator picks a semantics before a number.
	 */
	it("shows Auto, Percent, and Tokens with the check on Auto by default", () => {
		const comp = openThreshold();
		const text = frameText(comp);
		expect(text).toContain("Auto-Compaction Threshold");
		expect(text).toContain("Auto");
		expect(text).toContain("Percent");
		expect(text).toContain("Tokens");
		// No preset values on the mode level: those live one level down.
		expect(text).not.toContain("200k tokens");
		expect(text).not.toContain("Near the context limit");
		// The active mode carries the themed enabled glyph (green check).
		const autoLine = text.split("\n").find(line => line.includes("Auto") && line.includes("context window"));
		expect(autoLine).toBeDefined();
		expect(text.split("\n").some(line => line.includes(theme.status.enabled) && line.includes("Auto"))).toBe(true);
	});

	/**
	 * The operator's question at this row is "what will trigger compaction
	 * right now". The active mode answers it inline: check plus the current
	 * amount in parentheses, so nobody drills down just to read the value.
	 */
	it("marks the active Percent mode with its current amount", () => {
		settings.set("compaction.threshold", "85%");
		const text = frameText(openThreshold());
		expect(text).toContain("(current: 85%)");
		const line = text.split("\n").find(l => l.includes("(current: 85%)"));
		expect(line).toContain("Percent");
		expect(line).toContain(theme.status.enabled);
	});

	it("marks the active Tokens mode with its current amount in short form", () => {
		settings.set("compaction.threshold", "200000");
		const text = frameText(openThreshold());
		expect(text).toContain("(current: 200k)");
		const line = text.split("\n").find(l => l.includes("(current: 200k)"));
		expect(line).toContain("Tokens");
	});

	/**
	 * A hand-edited config can hold garbage. The parser already resolves that
	 * to auto WITH invalidRaw (and the session warns loudly); the mode view
	 * must show the same truth instead of presenting Auto as a calm choice.
	 */
	it("warns when the stored value parses as nothing, with Auto in effect", () => {
		settings.set("compaction.threshold", "garbage");
		const text = frameText(openThreshold());
		expect(text).toContain('"garbage" is not auto, a percent, or a token amount');
	});
});

describe("auto-compaction threshold — value pickers", () => {
	/**
	 * Level two shows only the picked mode's presets. Mixing units again here
	 * would recreate the original flat-list confusion one level down.
	 */
	it("Percent picker lists percents only", () => {
		const comp = openThreshold();
		comp.handleInput(DOWN); // Auto -> Percent
		comp.handleInput(ENTER);
		const text = frameText(comp);
		expect(text).toContain("Auto-Compaction Threshold — Percent");
		expect(text).toContain("85%");
		expect(text).toContain("95%");
		expect(text).not.toContain("200k tokens");
		expect(text).toContain("Custom…");
	});

	it("Tokens picker lists token amounts only", () => {
		settings.set("compaction.threshold", "200000");
		const comp = openThreshold();
		comp.handleInput(ENTER); // Tokens is preselected as the active mode
		const text = frameText(comp);
		expect(text).toContain("Auto-Compaction Threshold — Tokens");
		expect(text).toContain("200k tokens");
		expect(text).toContain("1M tokens");
		expect(text).not.toContain("85%");
	});

	/**
	 * Picking a preset persists the exact stored string the session parser
	 * understands — `80%`, not a label, not an index — and lands back on the
	 * mode view showing the new pick.
	 */
	it("persisting a percent preset writes the raw value and returns to modes", () => {
		const comp = openThreshold();
		comp.handleInput(DOWN);
		comp.handleInput(ENTER); // open Percent picker
		comp.handleInput(DOWN); // 50 -> 60
		comp.handleInput(DOWN); // 60 -> 70
		comp.handleInput(ENTER);
		expect(settings.get("compaction.threshold")).toBe("70%");
		expect(frameText(comp)).toContain("(current: 70%)");
	});

	it("persisting a token preset writes the bare token count", () => {
		const comp = openThreshold();
		comp.handleInput(DOWN);
		comp.handleInput(DOWN); // Auto -> Percent -> Tokens
		comp.handleInput(ENTER); // open Tokens picker (first preset selected)
		comp.handleInput(ENTER); // pick 32000
		expect(settings.get("compaction.threshold")).toBe("32000");
	});

	/**
	 * A stored value no preset spells (hand-edited config, legacy fold-in)
	 * must appear as a checked custom row. Otherwise the picker would show an
	 * unchecked list while compaction actually triggers at the invisible
	 * value — the silent-revert failure mode.
	 */
	it("shows an unpreset stored token amount as a checked custom row", () => {
		settings.set("compaction.threshold", "170000");
		const comp = openThreshold();
		comp.handleInput(ENTER); // Tokens is preselected as the active mode
		const text = frameText(comp);
		expect(text).toContain("170k");
		expect(text).toContain("(custom)");
		const line = text.split("\n").find(l => l.includes("170k"));
		expect(line).toContain(theme.status.enabled);
	});
});

describe("auto-compaction threshold — custom input", () => {
	/** Open the Percent picker's Custom… entry. */
	function openPercentCustom(comp: SettingsSelectorComponent): void {
		comp.handleInput(DOWN);
		comp.handleInput(ENTER); // Percent picker
		// Custom… is the last row: arrow up wraps to it.
		comp.handleInput("\x1b[A");
		comp.handleInput(ENTER);
	}

	/**
	 * Typed percents normalize to the stored form `<n>%` whether or not the
	 * operator typed the sign, so config files stay in one spelling.
	 */
	it("accepts a bare percent and stores the normalized form", () => {
		const comp = openThreshold();
		openPercentCustom(comp);
		comp.handleInput("9");
		comp.handleInput("2");
		comp.handleInput("\r");
		expect(settings.get("compaction.threshold")).toBe("92%");
	});

	it("accepts a percent typed with the sign", () => {
		const comp = openThreshold();
		openPercentCustom(comp);
		for (const ch of "88%") comp.handleInput(ch);
		comp.handleInput("\r");
		expect(settings.get("compaction.threshold")).toBe("88%");
	});

	/**
	 * The resolver clamps percents into 1..99 so a `150%` cannot disable
	 * compaction; the input rejects out-of-range values up front with the fix
	 * in the message, and leaves the stored value untouched.
	 */
	it("rejects an out-of-range percent and persists nothing", () => {
		const comp = openThreshold();
		openPercentCustom(comp);
		for (const ch of "150") comp.handleInput(ch);
		comp.handleInput("\r");
		expect(settings.get("compaction.threshold")).toBe("auto");
		expect(frameText(comp)).toContain("not a whole percent from 1 to 99");
	});

	/**
	 * Token amounts normalize underscores away (the parser accepts `170_000`,
	 * but the canonical stored form is the bare count) and reject non-numbers.
	 */
	it("normalizes an underscored token amount and rejects garbage", () => {
		const comp = openThreshold();
		comp.handleInput(DOWN);
		comp.handleInput(DOWN);
		comp.handleInput(ENTER); // Tokens picker
		comp.handleInput("\x1b[A"); // wrap to Custom…
		comp.handleInput(ENTER);
		for (const ch of "170_000") comp.handleInput(ch);
		comp.handleInput("\r");
		expect(settings.get("compaction.threshold")).toBe("170000");

		// Garbage after a valid pick: error shown, valid value kept. Back on the
		// mode view, Tokens is preselected as the now-active mode.
		comp.handleInput(ENTER);
		comp.handleInput("\x1b[A"); // wrap to Custom…
		comp.handleInput(ENTER);
		for (const ch of "lots") comp.handleInput(ch);
		comp.handleInput("\r");
		expect(settings.get("compaction.threshold")).toBe("170000");
		expect(frameText(comp)).toContain("not a positive token amount");
	});
});

describe("auto-compaction threshold — outer row and escape", () => {
	/**
	 * The collapsed settings row is where the value is read most often. It
	 * shows the short form (`200k`), not the raw stored digits, so scanning
	 * the Compaction group reads like the pickers do.
	 */
	it("shows the short-form value on the outer settings row", () => {
		settings.set("compaction.threshold", "1000000");
		const comp = createSelector();
		comp.openTab("model");
		expect(comp.selectSetting("compaction.threshold")).toBe(true);
		expect(frameText(comp)).toContain("1M");
	});

	/**
	 * Esc peels one level at a time: picker -> modes -> closed. Jumping
	 * straight out would strand the operator who opened the wrong mode.
	 */
	it("Esc peels picker to modes, then modes to the settings list", () => {
		const comp = openThreshold();
		comp.handleInput(DOWN);
		comp.handleInput(ENTER); // Percent picker
		expect(frameText(comp)).toContain("Auto-Compaction Threshold — Percent");
		comp.handleInput(ESC);
		const modes = frameText(comp);
		expect(modes).toContain("Auto-Compaction Threshold");
		expect(modes).not.toContain("— Percent");
		comp.handleInput(ESC);
		const browse = frameText(comp);
		expect(browse).not.toContain("Auto-Compaction Threshold — ");
		// Back on the list: the row itself is visible again with its value.
		expect(browse).toContain("Auto-Compaction Threshold");
	});
});
