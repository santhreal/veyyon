/**
 * WHY: `src/report/trace-report.ts` shipped as a script with no exported seam and no
 * test, and it ran `main()` on import, so importing it opened a model connection and
 * fetched a run. Every deterministic decision it makes about a transcript — which tool
 * results belong to which turn, how a turn is numbered next to a harness notice, what a
 * missing duration prints, how many model calls run at once — was unobservable, and a
 * wrong grouping silently reattributes a tool call to the wrong turn of a report a
 * reader uses to judge a run.
 *
 * The class this closes: a trace-shaping seam that changes what the report attributes
 * to a turn, and the concurrency bound on the map phase. Each seam is exported and
 * driven directly; `main()` now runs only under `import.meta.main`, so this file can
 * import the module without performing a run.
 *
 * What it does not catch: the wording of the two model prompts, the story-arc text a
 * model returns, and the report's overall markdown layout, which is assembled inside
 * `main()` against a live trace API.
 */

import { describe, expect, test } from "bun:test";
import {
	formatTraceDuration,
	groupItems,
	type LogItem,
	mapPool,
	renderTurnLog,
	type TraceEntry,
	toolsLine,
} from "../../src/report/trace-report";

function assistant(model: string, text: string, tools: string[]): TraceEntry {
	return { kind: "assistant", model, text, tools };
}

function toolResult(tool: string, isError: boolean): TraceEntry {
	return { kind: "toolResult", tool, text: `${tool} output`, isError };
}

function turn(model: string, tools: string[], results: { tool: string; isError: boolean }[]): LogItem {
	return {
		kind: "turn",
		model,
		text: "",
		tools,
		results: results.map(result => ({ kind: "toolResult", tool: result.tool, text: "", isError: result.isError })),
	};
}

describe("grouping a trace into turns", () => {
	test("attaches every tool result to the assistant turn that called it", () => {
		const items = groupItems([
			assistant("m1", "first", ["read", "grep"]),
			toolResult("read", false),
			toolResult("grep", true),
			assistant("m2", "second", ["edit"]),
			toolResult("edit", false),
		]);

		expect(items).toHaveLength(2);
		const [first, second] = items;
		expect(first.kind).toBe("turn");
		expect(second.kind).toBe("turn");
		if (first.kind !== "turn" || second.kind !== "turn") throw new Error("expected two turns");
		expect(first.model).toBe("m1");
		expect(first.results.map(result => result.tool)).toEqual(["read", "grep"]);
		expect(second.results.map(result => result.tool)).toEqual(["edit"]);
	});

	test("keeps a harness notice as its own item rather than folding it into a turn", () => {
		const items = groupItems([
			assistant("m1", "first", ["read"]),
			toolResult("read", false),
			{ kind: "notice", text: "context compacted" },
			assistant("m1", "second", []),
		]);

		expect(items.map(item => item.kind)).toEqual(["turn", "notice", "turn"]);
		const notice = items[1];
		if (notice.kind !== "notice") throw new Error("expected a notice");
		expect(notice.text).toBe("context compacted");
	});

	test("refuses a trace whose first entry is a tool result instead of attributing it to nothing", () => {
		expect(() => groupItems([toolResult("read", false)])).toThrow(/trace starts with a toolResult/);
	});

	test("a tool result after a notice belongs to the turn before that notice", () => {
		const items = groupItems([
			assistant("m1", "first", ["read"]),
			{ kind: "notice", text: "retrying" },
			toolResult("read", false),
		]);

		const first = items[0];
		if (first.kind !== "turn") throw new Error("expected a turn");
		expect(first.results.map(result => result.tool)).toEqual(["read"]);
	});
});

describe("the tools line of one turn", () => {
	test("states prose only when the turn called no tool", () => {
		expect(toolsLine([])).toBe("prose only (no tool calls)");
	});

	test("counts a repeated tool once with its multiplicity, in first-call order", () => {
		expect(toolsLine(["read", "grep", "read", "read"])).toBe("tools called: `read` ×3, `grep`");
	});

	test("names a single call without a multiplier", () => {
		expect(toolsLine(["edit"])).toBe("tools called: `edit`");
	});
});

describe("rendering the turn log", () => {
	test("numbers turns and notices in one sequence and marks the errored tools of a turn", () => {
		const rendered = renderTurnLog(
			[
				turn(
					"m1",
					["read", "grep"],
					[
						{ tool: "read", isError: false },
						{ tool: "grep", isError: true },
					],
				),
				{ kind: "notice", text: "context compacted" },
				turn("m2", [], []),
			],
			["read the file", undefined, "concluded"],
		);

		expect(rendered.split("\n")).toEqual([
			"### Turn Log",
			"",
			"1. **[m1]** tools called: `read`, `grep` (errored: `grep`).",
			"   - Grounded action: read the file",
			'2. **— harness: notice: "context compacted"**',
			"3. **[m2]** prose only (no tool calls).",
			"   - Grounded action: concluded",
		]);
	});

	test("states that a summary is unavailable rather than dropping the turn", () => {
		const rendered = renderTurnLog([turn("m1", ["read"], [{ tool: "read", isError: false }])], [undefined]);

		expect(rendered).toContain("   - Grounded action: (summary unavailable)");
	});

	test("annotates no errors when every tool result succeeded", () => {
		const rendered = renderTurnLog([turn("m1", ["read"], [{ tool: "read", isError: false }])], ["ok"]);

		expect(rendered).not.toContain("errored:");
	});
});

describe("the duration of a trace row", () => {
	test("prints a question mark for a duration that was never recorded", () => {
		expect(formatTraceDuration(null)).toBe("?");
	});

	test("zero-pads the seconds so rows align", () => {
		expect(formatTraceDuration(9_000)).toBe("0m09s");
		expect(formatTraceDuration(69_000)).toBe("1m09s");
	});

	test("rolls whole minutes over and rounds to the nearest second", () => {
		expect(formatTraceDuration(600_400)).toBe("10m00s");
		expect(formatTraceDuration(1_500)).toBe("0m02s");
	});
});

describe("the map phase over turns", () => {
	test("keeps results in input order however the workers interleave", async () => {
		const gates = [0, 1, 2, 3].map(() => Promise.withResolvers<void>());
		const collected = mapPool([0, 1, 2, 3], 4, async index => {
			await gates[index].promise;
			return index * 10;
		});

		for (const index of [3, 1, 0, 2]) gates[index].resolve();

		expect(await collected).toEqual([0, 10, 20, 30]);
	});

	test("never runs more workers at once than the limit allows", async () => {
		const release = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		const items = [1, 2, 3, 4, 5, 6, 7, 8];

		const collected = mapPool(items, 3, async item => {
			active += 1;
			peak = Math.max(peak, active);
			await release.promise;
			active -= 1;
			return item;
		});

		expect(peak).toBe(3);
		release.resolve();
		expect(await collected).toEqual(items);
		expect(peak).toBe(3);
	});

	test("a limit above the item count starts one worker per item and no more", async () => {
		const release = Promise.withResolvers<void>();
		let peak = 0;
		let active = 0;
		const collected = mapPool([1, 2], 16, async item => {
			active += 1;
			peak = Math.max(peak, active);
			await release.promise;
			active -= 1;
			return item;
		});

		expect(peak).toBe(2);
		release.resolve();
		expect(await collected).toEqual([1, 2]);
	});

	test("returns an empty result for no items without starting a worker", async () => {
		let started = 0;
		const results = await mapPool<number, number>([], 4, async item => {
			started += 1;
			return item;
		});

		expect(results).toEqual([]);
		expect(started).toBe(0);
	});
});
