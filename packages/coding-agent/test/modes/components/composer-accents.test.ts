/**
 * resolveComposerAccents — the composer's mode accents as a pure function
 * (ARCH-2, bottom-chrome slice). These tests exist because the DS-6 glyph
 * morph was previously decided inline in interactive-mode and had ZERO
 * byte-level coverage: a regression could swap a mode glyph, drop the bypass
 * precedence, or lose the focused-subagent dim, and nothing would fail. Every
 * mode state is pinned here with exact output bytes, including the precedence
 * order (`/yolo` bypass outranks everything — the operator must never lose
 * sight of a full approval bypass).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	COMPOSER_INSET_COLS,
	type ComposerAccentState,
	resolveComposerAccents,
} from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

const INSET = " ".repeat(COMPOSER_INSET_COLS);

/** The quiet default: no mode, no accent, thinking off. */
function idle(overrides: Partial<ComposerAccentState> = {}): ComposerAccentState {
	return {
		bypass: false,
		bashMode: false,
		pythonMode: false,
		planMode: false,
		focusedSubagent: false,
		sessionAccentAnsi: undefined,
		thinkingLevel: ThinkingLevel.Off,
		...overrides,
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});

describe("resolveComposerAccents — the DS-6 glyph morph", () => {
	/** The default `›` caret carries the theme's borderAccent: a fixed hue,
	 * never activity-tinted. The chrome is silent; motion belongs to content. */
	it("idle: an inset borderAccent › caret and a dim ┆ continuation", () => {
		const a = resolveComposerAccents(idle());
		expect(a.promptGutter).toBe(`${INSET}${theme.getFgAnsi("borderAccent")}›\x1b[39m `);
		expect(a.promptGutterContinuation).toBe(`${INSET}${theme.fg("dim", "┆")} `);
	});

	/** A mode changes the GLYPH, not just the hue, so the state reads even
	 * where color is degraded or the operator is colorblind. */
	it("bash mode morphs the glyph to an amber $", () => {
		const a = resolveComposerAccents(idle({ bashMode: true }));
		expect(a.promptGutter).toBe(`${INSET}${theme.getBashModeBorderColor()("$")} `);
	});

	it("python mode keeps the › but takes the python mode color", () => {
		const a = resolveComposerAccents(idle({ pythonMode: true }));
		expect(a.promptGutter).toBe(`${INSET}${theme.getPythonModeBorderColor()("›")} `);
	});

	it("plan mode morphs the glyph to the modeAccent ◈", () => {
		const a = resolveComposerAccents(idle({ planMode: true }));
		expect(a.promptGutter).toBe(`${INSET}${theme.fg("modeAccent", "◈")} `);
	});

	/** The `/yolo` full bypass is a persistent danger state ("every prompt is
	 * off") and must outrank EVERY other treatment, glyph and border alike. */
	it("bypass outranks bash, python, and plan with the alarm !", () => {
		const a = resolveComposerAccents(idle({ bypass: true, bashMode: true, pythonMode: true, planMode: true }));
		expect(a.promptGutter).toBe(`${INSET}${theme.getBypassModeBorderColor()("!")} `);
		expect(a.borderColor("x")).toBe(theme.getBypassModeBorderColor()("x"));
	});

	it("bash outranks python and plan (mode entry order)", () => {
		const a = resolveComposerAccents(idle({ bashMode: true, pythonMode: true, planMode: true }));
		expect(a.promptGutter).toBe(`${INSET}${theme.getBashModeBorderColor()("$")} `);
	});

	/** A named session keeps its identity accent on the caret; the same ANSI
	 * drives the (hidden) border so both surfaces always agree. */
	it("a session accent colors both the caret and the border", () => {
		const ansi = "\x1b[38;2;10;200;120m";
		const a = resolveComposerAccents(idle({ sessionAccentAnsi: ansi }));
		expect(a.promptGutter).toBe(`${INSET}${ansi}›\x1b[39m `);
		expect(a.borderColor("x")).toBe(`${ansi}x\x1b[39m`);
	});

	/** Plan mode morphs the glyph but the border chain has no plan branch:
	 * with no accent it falls to the thinking-level treatment, exactly as the
	 * inline code always behaved. The extraction must not "fix" this. */
	it("plan mode leaves the border on the thinking-level treatment", () => {
		const a = resolveComposerAccents(idle({ planMode: true, thinkingLevel: ThinkingLevel.High }));
		expect(a.borderColor("x")).toBe(theme.getThinkingBorderColor(ThinkingLevel.High)("x"));
	});
});

describe("resolveComposerAccents — the focused-subagent dim", () => {
	/** A focused subagent view borrows the composer; its chrome faints (SGR 2)
	 * so the borrowed session is visually distinct from the main one. */
	it("wraps both the caret and the border in dim", () => {
		const a = resolveComposerAccents(idle({ focusedSubagent: true }));
		expect(a.promptGutter).toBe(`${INSET}\x1b[2m${theme.getFgAnsi("borderAccent")}›\x1b[39m\x1b[22m `);
		expect(a.borderColor("x")).toBe(`\x1b[2m${theme.getThinkingBorderColor(ThinkingLevel.Off)("x")}\x1b[22m`);
	});

	it("dims the danger states too, without losing their glyphs", () => {
		const a = resolveComposerAccents(idle({ bypass: true, focusedSubagent: true }));
		expect(a.promptGutter).toBe(`${INSET}\x1b[2m${theme.getBypassModeBorderColor()("!")}\x1b[22m `);
	});
});

describe("composer accent wiring (interactive-mode)", () => {
	/** interactive-mode must only SNAPSHOT state and APPLY the result — the
	 * decision lives in the one resolver. Re-inlining any glyph choice there
	 * recreates the untestable duplicate this extraction removed. */
	it("delegates the decision and keeps no inline glyph morph", async () => {
		const src = await Bun.file(new URL("../../../src/modes/interactive-mode.ts", import.meta.url)).text();
		expect(src).toContain("resolveComposerAccents({");
		expect(src).toContain("this.editor.setPromptGutter(accents.promptGutter)");
		expect(src).toContain("this.editor.setPromptGutterContinuation(accents.promptGutterContinuation)");
		// The old inline morphs, banned from the host file.
		expect(src).not.toContain('getBypassModeBorderColor()("!")');
		expect(src).not.toContain('getBashModeBorderColor()("$")');
		expect(src).not.toContain('fg("modeAccent", "◈")');
		// One inset owner: the const moved to composer-chrome.ts.
		expect(src).not.toContain("const COMPOSER_INSET_COLS");
	});
});
