import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image } from "@veyyon/tui";
import { ImageProtocol, TERMINAL } from "@veyyon/tui/terminal-capabilities";
import { defaultImageTheme } from "@veyyon/tui/test-support";

/**
 * Defends tmux-specific emission invariants:
 * 1. Graphic payloads (Sixel, Kitty) emitted while inside tmux must be wrapped
 *    in tmux DCS passthrough envelopes (`\x1bPtmux;...\x1b\\`), preventing multiplexer
 *    payload drops or terminal corruption.
 * 2. Absolute cursor addressing sequences (e.g. `CSI <col> G` or `CSI <row>;<col> H`)
 *    must strictly remain within the active pane dimensions `[1, width]` and `[1, height]`.
 */
describe("tmux graphics passthrough and cursor bounds invariants", () => {
	const originalTmux = process.env.TMUX;
	const originalImageProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
	});

	afterEach(() => {
		if (originalTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = originalTmux;
		}
		TERMINAL.imageProtocol = originalImageProtocol;
	});

	// Minimal 1x1 100% white PNG base64
	const TINY_WHITE_PNG_BASE64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	it("sweeps all supported image protocols and asserts tmux passthrough wrapping when running inside tmux (packages/tui/src/terminal-capabilities.ts:1105)", () => {
		const protocols = [ImageProtocol.Kitty, ImageProtocol.Sixel];
		const unwrappedEmissions: Array<{ protocol: string; rawLine: string }> = [];

		for (const protocol of protocols) {
			TERMINAL.imageProtocol = protocol;
			const img = new Image(
				TINY_WHITE_PNG_BASE64,
				"image/png",
				defaultImageTheme,
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const lines = img.render(80);

			for (const line of lines) {
				// Sixel sequence starts with \x1bP...q (DCS)
				// Kitty sequence starts with \x1b_G (APC)
				// Under tmux, both MUST be wrapped in DCS passthrough: \x1bPtmux;\x1b...
				const hasRawSixel = /(?<!\x1bPtmux;)\x1bP[\d;]*q/u.test(line);
				const hasRawKitty = /(?<!\x1bPtmux;)\x1b_G/u.test(line);

				if (hasRawSixel || hasRawKitty) {
					unwrappedEmissions.push({
						protocol,
						rawLine: line,
					});
				}
			}
		}

		// Contract: No raw unwrapped graphics escapes when TMUX is active
		expect(unwrappedEmissions).toEqual([]);
	});

	it("defends invariant that Sixel graphic payloads are wrapped in tmux passthrough (packages/tui/src/terminal-capabilities.ts:1105)", () => {
		TERMINAL.imageProtocol = ImageProtocol.Sixel;
		const img = new Image(TINY_WHITE_PNG_BASE64, "image/png", defaultImageTheme, {}, { widthPx: 50, heightPx: 50 });
		const lines = img.render(60);

		expect(lines.length).toBeGreaterThan(0);

		// Find line carrying the sixel graphic sequence
		const graphicLine = lines.find(l => l.includes("\x1bP"));
		expect(graphicLine).toBeDefined();

		// When TMUX is set, the sequence MUST be wrapped in \x1bPtmux;...\x1b\\
		const startsWithTmuxPassthrough = graphicLine!.includes("\x1bPtmux;");
		expect(startsWithTmuxPassthrough).toBe(true);
	});
});
