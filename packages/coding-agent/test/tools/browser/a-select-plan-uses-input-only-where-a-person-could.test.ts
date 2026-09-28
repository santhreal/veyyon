/**
 * WHY: `tab.select` plans a person's keys and clicks for a `<select>` and leaves the rest to script.
 * The real-Chromium sweep proves the keys agree with Chromium; it cannot run on macOS, and headless
 * Chromium here has no customizable select, so the planner's decisions for those are pinned here.
 *
 * The contract: a multiple select adds an option with Command on macOS and Control elsewhere; a
 * customizable select, a disabled one, a disabled option and a value no option has are left to the
 * script; the state already asked for plans nothing.
 *
 * What it does not catch: whether Chromium agrees with the planned keys, which the sweep drives.
 */
import { describe, expect, it } from "bun:test";
import { planSelect, type SelectState } from "@veyyon/coding-agent/tools/web/browser/select-keys";

function state(overrides: Partial<SelectState> = {}): SelectState {
	const labels = ["Mint", "Maple", "Moss", "Oak"];
	return {
		isSelect: true,
		multiple: true,
		disabled: false,
		customizable: false,
		open: false,
		focused: false,
		mac: false,
		selectedIndex: -1,
		listCount: labels.length,
		options: labels.map((label, index) => ({
			value: label,
			label,
			disabled: false,
			selected: false,
			listIndex: index,
		})),
		...overrides,
	};
}

describe("a select plan", () => {
	it("adds a multiple select's further options with Control, and with Command on macOS", () => {
		// Nothing selected: the first key searches from the second item, so one "m" reaches Maple.
		expect(planSelect(state(), ["Maple", "Oak"])).toEqual({
			kind: "input",
			keys: "m",
			extra: [3],
			modifier: "Control",
		});
		expect(planSelect(state({ mac: true }), ["Maple", "Oak"])).toEqual({
			kind: "input",
			keys: "m",
			extra: [3],
			modifier: "Meta",
		});
	});

	it("leaves to the script what no person's input reaches", () => {
		expect(planSelect(state({ customizable: true }), ["Oak"]).kind).toBe("script");
		expect(planSelect(state({ disabled: true }), ["Oak"]).kind).toBe("script");
		expect(planSelect(state(), ["Pine"]).kind).toBe("script");
		const withDisabled = state();
		const options = withDisabled.options.map((option, index) =>
			index === 3 ? { ...option, disabled: true } : option,
		);
		expect(planSelect({ ...withDisabled, options }, ["Oak"]).kind).toBe("script");
	});

	it("plans nothing for the selection that is there already", () => {
		const options = state().options.map((option, index) => ({ ...option, selected: index === 1 || index === 3 }));
		expect(planSelect(state({ options, selectedIndex: 1 }), ["Maple", "Oak"])).toEqual({ kind: "done" });
	});
});
