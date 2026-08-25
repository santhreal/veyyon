/**
 * COMMON_KEY_ALIASES rows besides filepath/contents (schema-repair.test.ts)
 * and q (q-alias-does-not-overwrite-query.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { planAliasKeyRepairs } from "@veyyon/coding-agent/repair/schema-repair";

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return { type: "object", properties };
}

describe("remaining COMMON_KEY_ALIASES sources rewrite onto their declared target", () => {
	it("renames filename/targetfile, text/body, recurse/isrecursive, dir/folder, searchquery, operation/action", () => {
		const cases: Array<[string, string]> = [
			["filename", "path"],
			["targetfile", "path"],
			["text", "content"],
			["body", "content"],
			["recurse", "recursive"],
			["isrecursive", "recursive"],
			["dir", "directory"],
			["folder", "directory"],
			["searchquery", "query"],
			["operation", "op"],
			["action", "op"],
		];
		for (const [source, target] of cases) {
			const plan = planAliasKeyRepairs(objectSchema({ [target]: { type: "string" } }), { [source]: "value" });
			expect(plan.kind).toBe("renamed");
			if (plan.kind !== "renamed") throw new Error(source);
			expect(plan.renames.get(source)).toBe(target);
		}
	});

	it("does not rename a key that is already declared, even if it is also an alias source", () => {
		const plan = planAliasKeyRepairs(objectSchema({ file: { type: "string" }, path: { type: "string" } }), {
			file: "a.ts",
		});
		expect(plan.kind).toBe("none");
	});

	it("matches a separator/case typo (target_file) onto path via normalize, not only the alias table", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { target_file: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("target_file");
		expect(plan.renames.get("target_file")).toBe("path");
	});
});
