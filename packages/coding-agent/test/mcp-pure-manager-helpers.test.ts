/**
 * sortMCPToolsByName and resolveSubscriptionPostAction — pure manager helpers.
 */
import { describe, expect, it } from "bun:test";
import { resolveSubscriptionPostAction, sortMCPToolsByName } from "../src/mcp/manager";

describe("sortMCPToolsByName", () => {
	it("sorts in place ascending by name and returns same array", () => {
		const tools = [{ name: "mcp__z_a" }, { name: "mcp__a_z" }, { name: "mcp__m_m" }];
		const out = sortMCPToolsByName(tools);
		expect(out).toBe(tools);
		expect(out.map(t => t.name)).toEqual(["mcp__a_z", "mcp__m_m", "mcp__z_a"]);
	});

	it("stable for equal names", () => {
		const a = { name: "same", id: 1 };
		const b = { name: "same", id: 2 };
		const tools = [a, b];
		sortMCPToolsByName(tools);
		expect(tools.map(t => t.id)).toEqual([1, 2]);
	});

	it("empty and single are no-ops", () => {
		expect(sortMCPToolsByName([])).toEqual([]);
		const one = [{ name: "only" }];
		expect(sortMCPToolsByName(one)).toEqual([{ name: "only" }]);
	});

	it("sorts large random-ish set into lexicographic order", () => {
		const names = Array.from({ length: 40 }, (_, i) => `mcp__tool_${(37 - i).toString().padStart(2, "0")}`);
		const tools = names.map(name => ({ name }));
		sortMCPToolsByName(tools);
		const sorted = [...names].sort();
		expect(tools.map(t => t.name)).toEqual(sorted);
	});
});

describe("resolveSubscriptionPostAction", () => {
	it("rollback when notifications disabled regardless of epoch", () => {
		expect(resolveSubscriptionPostAction(false, 1, 1)).toBe("rollback");
		expect(resolveSubscriptionPostAction(false, 5, 1)).toBe("rollback");
	});

	it("ignore when epochs diverge under notifications", () => {
		expect(resolveSubscriptionPostAction(true, 2, 1)).toBe("ignore");
		expect(resolveSubscriptionPostAction(true, 0, 9)).toBe("ignore");
	});

	it("apply when notifications on and epochs match", () => {
		expect(resolveSubscriptionPostAction(true, 0, 0)).toBe("apply");
		expect(resolveSubscriptionPostAction(true, 7, 7)).toBe("apply");
	});
});
