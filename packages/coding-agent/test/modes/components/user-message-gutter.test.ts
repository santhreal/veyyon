/**
 * The transcript prompt gutter.
 *
 * Why this suite exists: past user prompts rendered as bare flush text —
 * indistinguishable from any other transcript line, with none of the approved
 * composer-design chrome (artifact fd0b9546 §02: a past prompt reads
 * `› how do I profile the render loop?`, with a dim glyph; the TEXT is bright
 * silver — see user-message-working-glow.test.ts for the visibility contract).
 * UserMessageComponent now renders a dim `›` gutter on the first content line
 * and a 3-space hanging indent on every following line, with children laid
 * out 3 columns narrower so the gutter can never push a wrapped row past the
 * terminal edge. These tests pin the exact gutter bytes, the ANSI-aware
 * first-content-line placement (a colored padding row must NOT take the
 * glyph), and the preserved OSC 133 zone wrapping.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { UserMessageComponent } from "@veyyon/coding-agent/modes/components/user-message";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { stripAnsi } from "@veyyon/utils";

const OSC_ZONE = /\x1b\]133;[AB]\x07/g;

function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripAnsi(line.replace(OSC_ZONE, "")).trimEnd());
}

describe("UserMessageComponent prompt gutter", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	/** The first CONTENT line carries ` › ` (dim glyph); the vertical padding
	 * rows keep no gutter even though they carry ANSI color codes — the bug
	 * this pins is exactly a raw trim() mistaking a colored padding row for
	 * content and hanging the glyph on a blank line. */
	it("places the dim › on the first content line, never on a padding row", () => {
		const lines = plain(new UserMessageComponent("hello world").render(60));
		const contentIndex = lines.findIndex(line => line.includes("hello world"));
		expect(contentIndex).toBeGreaterThanOrEqual(0);
		expect(lines[contentIndex]).toBe(" › hello world");
		for (let i = 0; i < contentIndex; i++) {
			expect(lines[i]).not.toContain("›");
		}
		// The glyph itself renders through the dim token — history, not chrome.
		const raw = new UserMessageComponent("hello world").render(60);
		const gutterLine = raw.find(line => stripAnsi(line).includes("›"));
		expect(gutterLine).toContain(theme.fg("dim", "›"));
	});

	/** Every following content line hangs 3 columns so the message reads as
	 * one body under the glyph. */
	it("indents continuation lines by the gutter width", () => {
		const lines = plain(new UserMessageComponent("first line\n\nsecond line").render(60));
		expect(lines).toContain(" › first line");
		expect(lines).toContain("   second line");
	});

	/** Children render 3 columns narrower: a long prompt must wrap inside the
	 * terminal width, gutter included — no row may exceed the budget. */
	it("keeps every wrapped row within the requested width", () => {
		const long = "word ".repeat(30).trim();
		const rendered = new UserMessageComponent(long).render(40);
		for (const line of rendered) {
			expect(stripAnsi(line.replace(OSC_ZONE, "")).length).toBeLessThanOrEqual(40);
		}
	});

	/** The OSC 133 prompt-zone markers survive the gutter pass: zone start on
	 * the first row, zone end on the last — terminal multiplexers rely on them
	 * to group prompt jumps. */
	it("preserves the OSC 133 zone wrapping", () => {
		const rendered = new UserMessageComponent("zoned").render(60);
		expect(rendered[0]).toStartWith("\x1b]133;A\x07");
		expect(rendered[rendered.length - 1]).toEndWith("\x1b]133;B\x07");
	});
});
