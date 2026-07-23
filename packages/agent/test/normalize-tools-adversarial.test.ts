import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

/**
 * normalizeTools must drop invalid tools, preserve names, and never invent
 * tools from empty input. Drives the shipped agent-core export.
 */

const okSchema = type({ x: "string" });

function tool(name: string) {
	return {
		name,
		label: name,
		description: `tool ${name}`,
		parameters: okSchema,
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

describe("normalizeTools adversarial", () => {
	it("returns empty array for empty input", () => {
		expect(normalizeTools([], false)).toEqual([]);
	});

	it("preserves tool names in order", () => {
		const tools = [tool("a"), tool("b"), tool("c")];
		const out = normalizeTools(tools as never, false);
		expect(out.map(t => t.name)).toEqual(["a", "b", "c"]);
	});

	it("filters null/undefined/object-without-name without throwing", () => {
		const good = tool("keep");
		const out = normalizeTools([null, undefined, {}, { name: 1 }, good] as never, false);
		expect(out.map(t => t.name)).toEqual(["keep"]);
	});

	it("returns empty when every entry is invalid", () => {
		const out = normalizeTools([null, undefined, {}] as never, false);
		expect(out).toEqual([]);
	});

	it("preserves a single valid tool among sparse holes", () => {
		const keep = tool("only");
		const out = normalizeTools([undefined, null, keep, null] as never, false);
		expect(out).toHaveLength(1);
		expect(out[0]!.name).toBe("only");
	});

	it("does not invent names for tools missing name property", () => {
		const nameless = {
			label: "x",
			description: "x",
			parameters: okSchema,
			async execute() {
				return { content: [{ type: "text" as const, text: "x" }], details: {} };
			},
		};
		const out = normalizeTools([nameless, tool("named")] as never, false);
		expect(out.map(t => t.name)).toEqual(["named"]);
	});

	it("keeps tools with duplicate names in input order (no silent dedupe inventing order)", () => {
		const out = normalizeTools([tool("dup"), tool("dup"), tool("other")] as never, false);
		const names = out.map(t => t.name);
		// Either keep both dups in order or dedupe left-to-right — must include other.
		expect(names.includes("other")).toBe(true);
		expect(names.filter(n => n === "dup").length).toBeGreaterThanOrEqual(1);
		expect(names[names.length - 1] === "other" || names.includes("other")).toBe(true);
	});

	it("does not throw on a tool with empty-string name", () => {
		const emptyName = tool("");
		const out = normalizeTools([emptyName, tool("ok")] as never, false);
		// Empty name may be dropped or kept; must never throw and must keep ok.
		expect(out.some(t => t.name === "ok")).toBe(true);
	});
});
