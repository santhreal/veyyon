/**
 * The theme engine's module-scope state goes back to its process-start values on a settings reset.
 *
 * WHY THIS SUITE EXISTS. `modes/theme/theme` keeps three pieces of ambient state outside the
 * Settings singleton: `currentSymbolPresetOverride`, `currentColorBlindMode` and
 * `markdownMermaidRendering`. `resetSettingsForTest` clears the singleton, so a suite that flipped
 * one of these through the normal product path looked clean and still changed what every later
 * suite in the same process rendered.
 *
 * The failure that produced this suite was a mermaid assertion in
 * `test/modes/components/assistant-message-mermaid.test.ts` that passed alone, passed in its own
 * directory, and failed roughly once per six-hundred-file run with zero box-border rows. The
 * printed render showed the fenced-source fallback (`--<rule>mermaid` plus the verbatim
 * `flowchart TD` lines), not a diagram drawn with the wrong glyphs -- so the renderer had been
 * turned off, not restyled. `test/modes/controllers/selector-prompt-gate-rebuild.test.ts` drives
 * `SelectorController.handleSettingChange("tui.renderMermaid", false)` twice, which is the real
 * product path into `setMarkdownMermaidRendering(false)`, and nothing put it back.
 *
 * That class of bug is invisible to a chunked bisect: it is cumulative rather than order-dependent,
 * so any subset small enough to inspect passes. The fix is a teardown registered by the theme
 * module itself, and these cases are what stop a fourth piece of ambient state from being added
 * without one.
 */
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getMarkdownTheme, setMarkdownMermaidRendering } from "@veyyon/coding-agent/modes/theme/markdown-theme";
import { clearMermaidCache } from "@veyyon/coding-agent/modes/theme/mermaid-cache";
import {
	getColorBlindMode,
	getSymbolPresetOverride,
	initTheme,
	setColorBlindMode,
	setSymbolPreset,
} from "@veyyon/coding-agent/modes/theme/theme";
import { Markdown } from "@veyyon/tui";

const DIAGRAM = "```mermaid\nflowchart TD\n  Start-->Stop\n```";

/** Render the sample diagram exactly as the transcript does, with styling stripped. */
function renderDiagram(): string {
	clearMermaidCache();
	return Bun.stripANSI(new Markdown(DIAGRAM, 0, 0, getMarkdownTheme()).render(80).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
});

describe("theme ambient state after resetSettingsForTest", () => {
	/**
	 * The exact leak behind the flake: rendering off must not survive the reset, or every later
	 * mermaid assertion in the process measures the fenced source instead of a diagram.
	 */
	it("puts mermaid rendering back on", () => {
		setMarkdownMermaidRendering(false);
		const disabled = renderDiagram();
		// Prove the disabled state really is the fallback, so the restored state below is a
		// meaningful comparison rather than two renders that happen to differ.
		expect(disabled).toContain("╴mermaid");
		expect(disabled).toContain("flowchart TD");

		resetSettingsForTest();

		const restored = renderDiagram();
		expect(restored).not.toContain("╴mermaid");
		expect(restored).not.toContain("flowchart TD");
		// The drawn diagram, not the source: a box around the node label. `Start--` is what the
		// vendored renderer makes of this fence, matching `assistant-message-mermaid.test.ts`.
		expect(restored).toContain("┌─");
		expect(restored).toContain("│ Start-- │");
	});

	/**
	 * Restoring the variable alone would leave the memoised `cachedMarkdownTheme` holding a theme
	 * whose `resolveMermaidAscii` is undefined, so the flag would read as restored and the renderer
	 * would still be off. Going through the setter is what drops the cache.
	 */
	it("hands out a markdown theme that can resolve diagrams again", () => {
		setMarkdownMermaidRendering(false);
		expect(getMarkdownTheme().resolveMermaidAscii).toBeUndefined();

		resetSettingsForTest();

		expect(getMarkdownTheme().resolveMermaidAscii).toBeInstanceOf(Function);
	});

	/**
	 * The original member of this class. A suite writing `symbolPreset: "ascii"` made every later
	 * diagram render with `+` and `|`, which reads as a renderer bug rather than as someone else's
	 * leftover setting.
	 */
	it("clears the symbol preset override", async () => {
		await setSymbolPreset("ascii");
		expect(getSymbolPresetOverride()).toBe("ascii");

		resetSettingsForTest();

		expect(getSymbolPresetOverride()).toBeUndefined();
	});

	/** Same class, and colour-blind mode changes every semantic colour the next suite asserts on. */
	it("clears colour-blind mode", async () => {
		await setColorBlindMode(true);
		expect(getColorBlindMode()).toBe(true);

		resetSettingsForTest();

		expect(getColorBlindMode()).toBe(false);
	});

	/**
	 * Two resets in a row must be as safe as one. `afterEach` and `beforeEach` both reset in most
	 * suites, and a teardown that only worked on a transition would leave the second call a no-op
	 * that silently stopped restoring anything.
	 */
	it("is idempotent across repeated resets", async () => {
		setMarkdownMermaidRendering(false);
		await setSymbolPreset("ascii");

		resetSettingsForTest();
		resetSettingsForTest();

		expect(getMarkdownTheme().resolveMermaidAscii).toBeInstanceOf(Function);
		expect(getSymbolPresetOverride()).toBeUndefined();
	});
});
