/**
 * sortMCPToolsByName stability and lexicographic order.
 */
import { describe, expect, it } from "bun:test";
import { sortMCPToolsByName } from "../src/mcp/manager";

describe("sortMCPToolsByName stability", () => {
	it("sorts reverse input to ascending", () => {
		const tools = [{ name: "z" }, { name: "m" }, { name: "a" }];
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.name)).toEqual(["a", "m", "z"]);
	});

	it("idempotent second sort", () => {
		const tools = [{ name: "c" }, { name: "a" }, { name: "b" }];
		sortMCPToolsByName(tools);
		const first = tools.map(t => t.name);
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.name)).toEqual(first);
	});

	it("equal names preserve relative order", () => {
		const a = { name: "same", id: 1 };
		const b = { name: "same", id: 2 };
		const tools = [a, b];
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.id)).toEqual([1, 2]);
	});

	it("mcp__ prefixed names sort lexicographically", () => {
		const names = ["mcp__z_a", "mcp__a_z", "mcp__m_m", "mcp__a_a"];
		const tools = names.map(name => ({ name }));
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.name)).toEqual([...names].sort());
	});
});
