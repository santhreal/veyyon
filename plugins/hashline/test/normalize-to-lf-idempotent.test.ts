/**
 * normalizeToLF is idempotent and strips all CR forms.
 */
import { describe, expect, it } from "bun:test";
import { normalizeToLF } from "../src/normalize";

describe("normalizeToLF idempotent", () => {
	const samples = ["", "a", "a\nb", "a\r\nb", "a\rb", "a\r\nb\rc\nd", "\r\n\r\n", "trail\r\n", "unicode café\r\n☃"];
	for (const s of samples) {
		it(JSON.stringify(s).slice(0, 30), () => {
			const once = normalizeToLF(s);
			const twice = normalizeToLF(once);
			expect(twice).toBe(once);
			expect(once.includes("\r")).toBe(false);
		});
	}
});
