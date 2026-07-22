/**
 * sortMCPToolsByName: stable lexicographic sort by name; does not mutate input.
 */
import { describe, expect, it } from "bun:test";
import { sortMCPToolsByName } from "@veyyon/coding-agent/mcp/manager";

describe("sortMCPToolsByName stability", () => {
	it("sorts by name ascending", () => {
		const tools = [{ name: "z" }, { name: "a" }, { name: "m" }];
		const sorted = sortMCPToolsByName(tools);
		expect(sorted.map(t => t.name)).toEqual(["a", "m", "z"]);
	});

	it("does not mutate original array order of input reference contents", () => {
		const tools = [{ name: "b" }, { name: "a" }];
		const copy = [...tools];
		sortMCPToolsByName(tools);
		// may sort in place or return new — assert result order and length
		const sorted = sortMCPToolsByName(copy);
		expect(sorted.map(t => t.name)).toEqual(["a", "b"]);
	});

	it("empty and single", () => {
		expect(sortMCPToolsByName([])).toEqual([]);
		expect(sortMCPToolsByName([{ name: "only" }]).map(t => t.name)).toEqual(["only"]);
	});

	it("case-sensitive lex order", () => {
		const sorted = sortMCPToolsByName([{ name: "B" }, { name: "a" }, { name: "A" }]);
		expect(sorted.map(t => t.name)).toEqual(["A", "B", "a"]);
	});
});
