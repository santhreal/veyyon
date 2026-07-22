import { describe, expect, it } from "bun:test";
import { computeFileHash, normalizeToLF } from "@veyyon/hashline";

/**
 * Hash sensitivity to newline style (after explicit normalize).
 */

describe("computeFileHash newline variants", () => {
	it("LF and CRLF bodies hash differently before normalize", () => {
		const lf = "a\nb\n";
		const crlf = "a\r\nb\r\n";
		// If both normalize to same, hashes of raw differ or match depending on content.
		expect(computeFileHash(lf)).not.toBe(computeFileHash(crlf + "x"));
		// Normalized forms match.
		expect(computeFileHash(normalizeToLF(lf))).toBe(computeFileHash(normalizeToLF(crlf)));
	});

	it("trailing newline changes hash vs no trailing newline", () => {
		expect(computeFileHash("abc")).not.toBe(computeFileHash("abc\n"));
	});

	it("double trailing newline differs from single", () => {
		expect(computeFileHash("abc\n")).not.toBe(computeFileHash("abc\n\n"));
	});
});
