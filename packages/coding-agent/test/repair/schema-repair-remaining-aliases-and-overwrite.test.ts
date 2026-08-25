/**
 * COMMON_KEY_ALIASES is a closed table. schema-repair.test.ts pins filepath
 * and contents. q is pinned in q-alias-does-not-overwrite-query.test.ts.
 * The rest of the table has no named contract: a deleted row would be silent
 * as long as filepath still works.
 *
 * Also pinned here, because the main file's overwrite test uses filepath vs
 * path and never the op aliases: `{ op: "add", action: "remove" }` must
 * refuse rather than overwrite. `__` sentinels are ignored; a key that is
 * already declared is never an alias source.
 */
import { describe, expect, it } from "bun:test";
import { planAliasKeyRepairs } from "@veyyon/coding-agent/repair/schema-repair";

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
	return { type: "object", properties };
}

function expectRename(source: string, target: string, extraDeclared: Record<string, unknown> = {}): void {
	const plan = planAliasKeyRepairs(objectSchema({ [target]: { type: "string" }, ...extraDeclared }), {
		[source]: "value",
	});
	expect(plan.kind).toBe("renamed");
	if (plan.kind !== "renamed") throw new Error(source);
	expect(plan.renames.get(source)).toBe(target);
}

describe("every remaining COMMON_KEY_ALIASES source rewrites onto its declared target", () => {
	it("renames file/filename/targetfile, text/body, recurse/isrecursive, dir/folder, searchquery, operation/action", () => {
		expectRename("file", "path");
		expectRename("filename", "path");
		expectRename("targetfile", "path");
		expectRename("text", "content");
		expectRename("body", "content");
		expectRename("recurse", "recursive");
		expectRename("isrecursive", "recursive");
		expectRename("dir", "directory");
		expectRename("folder", "directory");
		expectRename("searchquery", "query");
		expectRename("operation", "op");
		expectRename("action", "op");
	});
});

describe("alias repair refuses rather than overwrite or guess", () => {
	it("refuses action when op is already populated", () => {
		const plan = planAliasKeyRepairs(objectSchema({ op: { type: "string" } }), { op: "add", action: "remove" });
		expect(plan.kind).toBe("ambiguous");
	});

	it("refuses operation and action together (two sources, one target)", () => {
		const plan = planAliasKeyRepairs(objectSchema({ op: { type: "string" } }), {
			operation: "add",
			action: "remove",
		});
		expect(plan.kind).toBe("ambiguous");
	});

	it("does not rename a key that is already declared, even if it is also an alias source", () => {
		const plan = planAliasKeyRepairs(objectSchema({ file: { type: "string" }, path: { type: "string" } }), {
			file: "a.ts",
		});
		expect(plan.kind).toBe("none");
	});

	it("skips matching when two declared properties normalize to the same spelling", () => {
		const queryOnly = planAliasKeyRepairs(objectSchema({ Query: { type: "string" } }), { q: "foo" });
		expect(queryOnly.kind).toBe("none");
	});

	it("ignores __-prefixed keys when collecting unknown sources", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), {
			__parse: "sentinel",
			filepath: "a.ts",
		});
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("filepath");
		expect([...plan.renames.keys()]).toEqual(["filepath"]);
	});

	it("matches a separator/case typo (target_file) onto path via normalize, not only the alias table", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { target_file: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("target_file");
		expect(plan.renames.get("target_file")).toBe("path");
	});
});
