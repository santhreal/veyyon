/**
 * ExtensionList renders against the real Unicode symbol preset, where the
 * package and tool-kind icons are intentionally empty. Their separator belongs
 * to the icon join, so an empty icon must not indent either label by one cell.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionKind, ExtensionRow } from "@veyyon/coding-agent/extensibility/extension-state/types";
import { ExtensionList } from "@veyyon/coding-agent/modes/terminal/components/extensions/extension-list";
import type { ThemeJson } from "@veyyon/coding-agent/theme/color";
import { getDefaultThemes } from "@veyyon/coding-agent/theme/defaults";
import { createTheme, getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";

const titanium = getDefaultThemes().titanium as ThemeJson;
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

	// Every kind must retain its list label when display names are shared with the
	// sidebar; Commands and Context intentionally use shorter labels in the list.
	// The record requires a label decision when ExtensionKind gains a member.
	const labels: Record<ExtensionKind, string> = {
		"extension-module": "Extension Modules",
		skill: "Skills",
		rule: "Rules",
		tool: "Tools",
		mcp: "MCP Servers",
		prompt: "Prompts",
		instruction: "Instructions",
		"context-file": "Context",
		hook: "Hooks",
		"slash-command": "Commands",
	};
	for (const [kind, label] of Object.entries(labels)) {
		it(`preserves the ${kind} group label`, () => {
			const grouped = new ExtensionList([{ ...extension, kind: kind as ExtensionKind }]);
			const rows = grouped.render(80).map(stripVTControlCharacters);
			expect(rows.filter(row => row.replace(/^[^A-Za-z]*/, "") === `${label} (1)`)).toHaveLength(1);
		});
	}
});
