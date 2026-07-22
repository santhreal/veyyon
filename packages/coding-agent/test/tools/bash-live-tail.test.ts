/**
 * DS-4, the follow on tool rows: while a bash tool is still STREAMING
 * (isPartial), the newest visible stdout line carries the hot trail —
 * trailing cells grading from toolOutput up to matchHighlight gold — so the
 * freshest output is literally visible. A sealed result must never paint it:
 * the trail is a liveness signal, and gold on settled scrollback would lie.
 *
 * The frame chrome legitimately uses truecolor sequences, so these tests
 * discriminate on the EXACT matchHighlight gold RGB (the gradient's tip), a
 * byte pattern nothing else in a bash row produces.
 *
 * Locks:
 *  1. Streaming render tips the newest output line with the exact gold.
 *  2. Earlier output lines stay untouched (the trail marks only the newest).
 *  3. The final (non-partial) render of the same output has no gold tip.
 *  4. Without truecolor the streaming render has no gold tip (loud degrade,
 *     never a 16-color approximation).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@veyyon/coding-agent/tools/bash";
import { TERMINAL } from "@veyyon/tui";

const terminal = TERMINAL as unknown as { trueColor: boolean };
const originalTrueColor = TERMINAL.trueColor;

afterEach(() => {
	terminal.trueColor = originalTrueColor;
});

const OUTPUT = "first line of stdout\nsecond line of stdout\nthird and newest stdout line";

async function renderBash(isPartial: boolean): Promise<{ lines: string[]; gold: RegExp }> {
	const theme = await getThemeByName("titanium");
	expect(theme).toBeDefined();
	const goldRgb = theme!
		.getColorHex("matchHighlight")
		.replace("#", "")
		.match(/../g)!
		.map(h => parseInt(h, 16))
		.join(";");
	const component = bashToolRenderer.renderResult(
		{ content: [{ type: "text", text: OUTPUT }], details: {}, isError: false },
		{ expanded: false, isPartial },
		theme!,
		{ command: "some-long-running-build" },
	);
	return { lines: [...component.render(100)], gold: new RegExp(`\\x1b\\[38;2;${goldRgb}m`) };
}

describe("bash live stdout tail — the follow on tool rows", () => {
	it("tips the newest streaming line with the exact matchHighlight gold", async () => {
		terminal.trueColor = true;
		const { lines, gold } = await renderBash(true);
		const newest = lines.find(l => Bun.stripANSI(l).includes("newest stdout line"));
		expect(newest).toBeDefined();
		expect(newest).toMatch(gold);
		// The gold open must sit on a CHARACTER, not on visual-line padding —
		// foreground color on trailing spaces is invisible (live-frame defect:
		// the whole ramp landed on the pad and the trail never showed).
		const goldOpenAt = newest!.search(gold);
		const afterGold = newest!.slice(goldOpenAt).replace(gold, "");
		expect(Bun.stripANSI(afterGold).trimStart().charAt(0)).not.toBe("");
		expect(Bun.stripANSI(afterGold).charAt(0)).not.toBe(" ");
	});

	it("leaves earlier streaming lines untouched — the trail marks only the newest", async () => {
		terminal.trueColor = true;
		const { lines, gold } = await renderBash(true);
		const firstLine = lines.find(l => Bun.stripANSI(l).includes("first line of stdout"));
		expect(firstLine).toBeDefined();
		expect(firstLine).not.toMatch(gold);
	});

	it("never paints a sealed result — the trail is a liveness signal", async () => {
		terminal.trueColor = true;
		const { lines, gold } = await renderBash(false);
		for (const line of lines) expect(line).not.toMatch(gold);
	});

	it("degrades loudly without truecolor: streaming render has no gold tip", async () => {
		terminal.trueColor = false;
		const { lines, gold } = await renderBash(true);
		for (const line of lines) expect(line).not.toMatch(gold);
	});
});
