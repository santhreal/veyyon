/**
 * WHY THIS EXISTS.
 *
 * `contracts/view` is a contract only if every host fails closed when a kind is added. The GUI
 * host already pins that with `VIEW_KINDS_DRAWN`. The terminal used to fall through to a one-line
 * `Text` for any kind that was not a framed block, a headed block or a notice, so a new kind would
 * have compiled, drawn as a status row or a text block, and never said so.
 *
 * THE CLASS THIS CLOSES. A ToolView kind that the terminal draws without naming. The keys come from
 * the host's own exhaustive record, so a kind added to the union is a type error here before it is
 * a missing case at run time.
 *
 * WHAT IT DOES NOT CATCH. Whether the drawn bytes match main — that is the converted-tool
 * differential suites. This says every kind has a case, not that the case is the right picture.
 */
import { describe, expect, it } from "bun:test";
import { drawToolView, VIEW_KINDS_DRAWN } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import type { ToolView } from "@veyyon/view";
import { useDifferentialTheme } from "../../../differential/harness";

useDifferentialTheme();

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

describe("the terminal draws every tool view kind", () => {
	it("names every kind the contract declares", () => {
		expect(Object.keys(ONE_OF_EACH_KIND).sort()).toEqual(Object.keys(VIEW_KINDS_DRAWN).sort());
	});

	it("returns a component for every kind", () => {
		for (const [kind, view] of Object.entries(ONE_OF_EACH_KIND)) {
			const drawn = drawToolView(view, theme);
			expect(typeof drawn.render, `${kind} drew no component`).toBe("function");
		}
	});
});
