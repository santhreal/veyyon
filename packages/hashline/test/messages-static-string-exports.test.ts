/**
 * Static message exports are non-empty and distinct for key recovery banners.
 */
import { describe, expect, it } from "bun:test";
import {
	HEADTAIL_DRIFT_WARNING,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
	BLOCK_RESOLVER_UNAVAILABLE,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	MINUS_ROW_REJECTED,
	DELETE_TAKES_NO_BODY,
	REM_TAKES_NO_BODY,
	MOVE_TAKES_NO_BODY,
	UNRESOLVED_BLOCK_INTERNAL,
} from "../src/messages";

describe("static message export uniqueness", () => {
	const all = [
		HEADTAIL_DRIFT_WARNING,
		RECOVERY_EXTERNAL_WARNING,
		RECOVERY_LINE_REMAP_WARNING,
		RECOVERY_SESSION_CHAIN_WARNING,
		BLOCK_RESOLVER_UNAVAILABLE,
		EMPTY_INSERT,
		EMPTY_REPLACE,
		MINUS_ROW_REJECTED,
		DELETE_TAKES_NO_BODY,
		REM_TAKES_NO_BODY,
		MOVE_TAKES_NO_BODY,
		UNRESOLVED_BLOCK_INTERNAL,
	];

	it("every export is non-empty string", () => {
		for (const s of all) {
			expect(typeof s).toBe("string");
			expect(s.length).toBeGreaterThan(10);
		}
	});

	it("all recovery warnings are distinct", () => {
		const set = new Set(all);
		expect(set.size).toBe(all.length);
	});

	it("recovery banners mention Recovered", () => {
		expect(RECOVERY_EXTERNAL_WARNING).toMatch(/Recovered/);
		expect(RECOVERY_SESSION_CHAIN_WARNING).toMatch(/Recovered/);
		expect(RECOVERY_LINE_REMAP_WARNING).toMatch(/Recovered/);
	});
});
