import { describe, expect, it } from "bun:test";
import { PATCH_OPERATIONS, type PatchOpSpec } from "../src/operations";
import type { BlockTarget } from "../src/tokenizer";

describe("hashline operations runtime membership", () => {
	const EXPECTED_OPS: readonly BlockTarget["kind"][] = [
		"replace",
		"block",
		"delete",
		"delete_block",
		"insert_before",
		"insert_after",
		"insert_after_block",
		"bof",
		"eof",
		"rem",
		"move",
	];

	it("declares every supported hunk operation in PATCH_OPERATIONS", () => {
		const registeredKeys = Object.keys(PATCH_OPERATIONS) as BlockTarget["kind"][];
		expect(registeredKeys.sort()).toEqual([...EXPECTED_OPS].sort());
	});

	it("each declared operation has valid keyword and validation contract", () => {
		for (const key of EXPECTED_OPS) {
			const spec: PatchOpSpec = PATCH_OPERATIONS[key];
			expect(spec).toBeDefined();
			expect(spec.kind).toBe(key);
			expect(typeof spec.keyword).toBe("string");
			expect(spec.keyword.length).toBeGreaterThan(0);
			expect(typeof spec.takesBody).toBe("boolean");
			expect(typeof spec.allowColon).toBe("boolean");
			if (!spec.takesBody) {
				expect(typeof spec.forbiddenBodyError).toBe("string");
			}
			if (spec.takesBody) {
				expect(typeof spec.emptyBodyError).toBe("string");
			}
		}
	});
});
