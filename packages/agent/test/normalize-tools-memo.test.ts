import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";
import type { AgentTool } from "@veyyon/agent-core/types";
import { type } from "arktype";

const toolSchema = type({
	path: type("string").describe("where to read"),
});

function makeTool(): AgentTool<typeof toolSchema, { path: string }> {
	return {
		name: "demo",
		label: "Demo",
		description: "top-level tool description",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/**
 * Contract (BACKLOG P7): `toolWireSchema`/`stripSchemaDescriptions` are already
 * stamped per-tool, but `normalizeTools` itself re-ran its full `.map()` (object
 * spreads, intent injection, example rendering) on every call even when called
 * repeatedly with the SAME `tools` array and flags — which real callers
 * (`takeSnapshot` in append-only-context.ts, `Agent#buildSideRequestContext`) do
 * on every turn/request. A second call with an unchanged array + flags must
 * reuse the cached result instead of rebuilding it.
 */
describe("normalizeTools cross-request memoization", () => {
	it("returns the identical result array for a second call with the same tools array and flags", () => {
		const tools = [makeTool()];

		const first = normalizeTools(tools, true, undefined, false);
		const second = normalizeTools(tools, true, undefined, false);

		expect(second).toBe(first);
		expect(second?.[0]).toBe(first?.[0]);
	});

	it("recomputes when the tools array reference changes, even with identical tool content", () => {
		const first = normalizeTools([makeTool()], true, undefined, false);
		const second = normalizeTools([makeTool()], true, undefined, false);

		expect(second).not.toBe(first);
		// Content is still correct — just not the same cached array.
		expect(second?.[0]?.description).toBe(first?.[0]?.description);
	});

	it("recomputes when a flag changes for the same tools array (no stale cross-flag reuse)", () => {
		const tools = [makeTool()];

		const withDescriptions = normalizeTools(tools, false, undefined, false);
		const pruned = normalizeTools(tools, false, undefined, true);

		expect(pruned).not.toBe(withDescriptions);
		expect(withDescriptions?.[0]?.description).toBe("top-level tool description");
		expect(pruned?.[0]?.description).toBe("");

		// Switching back to the un-pruned flags for the same array must not
		// serve the stale pruned result from the single-slot cache.
		const withDescriptionsAgain = normalizeTools(tools, false, undefined, false);
		expect(withDescriptionsAgain?.[0]?.description).toBe("top-level tool description");
	});

	it("recomputes when the example dialect changes for the same tools array", () => {
		const tools = [makeTool()];

		const noDialect = normalizeTools(tools, false, undefined, false);
		const withDialect = normalizeTools(tools, false, "xml", false);

		expect(withDialect).not.toBe(noDialect);
	});

	it("passes through undefined tools without touching the cache", () => {
		expect(normalizeTools(undefined, true)).toBeUndefined();
	});
});
