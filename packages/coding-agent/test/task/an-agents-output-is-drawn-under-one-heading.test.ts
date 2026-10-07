/**
 * WHY: an agent that returned `{}` or `[]` drew its `Output` heading twice on an expanded card. The
 * JSON branch pushed the heading, found no tree to draw for an empty value, and fell through to the
 * plain-lines branch, which pushed the heading again. The live output of a running agent took the
 * same path.
 *
 * The class this closes: every way an agent's output reaches the card (a JSON tree, a JSON summary,
 * an empty JSON value, text that only looks like JSON, plain lines) on every surface that draws it
 * (a settled agent with and without the missing-`yield` warning, a running agent's live output),
 * collapsed and expanded. Each draws the value once and names it under at most one `Output` heading;
 * a collapsed JSON value with no warning is its own one-line summary and has no heading row.
 *
 * Not caught: a heading drawn by another section (the brief's `Task`, a review's `Summary`); those
 * have their own builders.
 */
import { describe, expect, it } from "bun:test";
import { taskToolView } from "@veyyon/coding-agent/task/task-view";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@veyyon/coding-agent/task/types";
import type { ToolViewContext, ViewLine, ViewSection } from "@veyyon/view";

/** Each shape an agent's output takes, and a piece of text the card shows only when it draws the value. */
const OUTPUTS: ReadonlyArray<{ output: string; marker: string; parses: boolean }> = [
	{ output: "{}", marker: "{}", parses: true },
	{ output: "[]", marker: "[]", parses: true },
	{ output: '{"alpha":1}', marker: "alpha", parses: true },
	{ output: '["beta"]', marker: "beta", parses: true },
	{ output: "{oops", marker: "{oops", parses: false },
	{ output: "plain gamma", marker: "gamma", parses: false },
	{ output: "delta\nepsilon", marker: "delta", parses: false },
];

const MISSING_YIELD = "SYSTEM WARNING: Agent exited without calling yield tool";

function settled(output: string): TaskToolDetails {
	const result: SingleResult = {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		task: "brief",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
	return { projectAgentsDir: null, results: [result], totalDurationMs: 1 };
}

function live(output: string): TaskToolDetails {
	const progress: AgentProgress = {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "brief",
		recentTools: [],
		recentOutput: [output],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 1,
	};
	return { projectAgentsDir: null, results: [], totalDurationMs: 1, progress: [progress] };
}

/** The card body's rows as plain text, one string per row. */
function bodyRows(details: TaskToolDetails, expanded: boolean): string[] {
	const context: ToolViewContext = { expanded };
	const view = taskToolView.renderResult({ content: [{ type: "text", text: "" }], details }, context, undefined);
	if (view.kind !== "framedBlock") throw new Error(`the task card is a framed block, not a ${view.kind}`);
	const tree = view.sections.find((section: ViewSection) => section.tree !== undefined);
	expect(tree).toBeDefined();
	return (tree?.lines ?? []).map((line: ViewLine) => line.map(span => span.text).join(""));
}

interface Surface {
	name: string;
	details(output: string): TaskToolDetails;
	expandedOnly: boolean;
	warned: boolean;
}

const SURFACES: readonly Surface[] = [
	{ name: "a settled agent", details: settled, expandedOnly: false, warned: false },
	{
		name: "a settled agent that never yielded",
		details: output => settled(`${MISSING_YIELD}\n${output}`),
		expandedOnly: false,
		warned: true,
	},
	// A running agent's output is drawn only on an expanded card.
	{ name: "a running agent", details: live, expandedOnly: true, warned: false },
];

describe("an agent's output is drawn once, under at most one Output heading", () => {
	for (const surface of SURFACES) {
		for (const expanded of surface.expandedOnly ? [true] : [false, true]) {
			for (const { output, marker, parses } of OUTPUTS) {
				it(`${surface.name}, ${expanded ? "expanded" : "collapsed"}: ${JSON.stringify(output)}`, () => {
					const rows = bodyRows(surface.details(output), expanded);
					const headings = rows.filter(row => row === "Output").length;
					const summarized = !expanded && parses && !surface.warned;
					expect(headings).toBe(summarized ? 0 : 1);
					expect(rows.filter(row => row !== "Output" && row.includes(marker))).toHaveLength(1);
				});
			}
		}
	}
});
