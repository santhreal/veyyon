import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { cardBox } from "@veyyon/coding-agent/modes/components/overlay-box";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

/**
 * The Plugins tab renders `PluginSettingsComponent` (and its child list/detail
 * views) directly into the shared Settings ModalShell body. Those child
 * components used to wrap themselves in a `DynamicBorder` top/bottom sandwich
 * — chrome left over from before the settings panel had its own ModalShell
 * card, which painted a redundant horizontal rule nested inside the outer
 * card border. Guard against that regressing.
 */
describe("Settings → Plugins tab body", () => {
	it("does not paint a DynamicBorder-style rule line nested inside the ModalShell card", async () => {
		const comp = createSelector();
		comp.openTab("plugins");

		// The plugin list mounts asynchronously (npm + marketplace listing).
		let rendered = "";
		for (let i = 0; i < 200; i++) {
			rendered = strip(comp.render(120).join("\n"));
			// Wait for the async npm+marketplace listing to mount the plugin view
			// itself, not just the always-present "Plugins" tab-bar label or the
			// card's own close glyph (present from the very first render).
			if (
				rendered.includes("No plugins installed") ||
				rendered.includes("npm]") ||
				rendered.includes("marketplace]")
			) {
				break;
			}
			await Bun.sleep(2);
		}

		const lines = rendered.split("\n");
		// A residual `new DynamicBorder()` line embedded in the body renders as a bare horizontal rule
		// between the card's two verticals. So does the shell's OWN section rule now that a rule is
		// inset rather than welded into the frame with `├`/`┤`, so the shape of the line no longer
		// tells the two apart: the position does. The shell draws exactly two, one closing the search
		// band at the top and one opening the footer band at the bottom, and a rule anywhere between
		// the body's first and last content row is the defect this suite exists for.
		const ruleRows = lines.flatMap((line, row) => (/│\s*─{3,}\s*│/.test(line) ? [row] : []));
		const searchRow = lines.findIndex(line => line.includes("search settings"));
		const bodyLastRow = lines.findLastIndex(line => line.includes("Install npm plugins:"));

		expect(searchRow).toBeGreaterThan(0);
		expect(bodyLastRow).toBeGreaterThan(searchRow);
		expect(ruleRows).toHaveLength(2);
		expect(ruleRows[0]).toBe(searchRow + 1);
		expect(ruleRows[1]).toBeGreaterThan(bodyLastRow);

		// The card chrome (single top border, single bottom border) still paints
		// exactly once — this isn't just an empty/blank render.
		expect(
			lines.filter(line => line.includes(cardBox(theme).topLeft) && line.includes(cardBox(theme).topRight)),
		).toHaveLength(1);
		expect(
			lines.filter(line => line.includes(cardBox(theme).bottomLeft) && line.includes(cardBox(theme).bottomRight)),
		).toHaveLength(1);
	});
});
