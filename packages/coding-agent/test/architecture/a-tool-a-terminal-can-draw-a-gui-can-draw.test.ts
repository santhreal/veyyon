/**
 * WHY: a tool call reaches two renderer stacks. `src/tools/renderers.ts` builds a
 * TUI `Component`, and `@veyyon/tool-render` builds host-agnostic React that the
 * HTML export, collab-web and the stats dashboard all draw. A second front end
 * gets the React one, because it is the only stack that does not import
 * `@veyyon/tui`.
 *
 * The defect class: a tool ships with a TUI renderer and no host-agnostic
 * counterpart, so the terminal draws a rendered view and every other host draws
 * raw JSON. Nothing caught it, which is how the five `vibe_*` tools ended up
 * terminal-only. The failure is silent in both directions — the TUI author never
 * sees the gap, and the GUI shows something that looks deliberate.
 *
 * The invariant is asserted at the choke point every tool passes through:
 * `resolveToolRenderer` falling back to `genericRenderer` IS the observable
 * "this host cannot draw it". Both sets are derived from the live registries at
 * run time, so registering a tool in one stack and not the other turns this red
 * until someone records a decision.
 *
 * What it does not catch: a counterpart that exists and renders badly, and a
 * divergence in what the two stacks choose to show. Only presence is mechanical.
 */

import { describe, expect, it } from "bun:test";
import { genericRenderer, resolveToolRenderer } from "@veyyon/tool-render";
import { toolRenderers } from "../../src/tools/renderers";

/**
 * Tools the terminal renders that deliberately have no host-agnostic
 * counterpart, pinned by exact equality. Empty, and adding a row is a decision
 * with a reason beside it — never a way to quiet this test.
 */
const TERMINAL_ONLY_BY_DECISION: string[] = [];

function terminalRenderedTools(): string[] {
	return Object.keys(toolRenderers).sort();
}

/** Tools whose host-agnostic lookup falls through to the generic JSON view. */
function withoutHostAgnosticRenderer(): string[] {
	return terminalRenderedTools().filter(name => resolveToolRenderer(name) === genericRenderer);
}

describe("a tool the terminal can draw", () => {
	/**
	 * Guards the sweep itself: an import that silently yields an empty registry
	 * would make every assertion below vacuously true.
	 */
	it("is swept from a registry that actually loaded", () => {
		const names = terminalRenderedTools();
		expect(names.length).toBeGreaterThan(20);
		expect(names).toContain("bash");
		expect(names).toContain("vibe_spawn");
	});

	it("can also be drawn by a host that never imports the terminal", () => {
		expect(withoutHostAgnosticRenderer()).toEqual(TERMINAL_ONLY_BY_DECISION);
	});

	/**
	 * The fallback has to be reachable, or the test above passes because
	 * `resolveToolRenderer` never returns `genericRenderer` for anything.
	 */
	it("is distinguishable from a tool neither stack knows", () => {
		expect(resolveToolRenderer("a_tool_that_does_not_exist")).toBe(genericRenderer);
	});
});

describe("the host-agnostic renderer for a terminal-rendered tool", () => {
	it("exposes the summary the chrome renders inline", () => {
		const missing = terminalRenderedTools().filter(name => typeof resolveToolRenderer(name).Summary !== "function");
		expect(missing).toEqual([]);
	});
});
