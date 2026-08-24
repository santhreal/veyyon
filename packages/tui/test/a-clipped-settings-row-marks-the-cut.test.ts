/**
 * A clipped settings row marks the cut, and the value column never moves.
 *
 * WHY THIS SUITE EXISTS. Two silent-cut defects shipped together in the
 * settings row renderer. A label longer than the 30-column label column was
 * NOT clipped at all — padding(0) let it overflow and shove that one row's
 * value right, so the column every other row aligned to broke wherever a long
 * label sat ("Read Summary Minimum File Length" pushed its value two columns
 * past its siblings). And a value clipped to fit was cut with Ellipsis.Omit —
 * no marker — so `Online (TINY role, else` read as a value that happened to
 * end mid-word; the only way to know text was missing was to already know the
 * value.
 *
 * What this does not catch: ANSI styling of the ellipsis (asserted on plain
 * text), and mouse hit columns, which follow the same widths but are routed
 * elsewhere.
 */
import { describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";

const THEME: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "› ",
	hint: text => text,
};

function renderRows(items: ConstructorParameters<typeof SettingsList>[0], width: number): string[] {
	const list = new SettingsList(
		items,
		25,
		THEME,
		() => {},
		() => {},
		{
			typeToSearch: false,
			hint: "",
			layout: "flat",
			descriptionMode: "none",
		},
	);
	return list.render(width).map(line => line.replace(/\s+$/u, ""));
}

describe("settings row clipping", () => {
	it("clips an over-long label with an ellipsis and keeps the value column aligned", () => {
		const rows = renderRows(
			[
				{ id: "a", label: "Short", currentValue: "1" },
				{ id: "b", label: "A Label That Is Far Too Long For The Column", currentValue: "2" },
				{ id: "c", label: "Also Short", currentValue: "3" },
			],
			60,
		);
		const long = rows.find(line => line.includes("…"));
		expect(long).toBeDefined();
		expect(long).toContain("A Label That Is Far Too Long …");
		// The clipped row's value starts in the same column as its siblings'.
		const columnOf = (line: string, value: string) => line.indexOf(value);
		const short = rows.find(line => line.endsWith("1"));
		const also = rows.find(line => line.endsWith("3"));
		expect(short).toBeDefined();
		expect(also).toBeDefined();
		expect(columnOf(long ?? "", "2")).toBe(columnOf(short ?? "", "1"));
		expect(columnOf(also ?? "", "3")).toBe(columnOf(short ?? "", "1"));
	});

	it("marks a clipped value with an ellipsis instead of cutting it silently", () => {
		const rows = renderRows(
			[{ id: "a", label: "Tiny Model", currentValue: "Online (TINY role, else the first local model)" }],
			46,
		);
		const row = rows.find(line => line.includes("Online"));
		expect(row).toBeDefined();
		expect(row).toContain("…");
		expect(row).not.toContain("first local model");
	});

	it("does not mark values that fit", () => {
		const rows = renderRows([{ id: "a", label: "Kokoro", currentValue: "Kokoro-82M" }], 60);
		const row = rows.find(line => line.includes("Kokoro-82M"));
		expect(row).toBeDefined();
		expect(row).not.toContain("…");
	});
});
