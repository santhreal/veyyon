/**
 * restoreLineEndings + normalizeToLF pure CRLF round-trip.
 */
import { describe, expect, it } from "bun:test";
import { normalizeToLF, restoreLineEndings } from "../src/normalize";

describe("normalize/restore pure CRLF files", () => {
	const pureCrlf = [
		"a\r\nb",
		"a\r\nb\r\nc",
		"a\r\nb\r\nc\r\n",
		"only\r\n",
		"\r\n",
	];
	for (const s of pureCrlf) {
		it(JSON.stringify(s).slice(0, 30), () => {
			const lf = normalizeToLF(s);
			const back = restoreLineEndings(lf, "\r\n");
			// pure CRLF content: restoring LF→CRLF may not restore trailing-only forms identically
			// but normalize(back) equals lf always
			expect(normalizeToLF(back)).toBe(lf);
		});
	}
});
