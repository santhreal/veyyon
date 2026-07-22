import { describe, expect, it } from "bun:test";
import { createHunkSelectionValidator, validateHunkSelections } from "@veyyon/coding-agent/utils/git";

/**
 * validateHunkSelections / createHunkSelectionValidator check that a proposed set of
 * hunk selectors actually resolves to real hunks in a staged diff before a split commit
 * stages them. The split_commit tool has an end-to-end test, but the validator itself had
 * no direct unit test. Its contract is load-bearing for "no empty commits" and is pinned
 * here on a fixed diff:
 *   - a `type: "all"` selector is always valid (even for a binary file);
 *   - an index or line selector that resolves to zero hunks is an error
 *     ("No hunks selected for <path>");
 *   - selecting hunks on a binary file is rejected distinctly
 *     ("Cannot select hunks for binary file <path>");
 *   - a selector whose path is not in the diff is SKIPPED, not an error (deferred targets
 *     like a not-yet-staged changelog are validated elsewhere);
 *   - createHunkSelectionValidator parses the diff once and can be reused across selector
 *     sets, returning the same verdicts as the one-shot validateHunkSelections.
 */

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function a() {
-	return 1;
+	return 2;
 }
diff --git a/data.bin b/data.bin
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/data.bin differ`;

describe("validateHunkSelections", () => {
	it("accepts a whole-file selector with no errors", () => {
		expect(validateHunkSelections(DIFF, [{ path: "src/a.ts", hunks: { type: "all" } }])).toEqual([]);
	});

	it("accepts an index selector that resolves to a real hunk", () => {
		expect(validateHunkSelections(DIFF, [{ path: "src/a.ts", hunks: { type: "indices", indices: [0] } }])).toEqual(
			[],
		);
	});

	it("accepts a line selector that overlaps a hunk's range", () => {
		expect(validateHunkSelections(DIFF, [{ path: "src/a.ts", hunks: { type: "lines", start: 1, end: 3 } }])).toEqual(
			[],
		);
	});

	it("errors when an index selector matches no hunk", () => {
		expect(validateHunkSelections(DIFF, [{ path: "src/a.ts", hunks: { type: "indices", indices: [5] } }])).toEqual([
			{ path: "src/a.ts", message: "No hunks selected for src/a.ts" },
		]);
	});

	it("errors when a line selector overlaps no hunk", () => {
		expect(
			validateHunkSelections(DIFF, [{ path: "src/a.ts", hunks: { type: "lines", start: 50, end: 60 } }]),
		).toEqual([{ path: "src/a.ts", message: "No hunks selected for src/a.ts" }]);
	});

	it("rejects hunk selection on a binary file but allows selecting it wholesale", () => {
		expect(validateHunkSelections(DIFF, [{ path: "data.bin", hunks: { type: "indices", indices: [0] } }])).toEqual([
			{ path: "data.bin", message: "Cannot select hunks for binary file data.bin" },
		]);
		expect(validateHunkSelections(DIFF, [{ path: "data.bin", hunks: { type: "all" } }])).toEqual([]);
	});

	it("skips (does not error on) a selector whose path is absent from the diff", () => {
		expect(validateHunkSelections(DIFF, [{ path: "nope.ts", hunks: { type: "indices", indices: [0] } }])).toEqual([]);
	});
});

describe("createHunkSelectionValidator reuse", () => {
	it("parses the diff once and returns consistent verdicts across selector sets", () => {
		const validate = createHunkSelectionValidator(DIFF);
		expect(validate([{ path: "src/a.ts", hunks: { type: "indices", indices: [0] } }])).toEqual([]);
		expect(validate([{ path: "src/a.ts", hunks: { type: "indices", indices: [9] } }])).toEqual([
			{ path: "src/a.ts", message: "No hunks selected for src/a.ts" },
		]);
	});
});
