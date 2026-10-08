/**
 * A spinner step draws a streaming card again only when what it drew reads the frame, and on every
 * step the card shows what the same card drawn from nothing at that moment shows.
 *
 * WHAT THIS CLOSES. A streaming `write`, `edit` or `apply_patch` card moves its spinner every 80ms,
 * and each step drew the whole card again for one glyph: the producer rebuilt the block, the view
 * projected the call again and the code section highlighted the whole file. A 1,500-line streaming
 * edit spent 175.6µs a step that way and spends 10.5µs once the body is kept. The glyph is read where
 * the framed block composes its rows, so the body stays drawn and the glyph still moves.
 *
 * THE CLASS. Two halves. Drawn too often: a step that draws again a card whose body does not read
 * the frame. Drawn too rarely: a step that keeps a drawing whose body does read it, so a glyph sits
 * on the frame it was drawn at. The sweep drives the real streaming tools, then every kind of view a
 * tool can return as the call of a streaming card, with the frame in each place a view can carry it:
 * a running header, the arrival row of a running block, a running span in a plain row, a list or a
 * tree, the header of a headed block, a status row and a text block. A view renderer that reads the
 * frame from its context and a renderer of the tool's own are driven too. `VIEW_KINDS` is typed by
 * `ToolView["kind"]`, so a new kind fails the type check until a case drives it. Each step is
 * compared byte for byte with a second card whose drawing is dropped before it renders, and what a
 * step costs is pinned per case by exact equality.
 *
 * WHAT IT DOES NOT CATCH. The set of streaming tools is the component's own list, so a fourth tool
 * that streams its arguments is driven here only once a row names it. A frame read outside the
 * component's draw and outside a framed block's render would not be seen by either half. The multi
 * file edit's pending row reads the frame through the same accessor the views do and is not driven.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	SPINNER_GLYPH_ADVANCE_MS,
	type ToolExecutionComponent,
} from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import * as drawToolViewModule from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { transitionsEnabled } from "@veyyon/coding-agent/theme/shimmer";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { toolViewDefinitions } from "@veyyon/coding-agent/tools/view-registry";
import { Text, type TUI } from "@veyyon/tui";
import type { StatusRowView, ToolView, ToolViewContext, ToolViewRenderer, ViewLine } from "@veyyon/view";
import { createToolExecution } from "../../../helpers/tool-execution";

const WIDTH = 100;
const STEPS = 3;
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

const BODY = Array.from({ length: 200 }, (_, index) => `const value${index} = compute(${index});`).join("\n");
const WRITE_ARGS = { path: "src/generated/values.ts", content: BODY };
/** An edit in the patch language the default edit mode reads, still arriving: no `*** End Patch` yet. */
const EDIT_ARGS = {
	input: `*** Begin Patch\n*** Add File: src/generated/values.ts\n${BODY.split("\n")
		.map(line => `+${line}`)
		.join("\n")}`,
};

const RUNNING_ROW: ViewLine = [{ text: "", status: "running" }, { text: " compiling the loader" }];
const SETTLED_ROW: ViewLine = [{ text: "src/generated/values.ts" }];
const CODE_ROWS: ViewLine[] = BODY.split("\n").map(text => [{ text }]);

function header(status: StatusRowView["status"]): StatusRowView {
	return { kind: "statusRow", status, title: "Write", description: "src/generated/values.ts" };
}

/** What one step of a card costs and whether it changed the bytes. */
interface StepCost {
	/** Tool views drawn by the step's render. */
	draws: number;
	/** Calls the view renderer projected, or the tool's own renderer drew, for the step's render. */
	projections: number;
	/** Whether the step's render showed different bytes from the render before it. */
	moved: boolean;
}

interface Case {
	tool: string;
	args: unknown;
	/** The tool the card is built with, when it is not the registered one, and the calls it counts. */
	renderer?: () => { tool: AgentTool | undefined; counted: () => number };
	/** Every step of the case costs this. */
	step: StepCost;
}

/** A tool named as the streaming tool, whose call is drawn from `view`. */
function viewTool(tool: string, view: (context: ToolViewContext) => ToolView): Case["renderer"] {
	return () => {
		let projected = 0;
		const renderer: ToolViewRenderer = {
			renderCall: (_args, context) => {
				projected++;
				return view(context);
			},
		};
		return { tool: { name: tool, label: "Write", view: renderer } as unknown as AgentTool, counted: () => projected };
	};
}

/** A step that draws nothing and moves the glyph the framed block reads at render. */
const KEPT: StepCost = { draws: 0, projections: 0, moved: true };
/** A step that draws the call again from the block it already has. */
const REDRAWN: StepCost = { draws: 1, projections: 0, moved: true };
/** A step that changes nothing the card shows. */
const STILL: StepCost = { draws: 0, projections: 0, moved: false };

/**
 * One case per kind of view a tool returns, with the frame where that kind can carry it. Typed by the
 * union, so a kind added to `ToolView` fails the type check here until a case draws it.
 */
