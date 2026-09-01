/**
 * WHY THIS EXISTS.
 *
 * `contracts/view` is a contract only if a second host can draw what the first one draws. While the
 * terminal was the only implementation, every member of the model was free to mean "whatever the
 * terminal does with it", and nothing would have failed: a tone nobody else maps, a section shape
 * only a column-measured renderer can honour, a span whose bytes are escape sequences.
 *
 * The class this closes is a view member that cannot be drawn without a terminal. Every kind of the
 * `ToolView` union is drawn here, from the same renderer object a plugin hands the terminal, and the
 * output is HTML with no escape byte in it.
 *
 * WHAT IT DOES NOT CATCH. Whether the two hosts look ALIKE -- they must not, and the differential
 * suites in `packages/coding-agent/test/differential` are what pin the terminal's own bytes. This
 * says the model carries enough for a second answer, not that the answers agree.
 */

import { describe, expect, it } from "bun:test";
import type { ToolView, ToolViewRenderer } from "@veyyon/view";
import { drawToolView, guiToolRenderer, VIEW_KINDS_DRAWN } from "../src/draw-tool-view";

/** One view of every kind the contract declares, keyed by the kind it is. */
const ONE_OF_EACH_KIND: Record<ToolView["kind"], ToolView> = {
	statusRow: { kind: "statusRow", status: "success", title: "Read", description: "src/app.ts" },
	textBlock: { kind: "textBlock", spans: [{ text: "waiting for the model" }] },
	headedBlock: {
		kind: "headedBlock",
		header: { kind: "statusRow", status: "running", title: "Task" },
		lines: [[{ text: "one" }], [{ text: "two" }]],
	},
	framedBlock: {
		kind: "framedBlock",
		header: { kind: "statusRow", status: "error", title: "Bash" },
		state: "error",
		sections: [{ label: "output", lines: [[{ text: "command not found" }]] }],
	},
	notice: { kind: "notice", state: "warning", headline: [{ text: "the edit was rejected" }] },
};

describe("a tool view reaches a second host unchanged", () => {
	it("draws every kind the contract declares", () => {
		// The keys come from the host's own exhaustive record, so a kind added to the union is a type
		// error here and in the terminal before it is a missing case at run time.
		expect(Object.keys(ONE_OF_EACH_KIND).sort()).toEqual(Object.keys(VIEW_KINDS_DRAWN).sort());
		for (const [kind, view] of Object.entries(ONE_OF_EACH_KIND)) {
			const html = drawToolView(view);
			expect(html.startsWith("<"), `${kind} drew no element`).toBe(true);
			expect(html.endsWith(">"), `${kind} drew no element`).toBe(true);
		}
	});

	it("writes no terminal escape byte, whatever the view carried", () => {
		for (const view of Object.values(ONE_OF_EACH_KIND)) {
			expect(drawToolView(view)).not.toContain("\x1b");
		}
	});

	/**
	 * The claim in one assertion: the object a plugin hands the terminal is handed to this host
	 * instead, and both halves answer. The renderer names no host, which is what lets it.
	 */
	it("draws both halves of a plugin's own renderer", () => {
		const renderer: ToolViewRenderer<{ path: string }, { lines: number }> = {
			renderCall: args => ({ kind: "statusRow", status: "running", title: "Read", description: args.path }),
			renderResult: (result, _context, args) => ({
				kind: "statusRow",
				status: "success",
				title: "Read",
				description: args?.path ?? "",
				meta: [[{ text: `${result.lines} lines` }]],
			}),
		};

		const card = guiToolRenderer(renderer);
		const call = card.renderCall?.({ path: "src/app.ts" }, { expanded: false });
		const done = card.renderResult?.({ lines: 12 }, { expanded: false }, { path: "src/app.ts" });

		expect(call).toContain('data-status="running"');
		expect(call).toContain("src/app.ts");
		expect(done).toContain('data-status="success"');
		expect(done).toContain("12 lines");
	});

	it("offers only the halves the renderer declared", () => {
		const callOnly = guiToolRenderer<{ path: string }, never>({
			renderCall: args => ({ kind: "textBlock", spans: [{ text: args.path }] }),
		});

		expect(typeof callOnly.renderCall).toBe("function");
		expect(callOnly.renderResult).toBeUndefined();
	});

	/**
	 * The disclosure state is the one thing the surface knows and the tool reads, and it is a
	 * boolean in both hosts. A renderer that varied with it in the terminal varies with it here.
	 */
	it("passes the disclosure state through to the tool's own renderer", () => {
		const renderer: ToolViewRenderer<undefined, string> = {
			renderResult: (result, context) => ({
				kind: "textBlock",
				spans: [{ text: context.expanded ? result : result.slice(0, 3) }],
			}),
		};
		const card = guiToolRenderer(renderer);

		expect(card.renderResult?.("abcdef", { expanded: false })).not.toContain("abcdef");
		expect(card.renderResult?.("abcdef", { expanded: true })).toContain("abcdef");
	});
});
