/**
 * A tool that draws its own card obeys the render policy its registry entry states.
 *
 * WHY THIS SUITE EXISTS. The terminal states two things about a card that the card itself cannot:
 * whether the call row survives the arrival of the result (`mergeCallAndResult`), and whether the
 * call render is a live widget that must not be painted for a call that never ran
 * (`callIsLiveWidget`). Both live in the renderer registry, beside the tool's entry.
 *
 * `ToolExecutionComponent` renders a tool through one of two branches: a tool that draws itself, and
 * the shared registry for one that does not. The policy was read off the TOOL in the first branch
 * and off the ENTRY in the second, which agreed for as long as a tool that drew itself was a tool
 * that carried its own renderer. Converting a tool to a `ToolView` broke that: the tool gains a
 * `view`, so it moves to the first branch, while its policy stays in the entry. Every merged
 * converted card — `debug`, `resolve`, `retain`, `recall`, `reflect` — drew its call row and its
 * result card one under the other on the live path, with the same header twice, while a rebuilt
 * transcript of the same call drew one card. Nothing failed: the rebuilt path was the one under test.
 *
 * THE DEFECT CLASS THIS CLOSES. A card policy that one render path honours and the other drops, for
 * any tool that draws itself, whether it draws through a renderer or through a view.
 *
 * HOW IT IS DERIVED. The sweep reads `toolRenderers` at run time and asks every entry in it the same
 * question through the real component, so a tool added to the registry tomorrow is covered without
 * an edit here, and a merged entry that stops merging fails in its own row.
 *
 * MUTATIONS OBSERVED RED. Reading `mergeCallAndResult` off the tool alone (the defect) fails every
 * merged row; reading `callIsLiveWidget` off the tool alone fails the never-ran cell; letting the
 * tool's own `false` lose to the entry's `true` fails the override cell.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves a policy is the RIGHT one for a tool — that a merged
 * card should merge — only that both paths apply the one the entry states. The animation policies
 * (`animatedPendingPreview`, `animatedPartialResult`) are read from the registry by both paths
 * already and are covered by the spinner suites, not here.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnyAgentTool } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ResolveTool } from "@veyyon/coding-agent/tools/agent/resolve";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { DebugTool } from "@veyyon/coding-agent/tools/shell/debug";
import type { TUI } from "@veyyon/tui";
import type { StatusRowView } from "@veyyon/view";
import { createToolExecution } from "./helpers/tool-execution";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

/** The two rows a stub card can draw, worded so a duplicated header is visible in the rows. */
const CALL_ROW = "STUBCALLROW";
const RESULT_ROW = "STUBRESULTROW";

/**
 * A tool that draws itself through a view and states no policy of its own.
 *
 * This is the shape every converted tool has: a `view` and nothing else the component can read a
 * policy from. It carries the name it is asked about, because the component resolves the entry by
 * tool name, which is the lookup under test.
 */
function viewOnlyTool(name: string): AnyAgentTool {
	return {
		name,
		label: name,
		view: {
			renderCall: (): StatusRowView => ({ kind: "statusRow", status: "pending", title: CALL_ROW }),
			renderResult: (): StatusRowView => ({ kind: "statusRow", status: "success", title: RESULT_ROW }),
		},
	} as unknown as AnyAgentTool;
}

function rowsOf(component: { render(width: number): readonly string[] }): string {
	return component
		.render(80)
		.map(line => stripVTControlCharacters(line).trimEnd())
		.join("\n");
}

/** The card a live call draws once its result has arrived, which is where the two policies apply. */
function settledCard(name: string, tool: AnyAgentTool, details?: unknown): string {
	const block = createToolExecution(name, {}, {}, tool, ui);
	block.setArgsComplete();
	block.updateResult({ content: [{ type: "text", text: "ok" }], details });
	return rowsOf(block);
}

function session(): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

/** Every registered tool name whose entry states that the result replaces the call row. */
function mergedNames(): string[] {
	return Object.keys(toolRenderers).filter(name => toolRenderers[name]?.mergeCallAndResult === true);
}

function unmergedNames(): string[] {
	return Object.keys(toolRenderers).filter(name => toolRenderers[name]?.mergeCallAndResult !== true);
}

describe("the merge policy a registry entry states", () => {
	it("has both kinds of entry to sweep, so neither loop below is vacuous", () => {
		expect(mergedNames().length).toBeGreaterThan(0);
		expect(unmergedNames().length).toBeGreaterThan(0);
	});

	it("replaces the call row with the result for every entry that states it", async () => {
		await initTheme();
		const drawnBoth = mergedNames().filter(name => {
			const card = settledCard(name, viewOnlyTool(name));
			return card.includes(CALL_ROW);
		});
		expect(drawnBoth).toEqual([]);
	});

	it("keeps the call row beside the result for every entry that states nothing", async () => {
		await initTheme();
		const lostTheCall = unmergedNames().filter(name => {
			const card = settledCard(name, viewOnlyTool(name));
			return !card.includes(CALL_ROW);
		});
		expect(lostTheCall).toEqual([]);
	});

	/**
	 * The tool still outranks its entry, which is what a custom tool declaring its own policy relies
	 * on: the registry is the fallback, not the authority.
	 */
	it("lets a tool state a policy its entry does not", async () => {
		await initTheme();
		const unmerged = unmergedNames()[0];
		const tool = { ...viewOnlyTool(unmerged), mergeCallAndResult: true } as unknown as AnyAgentTool;
		const card = settledCard(unmerged, tool);
		expect(card).toContain(RESULT_ROW);
		expect(card).not.toContain(CALL_ROW);
	});
});

/**
 * The live card of two real converted tools, which is the path the defect was on.
 *
 * The sweep above drives stubs, so it proves the resolution and not the tools. These two construct
 * the real thing and read the rows back: a merged card is the result and nothing above it.
 */
describe("the live card of a converted tool", () => {
	it("draws the resolve decision alone, not the call row above it", async () => {
		await initTheme();
		const card = settledCard("resolve", new ResolveTool(session()) as unknown as AnyAgentTool, {
			action: "apply",
			label: "an edit",
			reason: "it is right",
		});
		// The decision the notice states, and no trace of the call row, which words itself `Resolve: apply`.
		expect(card).toContain("Accept:");
		expect(card).not.toContain("Resolve");
	});

	it("draws the debug card once, not a call row above it", async () => {
		await initTheme();
		const card = settledCard("debug", new DebugTool(session()) as unknown as AnyAgentTool, {
			action: "threads",
		});
		expect(card.match(/Debug/g)?.length ?? 0).toBe(1);
	});
});

/**
 * A call that never reached the tool, where the second policy applies.
 *
 * `ask` paints an answerable question in its call render, so a call the loop never dispatched must
 * not paint it: the card falls back to the tool's label. The entry states that, and the component
 * reads it for a view-only tool the same way.
 */
describe("the live-widget policy a registry entry states", () => {
	it("falls back to the label for a call that never ran", async () => {
		await initTheme();
		const widgetNames = Object.keys(toolRenderers).filter(name => toolRenderers[name]?.callIsLiveWidget === true);
		expect(widgetNames.length).toBeGreaterThan(0);
		for (const name of widgetNames) {
			const card = settledCard(name, viewOnlyTool(name), { __synthetic: true, executed: false });
			expect(card).not.toContain(CALL_ROW);
			expect(card).toContain(name);
		}
	});
});
