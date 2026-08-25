/**
 * Executor headline vs yield-tool issue list are different path encodings.
 *
 * WHY THIS SUITE EXISTS. `formatValidationIssueHeadline` joins with dots and
 * names the root `(root)` so the executor's one-line `schema_violation` can
 * sit next to a missing-required list. `formatAllValidationIssues` joins with
 * slashes (JSON Pointer convention) so a field named `a.b` is not ambiguous,
 * and an empty path has no prefix. Collapsing the two helpers would make a
 * dotted field name look like a nested path in the model-facing retry, or
 * make the executor headline unparseable against its missing-required suffix.
 */
import { describe, expect, it } from "bun:test";
import {
	formatAllValidationIssues,
	formatValidationIssueHeadline,
	summarizeValidationFailure,
} from "@veyyon/coding-agent/tools/output-schema-validator";
import type { JsonSchemaValidationIssue } from "@veyyon/ai/utils/schema";

function issue(path: Array<string | number>, message: string, keyword = "type"): JsonSchemaValidationIssue {
	return { path, message, keyword };
}

describe("formatValidationIssueHeadline uses dots and (root)", () => {
	it("a nested path is dot-separated", () => {
		expect(formatValidationIssueHeadline(issue(["files", 0, "path"], "is required"))).toBe(
			"files.0.path: is required",
		);
	});

	it("an empty path is (root), never an empty prefix", () => {
		expect(formatValidationIssueHeadline(issue([], "must be object"))).toBe("(root): must be object");
	});

	it("undefined issue is undefined, not a sentinel string", () => {
		expect(formatValidationIssueHeadline(undefined)).toBeUndefined();
	});
});

describe("formatAllValidationIssues uses slashes and no (root) prefix", () => {
	it("a nested path is slash-separated so a dotted field name stays intact", () => {
		expect(formatAllValidationIssues([issue(["a.b", "c"], "is required")])).toBe("a.b/c: is required");
	});

	it("an empty path has no prefix, just the message", () => {
		expect(formatAllValidationIssues([issue([], "must be object")])).toBe("must be object");
	});

	it("several issues join with `; `", () => {
		expect(
			formatAllValidationIssues([issue(["x"], "is required"), issue(["y"], "must not be present")]),
		).toBe("x: is required; y: must not be present");
	});
});

describe("summarizeValidationFailure ignores issues when the result already succeeded", () => {
	it("returns empty message and no missing-required on success", () => {
		expect(summarizeValidationFailure({ success: true, issues: [] }, { a: 1 }, ["a"])).toEqual({
			message: "",
			missingRequired: [],
		});
	});

	it("on failure, missing-required is computed from the value, not from issue paths", () => {
		const out = summarizeValidationFailure(
			{ success: false, issues: [issue(["z"], "unexpected")] },
			{ z: 1 },
			["a", "b"],
		);
		expect(out.missingRequired).toEqual(["a", "b"]);
		expect(out.message).toBe("z: unexpected");
	});
});
