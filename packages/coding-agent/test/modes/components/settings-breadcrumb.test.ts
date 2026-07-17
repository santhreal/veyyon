/**
 * Breadcrumb chrome (`Settings › Label`), column alignment, and Esc-peel
 * depth-polish coverage for the settings ModalShell (Grok settings_modal
 * parity — see docs/internal/design.md).
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

/** SGR left-button press at a 1-based screen row/col. */
function leftClick(row1Based: number, col1Based: number): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

/** SGR pointer motion (no button) at a 1-based screen row/col. */
function motion(row1Based: number, col1Based: number): string {
	return `\x1b[<32;${col1Based};${row1Based}M`;
}

/** The card's top-border row (carries the title/breadcrumb and `[x]` close glyph), stripped of ANSI. */
function titleRow(frame: readonly string[]): { index: number; text: string } {
	const index = frame.findIndex(line => line.includes("[x]"));
	return { index, text: index >= 0 ? strip(frame[index]!) : "" };
}

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(40);
});

function stubStdoutGeometry(rows: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	return {
		restore() {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		},
	};
}

function createSelector(
	onCancel: () => void = () => {},
	requestRender?: () => void,
	providers: string[] = ["alpha"],
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers,
			cwd: process.cwd(),
			requestRender,
		},
		{ onChange: () => {}, onCancel },
	);
}

describe("settings breadcrumb chrome", () => {
	it("shows `Settings › <Label>` on the title row only while a picker sub-pane is open, and clears on Esc", () => {
		const comp = createSelector();
		comp.openTab("memory");
		expect(comp.selectSetting("memory.backend")).toBe(true);

		const browse = titleRow(comp.render(120));
		expect(browse.text).toContain("Settings");
		expect(browse.text).not.toContain("Memory Backend");

		comp.handleInput("\n"); // open the enum picker sub-pane
		const open = titleRow(comp.render(120));
		expect(open.text).toContain("Settings");
		expect(open.text).toContain("Memory Backend");

		comp.handleInput("\x1b"); // peel back to Browse
		const back = titleRow(comp.render(120));
		expect(back.text).toContain("Settings");
		expect(back.text).not.toContain("Memory Backend");
	});

	it("clicking the breadcrumb title peels one sub-pane level back to Browse (not close)", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});
		comp.openTab("memory");
		comp.selectSetting("memory.backend");
		comp.handleInput("\n"); // open sub-pane

		const frame = comp.render(120);
		const { index, text } = titleRow(frame);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(text).toContain("Memory Backend");
		const col = text.indexOf("Settings");
		expect(col).toBeGreaterThanOrEqual(0);

		comp.handleInput(leftClick(index + 1, col + 1));
		expect(cancelCount).toBe(0); // peeled, did not close

		const after = titleRow(comp.render(120));
		expect(after.text).toContain("Settings");
		expect(after.text).not.toContain("Memory Backend");

		// A second click on the (now plain) title in Browse mode is a no-op —
		// the breadcrumb hit-rect only exists while a sub-pane is open.
		comp.handleInput(leftClick(after.index + 1, col + 1));
		expect(cancelCount).toBe(0);
	});

	it("hovering the breadcrumb title requests a re-render (hover affordance) without side effects", () => {
		let renderRequests = 0;
		const comp = createSelector(
			() => {},
			() => {
				renderRequests++;
			},
		);
		comp.openTab("memory");
		comp.selectSetting("memory.backend");
		comp.handleInput("\n");

		const frame = comp.render(120);
		const { index, text } = titleRow(frame);
		const col = text.indexOf("Settings");

		comp.handleInput(motion(index + 1, col + 1));
		expect(renderRequests).toBeGreaterThan(0);
	});

	it("does not paint or hit-test a breadcrumb while browsing at the top level (no sub-pane open)", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});
		const frame = comp.render(120);
		const { index, text } = titleRow(frame);
		expect(text).not.toContain("›");

		// Clicking the plain "Settings" title in Browse mode must not close
		// the modal — only the dedicated `[x]` glyph and footer chips do.
		const col = text.indexOf("Settings");
		comp.handleInput(leftClick(index + 1, col + 1));
		expect(cancelCount).toBe(0);
	});

	it("peels Esc one level at a time through a nested provider text editor before closing", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});
		comp.openTab("providers");
		expect(comp.selectSetting("providers.maxInFlightRequests")).toBe(true);

		// Level 1: open the provider-limits list sub-pane.
		comp.handleInput("\n");
		let rendered = strip(comp.render(120).join("\n"));
		expect(rendered).toContain("Max In-Flight Requests");
		expect(rendered).toContain("alpha");

		// Level 2: drill into the single provider's inline text editor.
		comp.handleInput("\n");
		rendered = strip(comp.render(120).join("\n"));
		expect(rendered).toContain("Enter to save");

		// Esc #1: text editor -> provider list. Selector stays open.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(0);
		rendered = strip(comp.render(120).join("\n"));
		expect(rendered).toContain("Select a provider");

		// Esc #2: provider list -> Browse. Selector stays open.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(0);
		rendered = strip(comp.render(120).join("\n"));
		expect(rendered).toContain("Max In-Flight Requests");
		expect(rendered.toLowerCase()).toContain("esc close");
		expect(rendered.toLowerCase()).not.toContain("esc back");

		// Esc #3: Browse -> close.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});
});

describe("settings column alignment", () => {
	it("right-aligns the value column across rows of differing label length (shared gutter)", () => {
		const comp = createSelector();
		// Wide enough that the pane right of the category sidebar renders both
		// rows inline with untruncated values.
		const rendered = comp.render(120).map(strip);

		const darkThemeLine = rendered.find(line => line.includes("Dark Theme"));
		const hyperlinksLine = rendered.find(line => line.includes("Terminal Hyperlinks"));
		expect(darkThemeLine).toBeDefined();
		expect(hyperlinksLine).toBeDefined();

		// "Dark Theme" (10 cols) and "Terminal Hyperlinks" (19 cols) differ in
		// length, but their default values ("titanium" / "auto") must still
		// land in the same column — proof the label gutter is computed once
		// across every visible row, not per-row.
		const darkThemeValueCol = darkThemeLine!.indexOf("titanium");
		const hyperlinksValueCol = hyperlinksLine!.indexOf("auto");
		expect(darkThemeValueCol).toBeGreaterThan(0);
		expect(darkThemeValueCol).toBe(hyperlinksValueCol);
	});
});
