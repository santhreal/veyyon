/**
 * Three recovery warnings are distinct and non-empty.
 */
import { describe, expect, it } from "bun:test";
import {
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
} from "../src/messages";

describe("recovery warnings distinct", () => {
	it("three distinct Recovered banners", () => {
		const all = [RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_LINE_REMAP_WARNING];
		expect(new Set(all).size).toBe(3);
		for (const w of all) {
			expect(w).toMatch(/Recovered/);
			expect(w.length).toBeGreaterThan(20);
		}
	});
});
