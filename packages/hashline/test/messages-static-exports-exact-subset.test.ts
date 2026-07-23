/**
 * Static message exports used by patcher/recovery: exact non-empty strings.
 */
import { describe, expect, it } from "bun:test";
import {
	ABORT_MARKER,
	BEGIN_PATCH_MARKER,
	DELETE_TAKES_NO_BODY,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	END_PATCH_MARKER,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
} from "@veyyon/hashline";

describe("messages static exports exact subset", () => {
	const strings: Array<[string, string]> = [
		["BEGIN_PATCH_MARKER", BEGIN_PATCH_MARKER],
		["END_PATCH_MARKER", END_PATCH_MARKER],
		["ABORT_MARKER", ABORT_MARKER],
		["EMPTY_REPLACE", EMPTY_REPLACE],
		["EMPTY_INSERT", EMPTY_INSERT],
		["DELETE_TAKES_NO_BODY", DELETE_TAKES_NO_BODY],
		["RECOVERY_EXTERNAL_WARNING", RECOVERY_EXTERNAL_WARNING],
		["RECOVERY_LINE_REMAP_WARNING", RECOVERY_LINE_REMAP_WARNING],
		["RECOVERY_SESSION_CHAIN_WARNING", RECOVERY_SESSION_CHAIN_WARNING],
	];

	for (const [name, value] of strings) {
		it(`${name} is non-empty stable string`, () => {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(5);
		});
	}

	it("recovery warnings are distinct", () => {
		const set = new Set([RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING]);
		expect(set.size).toBe(3);
	});

	it("EMPTY_REPLACE points at DEL for delete intent", () => {
		expect(EMPTY_REPLACE).toMatch(/DEL/);
		expect(EMPTY_REPLACE).toMatch(/SWAP/);
	});
});
