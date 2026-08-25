/**
 * COMMON_KEY_ALIASES is a closed table. schema-repair.test.ts pins filepath
 * and contents. The rest of the table (file/filename/targetfile, text/body,
 * recurse/isrecursive, dir/folder, searchquery, operation/action) has no
 * named contract: a deleted row would be silent as long as filepath still
 * works.
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

describe("every COMMON_KEY_ALIASES source rewrites onto its declared target when the target is empty", () => {
	it("renames file onto path", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { file: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("file");
		expect(plan.renames.get("file")).toBe("path");
	});

	it("renames filename onto path", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { filename: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("filename");
		expect(plan.renames.get("filename")).toBe("path");
	});

	it("renames targetfile onto path", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { targetfile: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("targetfile");
		expect(plan.renames.get("targetfile")).toBe("path");
	});

	it("renames text onto content", () => {
		const plan = planAliasKeyRepairs(objectSchema({ content: { type: "string" } }), { text: "hi" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("text");
		expect(plan.renames.get("text")).toBe("content");
	});

	it("renames body onto content", () => {
		const plan = planAliasKeyRepairs(objectSchema({ content: { type: "string" } }), { body: "hi" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("body");
		expect(plan.renames.get("body")).toBe("content");
	});

	it("renames recurse onto recursive", () => {
		const plan = planAliasKeyRepairs(objectSchema({ recursive: { type: "boolean" } }), { recurse: true });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("recurse");
		expect(plan.renames.get("recurse")).toBe("recursive");
	});

	it("renames isrecursive onto recursive", () => {
		const plan = planAliasKeyRepairs(objectSchema({ recursive: { type: "boolean" } }), { isrecursive: true });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("isrecursive");
		expect(plan.renames.get("isrecursive")).toBe("recursive");
	});

	it("renames dir onto directory", () => {
		const plan = planAliasKeyRepairs(objectSchema({ directory: { type: "string" } }), { dir: "/tmp" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("dir");
		expect(plan.renames.get("dir")).toBe("directory");
	});

	it("renames folder onto directory", () => {
		const plan = planAliasKeyRepairs(objectSchema({ directory: { type: "string" } }), { folder: "/tmp" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("folder");
		expect(plan.renames.get("folder")).toBe("directory");
	});

	it("renames searchquery onto query (q is already pinned elsewhere)", () => {
		const plan = planAliasKeyRepairs(objectSchema({ query: { type: "string" } }), { searchquery: "foo" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("searchquery");
		expect(plan.renames.get("searchquery")).toBe("query");
	});

	it("renames operation onto op", () => {
		const plan = planAliasKeyRepairs(objectSchema({ op: { type: "string" } }), { operation: "add" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("operation");
		expect(plan.renames.get("operation")).toBe("op");
	});

	it("renames action onto op", () => {
		const plan = planAliasKeyRepairs(objectSchema({ op: { type: "string" } }), { action: "add" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("action");
		expect(plan.renames.get("action")).toBe("op");
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

	it("refuses file and filename together onto path", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), {
			file: "a.ts",
			filename: "b.ts",
		});
		expect(plan.kind).toBe("ambiguous");
	});

	it("does not rename a key that is already declared, even if it is also an alias source", () => {
		// A tool that declared `file` as its own property must keep `file`.
		const plan = planAliasKeyRepairs(objectSchema({ file: { type: "string" }, path: { type: "string" } }), {
			file: "a.ts",
		});
		expect(plan.kind).toBe("none");
	});

	it("skips matching when two declared properties normalize to the same spelling, even if an alias table row exists", () => {
		// query + Query collide under normalizeKeyName; q must not be rewritten
		// onto either of them via the normalized map. The alias table still
		// looks up the literal target "query". If "query" is declared, that
		// literal hit is allowed — pin that Query-only schemas do not get it.
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

	it("returns none for a non-object schema", () => {
		expect(planAliasKeyRepairs({ type: "string" }, { filepath: "a.ts" }).kind).toBe("none");
	});

	it("returns none when the object schema has no properties", () => {
		expect(planAliasKeyRepairs({ type: "object", properties: {} }, { filepath: "a.ts" }).kind).toBe("none");
	});

	it("matches a separator/case typo (target_file) onto path via normalize, not only the alias table", () => {
		const plan = planAliasKeyRepairs(objectSchema({ path: { type: "string" } }), { target_file: "a.ts" });
		expect(plan.kind).toBe("renamed");
		if (plan.kind !== "renamed") throw new Error("target_file");
		expect(plan.renames.get("target_file")).toBe("path");
	});
});
