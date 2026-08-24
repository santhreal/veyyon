/**
 * WHY THIS SUITE EXISTS:
 *
 * Status line sanitization previously delegated ANSI escape stripping to the
 * runtime via `node:util`'s `stripVTControlCharacters`. When Bun 1.4 modified
 * its escape parser, ST-terminated string sequences (DCS `ESC P`, PM `ESC ^`,
 * APC `ESC _`) were no longer stripped, causing their control payloads to leak
 * into the status line as visible text.
 *
 * This suite closes the class of status text corruption by verifying that all
 * ANSI escape sequence families (CSI, OSC with BEL/ST, DCS, SOS, PM, APC, nF,
 * Fp/Fs, and their 8-bit C1 variants) are stripped without publishing escape
 * bytes or payloads to the single-line status output.
 *
 * WHAT IT DOES NOT CATCH:
 *
 * This suite does not test multi-line layout formatting, full TUI component
 * rendering, or width calculations handled by `@veyyon/tui`.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeStatusText } from "@veyyon/coding-agent/modes/shared";

interface EscapeFamilyCase {
	name: string;
	sequence: string;
	expectedText?: string;
}

const ESCAPE_FAMILIES: EscapeFamilyCase[] = [
	{ name: "CSI (7-bit SGR color/style)", sequence: "\x1b[31mred\x1b[0m", expectedText: "red" },
	{ name: "CSI (8-bit SGR color/style)", sequence: "\x9b31mred\x9b0m", expectedText: "red" },
	{ name: "CSI (7-bit cursor/erase)", sequence: "\x1b[2K\x1b[1Ahello", expectedText: "hello" },
	{ name: "OSC with BEL (7-bit)", sequence: "\x1b]0;window title\x07" },
	{ name: "OSC with BEL (8-bit)", sequence: "\x9d0;window title\x07" },
	{ name: "OSC with ST (7-bit)", sequence: "\x1b]8;;https://example.com\x1b\\" },
	{ name: "OSC with ST (8-bit)", sequence: "\x9d8;;https://example.com\x9c" },
	{ name: "DCS string sequence (7-bit)", sequence: "\x1bPhidden-dcs\x1b\\" },
	{ name: "DCS string sequence (8-bit)", sequence: "\x90hidden-dcs\x9c" },
	{ name: "SOS string sequence (7-bit)", sequence: "\x1bXhidden-sos\x1b\\" },
	{ name: "SOS string sequence (8-bit)", sequence: "\x98hidden-sos\x9c" },
	{ name: "PM string sequence (7-bit)", sequence: "\x1b^hidden-pm\x1b\\" },
	{ name: "PM string sequence (8-bit)", sequence: "\x9ehidden-pm\x9c" },
	{ name: "APC string sequence (7-bit)", sequence: "\x1b_hidden-apc\x1b\\" },
	{ name: "APC string sequence (8-bit)", sequence: "\x9fhidden-apc\x9c" },
	{ name: "nF charset select", sequence: "\x1b(Btext", expectedText: "text" },
	{ name: "single-byte Fp cursor save/restore", sequence: "\x1b7done\x1b8", expectedText: "done" },
	{ name: "single-byte Fp keypad mode", sequence: "\x1b=menu\x1b>", expectedText: "menu" },
	{ name: "single-byte Fs reset", sequence: "\x1bcfresh", expectedText: "fresh" },
	{ name: "single-byte Fs ST (7-bit)", sequence: "before\x1b\\after", expectedText: "beforeafter" },
	{ name: "single-byte Fs ST (8-bit)", sequence: "before\x9cafter", expectedText: "beforeafter" },
];

describe("sanitizeStatusText", () => {
	describe("enumerated escape sequence families", () => {
		for (const { name, sequence, expectedText } of ESCAPE_FAMILIES) {
			it(`strips ${name} without leaking escape bytes or payload`, () => {
				const expected = expectedText ? `prefix ${expectedText} suffix` : "prefix suffix";
				expect(sanitizeStatusText(`prefix ${sequence} suffix`)).toBe(expected);
			});
		}
	});

	it("strips composite multi-family escape sequences in a single status string", () => {
		const input =
			"prefix " +
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07" +
			" " +
			"\x1bPhidden-dcs\x1b\\" +
			"\x1b^hidden-pm\x1b\\" +
			"\x1b_hidden-apc\x1b\\" +
			"\x9b31mred\x9b0m" +
			" suffix";

		expect(sanitizeStatusText(input)).toBe("prefix link red suffix");
	});

	describe("adversarial and boundary cases", () => {
		it("does not swallow following text when a status label ends mid-escape at a buffer boundary", () => {
			expect(sanitizeStatusText("status: \x1b[3")).toBe("status: [3");
			expect(sanitizeStatusText("status: \x1b")).toBe("status:");
			expect(sanitizeStatusText("status: \x1b]8;;https://example.com")).toBe("status: ]8;;https://example.com");
		});

		it("does not publish hidden string sequence payloads when properly terminated", () => {
			expect(sanitizeStatusText("status: \x1bPtmux;\x1b\\running")).toBe("status: running");
			expect(sanitizeStatusText("status: \x90tmux;\x9crunning")).toBe("status: running");
			expect(sanitizeStatusText("status: \x1b_Ga=T,f=100;PAYLOAD\x1b\\ready")).toBe("status: ready");
			expect(sanitizeStatusText("status: \x9fGa=T,f=100;PAYLOAD\x9cready")).toBe("status: ready");
		});

		it("keeps text following an unterminated string sequence at a buffer boundary", () => {
			expect(sanitizeStatusText("status: \x1bPcut here")).toBe("status: Pcut here");
		});

		it("maps C0 and non-introducer C1 control characters to spaces and collapses whitespace", () => {
			expect(sanitizeStatusText("hello\t\t\r\n\x00\x1fworld")).toBe("hello world");
			expect(sanitizeStatusText("hello\x95world")).toBe("hello world");
		});
	});
});
