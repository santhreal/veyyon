import { describe, expect, it } from "bun:test";
import { normalizeToLF } from "@veyyon/hashline";

/**
 * normalizeToLF property: no CR remains, idempotent.
 */

describe("normalizeToLF property", () => {
	const samples = [
		"a\nb\n",
		"a\r\nb\r\n",
		"a\rb\r",
		"a\r\nb\nc\r\n",
		"no-newlines",
		"",
		"\r\n",
		"\n",
		"日本語\r\n🙂\n",
	];

	it("result never contains CR", () => {
		for (const s of samples) {
			expect(normalizeToLF(s).includes("\r")).toBe(false);
		}
	});

	it("idempotent", () => {
		for (const s of samples) {
			const once = normalizeToLF(s);
			expect(normalizeToLF(once)).toBe(once);
		}
	});

	it("LF input is identity", () => {
		expect(normalizeToLF("a\nb\n")).toBe("a\nb\n");
	});
});
