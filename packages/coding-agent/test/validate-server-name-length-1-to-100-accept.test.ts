/**
 * validateServerName: length 1..100 of valid charset accept; 101+ reject.
 * Why: max-100 is a hard boundary; off-by-one would break MCP add or accept junk.
 */
import { describe, expect, it } from "bun:test";
import { validateServerName } from "../src/mcp/config-writer";

describe("validateServerName length 1 to 100 accept", () => {
	for (let n = 1; n <= 100; n++) {
		it(`len=${n} accept`, () => {
			expect(validateServerName("a".repeat(n))).toBeUndefined();
		});
	}

	for (let n = 101; n <= 120; n++) {
		it(`len=${n} reject`, () => {
			const err = validateServerName("a".repeat(n));
			expect(err).toBeDefined();
			expect(err!).toMatch(/too long/i);
		});
	}

	it("charset mixed accept", () => {
		for (const name of ["A_b.1:c-d", "x:y:z", "9start", "end9", "a.b.c"]) {
			expect(validateServerName(name)).toBeUndefined();
		}
	});

	const badChars = [
		" ",
		"/",
		"\\",
		"@",
		"#",
		"$",
		"%",
		"^",
		"&",
		"*",
		"(",
		")",
		"[",
		"]",
		"{",
		"}",
		"!",
		"?",
		",",
		";",
	];
	for (const ch of badChars) {
		it(`reject char ${JSON.stringify(ch)}`, () => {
			expect(validateServerName(`a${ch}b`)).toMatch(/can only contain/i);
		});
	}
});
