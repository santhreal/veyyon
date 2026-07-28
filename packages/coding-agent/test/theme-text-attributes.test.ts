/**
 * Theme text attributes — bold/italic/underline/strikethrough/inverse must be
 * raw SGR pairs, never chalk. Found by live capture (2026-07-22): chalk's
 * level auto-detection returned 0 under bun-in-tmux and SILENTLY STRIPPED
 * every bold and italic in the running TUI — markdown **emphasis** rendered
 * as plain text (asterisks consumed, weight gone), the wordmark lost its
 * bold, tips lost their italics — while the theme's own raw truecolor
 * escapes painted fine. A second capability detector that can quietly
 * disagree with the theme is a silent fallback (Law 10).
 *
 * Locks:
 *  1. Exact SGR bytes for each attribute, with the attribute-specific
 *     off-code (22/23/24/29/27), NOT a blanket reset — so attributes nest
 *     inside colored spans without killing the color.
 *  2. With the full ANSI policy selected, attributes emit regardless of TTY
 *     detection (this test process has no TTY, exactly what chalk misread).
 *     The explicit plain policy is covered separately by `ansi-policy.test.ts`.
 *  3. The markdown theme's bold/italic/strikethrough flow through the same
 *     owner, so **markdown emphasis** can never silently vanish again.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getMarkdownTheme } from "@veyyon/coding-agent/modes/theme/markdown-theme";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

let previousAnsiPolicy: AnsiPolicy;
describe("theme text attributes", () => {
	beforeAll(async () => {
		previousAnsiPolicy = getAnsiPolicy();
		setAnsiPolicy("full");
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		setAnsiPolicy(previousAnsiPolicy);
	});

	it("emits exact SGR pairs with attribute-specific off-codes", () => {
		expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
		expect(theme.italic("x")).toBe("\x1b[3mx\x1b[23m");
		expect(theme.underline("x")).toBe("\x1b[4mx\x1b[24m");
		expect(theme.strikethrough("x")).toBe("\x1b[9mx\x1b[29m");
		expect(theme.inverse("x")).toBe("\x1b[7mx\x1b[27m");
	});

	it("never closes with a blanket reset that would kill an enclosing color", () => {
		for (const styled of [theme.bold("x"), theme.italic("x"), theme.underline("x")]) {
			expect(styled).not.toContain("\x1b[0m");
		}
	});

	it("styles markdown emphasis through the same owner (no chalk detection)", () => {
		const md = getMarkdownTheme();
		expect(md.bold("x")).toContain("\x1b[1m");
		expect(md.italic("x")).toContain("\x1b[3m");
		expect(md.strikethrough("x")).toContain("\x1b[9m");
	});
});