const VIEW_KINDS: Record<ToolView["kind"], Record<string, Case>> = {
	framedBlock: {
		"a framed block with a running header": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("running"),
				state: "running",
				sections: [{ code: { language: "ts" }, lines: CODE_ROWS }],
			})),
			step: KEPT,
		},
		"a framed block arriving under a settled header": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("pending"),
				state: "running",
				sections: [{ code: { language: "ts" }, lines: CODE_ROWS }],
			})),
			step: KEPT,
		},
		"a framed block with a running span in a plain row": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("success"),
				sections: [{ lines: [SETTLED_ROW, RUNNING_ROW] }],
			})),
			step: REDRAWN,
		},
		"a framed block with a running span in a list": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("success"),
				sections: [{ list: true, lines: [SETTLED_ROW, RUNNING_ROW] }],
			})),
			step: REDRAWN,
		},
		"a framed block with a running span in a tree": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("success"),
				sections: [
					{ tree: { depth: [0, 1], opens: [true, true], last: [true, true] }, lines: [SETTLED_ROW, RUNNING_ROW] },
				],
			})),
			step: REDRAWN,
		},
		"a settled framed block": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({
				kind: "framedBlock",
				header: header("success"),
				state: "success",
				sections: [{ code: { language: "ts" }, lines: CODE_ROWS }],
			})),
			step: STILL,
		},
	},
	headedBlock: {
		"a headed block with a running header": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({ kind: "headedBlock", header: header("running"), lines: [SETTLED_ROW] })),
			step: REDRAWN,
		},
	},
	statusRow: {
		"a running status row": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => header("running")),
			step: REDRAWN,
		},
	},
	textBlock: {
		"a text block with a running span": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({ kind: "textBlock", spans: RUNNING_ROW })),
			step: REDRAWN,
		},
	},
	notice: {
		"a notice": {
			tool: "write",
			args: WRITE_ARGS,
			renderer: viewTool("write", () => ({ kind: "notice", state: "info", headline: SETTLED_ROW })),
			step: STILL,
		},
	},
};

/** The registered views of the tools that stream their arguments into a running card. */
function registered(tool: "write" | "edit" | "apply_patch"): Case["renderer"] {
	return () => {
		const view = toolViewDefinitions[tool]?.view;
		if (!view?.renderCall) throw new Error(`the view registry has no \`${tool}\` call view`);
		const { renderCall } = view;
		let projected = 0;
		spyOn(view, "renderCall").mockImplementation((args, context) => {
			projected++;
			return renderCall.call(view, args, context);
		});
		return { tool: undefined, counted: () => projected };
	};
}

const CASES: Record<string, Case> = {
	"a streaming write": { tool: "write", args: WRITE_ARGS, renderer: registered("write"), step: KEPT },
	"a streaming edit": { tool: "edit", args: EDIT_ARGS, renderer: registered("edit"), step: KEPT },
	"a streaming apply_patch": { tool: "apply_patch", args: EDIT_ARGS, renderer: registered("apply_patch"), step: KEPT },
	...Object.fromEntries(Object.values(VIEW_KINDS).flatMap(kind => Object.entries(kind))),
	"a view renderer that reads the frame from its context": {
		tool: "write",
		args: WRITE_ARGS,
		renderer: viewTool("write", context => ({ kind: "statusRow", title: `frame ${context.frame ?? "none"}` })),
		step: { draws: 1, projections: 1, moved: true },
	},
	"a renderer of the tool's own": {
		tool: "write",
		args: WRITE_ARGS,
		renderer: () => {
			let drawn = 0;
			const tool = {
				name: "write",
				label: "Write",
				renderCall(_args: unknown, state: { spinnerFrame?: number }) {
					drawn++;
					return new Text(`frame ${state.spinnerFrame ?? "none"}`, 0, 0);
				},
			};
			return { tool: tool as unknown as AgentTool, counted: () => drawn };
		},
		step: { draws: 0, projections: 1, moved: true },
	},
};

/** The tool views drawn from here on, each drawn as before. */
function countDraws(): { count: number } {
	const drawn = { count: 0 };
	const original = drawToolViewModule.drawToolView;
	spyOn(drawToolViewModule, "drawToolView").mockImplementation((...args) => {
		drawn.count++;
		return original(...args);
	});
	return drawn;
}

function cardOf(test: Case, tool: AgentTool | undefined): ToolExecutionComponent {
	return createToolExecution(test.tool, test.args, {}, tool, ui, process.cwd());
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.transitions": "off" } });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a spinner step on a streaming card", () => {
	/**
	 * The rail walks a tone down its column on an interval of its own, which moves a row's bytes with
	 * no frame involved: the comparisons below take it disarmed, so only the frame can move a byte.
	 */
	it("is compared with the rail's own motion disarmed", () => {
		expect(transitionsEnabled()).toBe(false);
	});

	it.each(Object.entries(CASES))("costs what %s draws and shows what a fresh drawing shows", async (_name, test) => {
		vi.useFakeTimers();
		const counted = test.renderer?.();
		const draws = countDraws();
		const subject = cardOf(test, counted?.tool);
		// A second card on the same clock, whose drawing is dropped before every render it is asked for.
		const reference = cardOf(test, counted?.tool);
		// An edit computes its diff preview off the frame; a preview that lands mid-sweep is a new call
		// to draw rather than a step, so the sweep starts once both cards have theirs.
		await Promise.all([subject.whenPreviewSettled(), reference.whenPreviewSettled()]);

		let shown = subject.render(WIDTH).join("\n");
		const costs: StepCost[] = [];
		for (let step = 0; step < STEPS; step++) {
			vi.advanceTimersByTime(SPINNER_GLYPH_ADVANCE_MS);
			const before = { draws: draws.count, projections: counted?.counted() ?? 0 };
			const next = subject.render(WIDTH).join("\n");
			costs.push({
				draws: draws.count - before.draws,
				projections: (counted?.counted() ?? 0) - before.projections,
				moved: next !== shown,
			});
			reference.releaseRenderCache();
			expect(next).toBe(reference.render(WIDTH).join("\n"));
			shown = next;
		}
		expect(costs).toEqual(Array.from({ length: STEPS }, () => test.step));
	});
});
