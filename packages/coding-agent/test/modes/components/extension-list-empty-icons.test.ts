/**
 * ExtensionList renders against the real Unicode symbol preset, where the
 * package and tool-kind icons are intentionally empty. Their separator belongs
 * to the icon join, so an empty icon must not indent either label by one cell.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ExtensionList } from "@veyyon/coding-agent/modes/components/extensions/extension-list";
import type { ExtensionRow } from "@veyyon/coding-agent/modes/components/extensions/types";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { createTheme, getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";

const titanium = defaultThemes.titanium as ThemeJson;
const originalTheme = await getThemeByName("dark");
if (!originalTheme) throw new Error("Expected the dark theme fixture");
const extension: ExtensionRow = {
	id: "tool:reader",
	kind: "tool",
	name: "reader",
	displayName: "Reader",
	path: "/tmp/reader.ts",
	source: { provider: "acme", providerName: "Acme", level: "project" },
	state: "active",
	raw: {},
};

beforeAll(() => {
	setThemeInstance(createTheme(titanium, { mode: "truecolor", symbolPresetOverride: "unicode" }));
});

afterAll(() => {
	setThemeInstance(originalTheme);
});

describe("ExtensionList empty Unicode icons", () => {
	/** Empty preset icons must not leave an icon-owned separator before either label. */
	it("renders kind and master labels without the missing icon's gap", () => {
		const grouped = new ExtensionList([extension]);
		const groupedLines = grouped.render(80).map(line => Bun.stripANSI(line));
		const kindHeader = groupedLines.find(line => line.includes("Tools"));

		expect(kindHeader).toBe("Tools (1)");

		const provider = new ExtensionList([extension], { masterSwitchProvider: "acme" });
		const providerLines = provider.render(80).map(line => Bun.stripANSI(line));
		const master = providerLines.find(line => line.includes("Master Switch"));

		expect(master).toMatch(/^\S+ Enable Acme {2}\(Master Switch\)$/);
		expect(master).not.toContain("  Enable Acme");
	});
});
