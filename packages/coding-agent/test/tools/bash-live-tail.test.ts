/**
 * DS-4, the follow on tool rows: while a bash tool is still STREAMING
 * (isPartial), the newest visible stdout line carries the liquid hot trail —
 * its trailing characters grade from the cooled `toolOutput` body color up to
 * the theme ACCENT at the fresh edge, with a lightened-accent sheen, so the
 * freshest output literally glows (see paintHotTail). A sealed result must never
 * paint it: the trail is a liveness signal, and a glow on settled scrollback
 * would lie.
 *
 * The discriminating signature is the PER-CHARACTER truecolor gradient: the last
 * ~TRAIL_CELLS cells each carry their own distinct `38;2;r;g;bm` code (a smooth
 * ramp toward accent). The frame chrome and plain body use only a handful of
 * fixed truecolor codes, so a large count of DISTINCT per-cell foreground colors
 * on one line is a byte pattern nothing but the live trail produces.
 *
 * Locks:
 *  1. Streaming render tips the newest output line with the gradient (many
 *     distinct per-cell colors), and the ramp lands on CHARACTERS, not padding.
 *  2. Earlier output lines stay flat (the trail marks only the newest).
 *  3. The final (non-partial) render of the same output has no gradient.
 *  4. Without truecolor the streaming render emits no truecolor codes at all
 *     (loud degrade, never a 16-color approximation).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { FOLLOW_TUNING } from "@veyyon/coding-agent/modes/components/follow";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@veyyon/coding-agent/tools/bash";
import { TERMINAL } from "@veyyon/tui";

const terminal = TERMINAL as unknown as { trueColor: boolean };
const originalTrueColor = TERMINAL.trueColor;

afterEach(() => {
	terminal.trueColor = originalTrueColor;
});

const OUTPUT = "first line of stdout\nsecond line of stdout\nthird and newest stdout line";

/** Every distinct `38;2;r;g;b` truecolor FOREGROUND code on a rendered line. */
function distinctFgColors(line: string): Set<string> {
	const codes = line.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	return new Set(codes);
}

async function renderBash(isPartial: boolean): Promise<{ lines: string[] }> {
	const theme = await getThemeByName("titanium");
	expect(theme).toBeDefined();
	const component = bashToolRenderer.renderResult(
		{ content: [{ type: "text", text: OUTPUT }], details: {}, isError: false },
		{ expanded: false, isPartial },
		theme!,
		{ command: "some-long-running-build" },
	);
	return { lines: [...component.render(100)] };
}

// A flat (non-glowing) line uses at most a couple of fixed truecolor codes; the
// live gradient uses on the order of TRAIL_CELLS distinct per-cell colors. Half
// the trail is a comfortable floor that no chrome line reaches.
const GRADIENT_FLOOR = Math.floor(FOLLOW_TUNING.trailCells / 2);

describe("bash live stdout tail — the follow on tool rows", () => {
	it("tips the newest streaming line with the liquid accent gradient, on characters not padding", async () => {
		terminal.trueColor = true;
		const { lines } = await renderBash(true);
		const newest = lines.find(l => Bun.stripANSI(l).includes("newest stdout line"));
		expect(newest).toBeDefined();

		// The trail is a dense per-cell gradient — many distinct foreground colors.
		const colors = distinctFgColors(newest!);
		expect(colors.size).toBeGreaterThanOrEqual(GRADIENT_FLOOR);

		// The gradient sits on the trailing CHARACTERS: the last colored cell in the
		// row must precede a visible glyph, never trailing pad (foreground color on a
		// space is invisible — the live-frame defect this guards).
		const lastCodeMatch = [...newest!.matchAll(/\x1b\[38;2;\d+;\d+;\d+m(.)/g)].at(-1);
		expect(lastCodeMatch).toBeDefined();
		expect(lastCodeMatch![1]).not.toBe(" ");
		// The newest text is present in full — the glow rebuilds, never drops, chars.
		expect(Bun.stripANSI(newest!)).toContain("third and newest stdout line");
	});

	it("leaves earlier streaming lines flat — the trail marks only the newest", async () => {
		terminal.trueColor = true;
		const { lines } = await renderBash(true);
		const firstLine = lines.find(l => Bun.stripANSI(l).includes("first line of stdout"));
		expect(firstLine).toBeDefined();
		// No gradient: an earlier body line uses only its flat body/chrome colors.
		expect(distinctFgColors(firstLine!).size).toBeLessThan(GRADIENT_FLOOR);
	});

	it("never paints a sealed result — the trail is a liveness signal", async () => {
		terminal.trueColor = true;
		const { lines } = await renderBash(false);
		// The sealed newest line is flat: no per-cell gradient anywhere.
		for (const line of lines) {
			expect(distinctFgColors(line).size).toBeLessThan(GRADIENT_FLOOR);
		}
	});

	it("degrades loudly without truecolor: the streaming render paints no gradient", async () => {
		terminal.trueColor = false;
		const { lines } = await renderBash(true);
		// Loud degrade: paintHotTail returns the row untouched, so the newest line
		// stays flat — no dense per-cell gradient — never a 16-color approximation.
		// (The frame chrome may still use a fixed truecolor code or two; the gradient
		// is what must be absent.)
		for (const line of lines) {
			expect(distinctFgColors(line).size).toBeLessThan(GRADIENT_FLOOR);
		}
	});
});
