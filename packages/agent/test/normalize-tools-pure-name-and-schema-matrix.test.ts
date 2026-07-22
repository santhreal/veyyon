/**
 * normalizeTools pure: strips invalid entries, preserves order of valids,
 * handles empty description and name collisions without throw.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";
import type { AgentTool } from "@veyyon/agent-core/types";
import { type } from "arktype";

const schema = type({ path: "string" });

function tool(name: string, description = "d"): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: schema,
		async execute() {
			return { content: [], details: {} };
		},
	} as AgentTool;
}

describe("normalizeTools pure name/schema matrix", () => {
	it("empty input → empty", () => {
		expect(normalizeTools([])).toEqual([]);
	});

	it("filters non-objects and keeps order of real tools", () => {
		const a = tool("a");
		const b = tool("b");
		const out = normalizeTools([null, a, "x", b, 1, undefined] as never);
		expect(out.map(t => t.name)).toEqual(["a", "b"]);
	});

	it("empty description preserved when prune not forced", () => {
		const t = tool("x", "");
		const out = normalizeTools([t]);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("x");
	});

	it("duplicate names: both retained or last wins — exact shipped behavior", () => {
		const out = normalizeTools([tool("dup"), tool("dup")]);
		// Document exact: normalizeTools does not dedupe by name
		expect(out.map(t => t.name)).toEqual(["dup", "dup"]);
	});

	it("large batch preserves count of valids", () => {
		const tools = Array.from({ length: 50 }, (_, i) => tool(`t${i}`));
		expect(normalizeTools(tools)).toHaveLength(50);
	});
});
