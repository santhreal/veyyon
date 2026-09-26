/**
 * WHY: Removing a tool card must stop its clocks and detach its producer listener,
 * not merely dispose its children. Every registered view is exercised in pending
 * and settled states. This covers detached render work, not cancellation of the
 * tool execution itself or image protocol cleanup.
 *
 * Disposal seals the card's producer, and a sealed block nobody reads must not be
 * projected: a rebuilt transcript disposes every card it held, and projecting each
 * one's sealed view on the way out doubled the cost of the rebuild. The projection
 * suite counts view callbacks, so it catches an eager build on any disposal path;
 * it does not catch work a view does outside its callbacks.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AnyAgentTool } from "@veyyon/agent-core";
import { type Component, Container, type TUI } from "@veyyon/tui";
import { ChatTranscriptBuilder } from "../src/modes/terminal/components/transcript/chat-transcript-builder";
import { ToolExecutionProducer } from "../src/presentation/tool-execution";
import { initTheme } from "../src/theme/theme";
import { toolViewDefinitions } from "../src/tools/view-registry";
import { useFullColor } from "./helpers/theme-assertions";
import { createToolExecution } from "./helpers/tool-execution";

useFullColor();

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A tool whose view counts every projection of its call and its result. */
function countingTool(): { tool: AnyAgentTool; projections: () => number } {
	let projections = 0;
	const tool = {
		name: "widget",
		label: "widget",
		view: {
			renderCall: () => {
				projections++;
				return { kind: "statusRow", title: "call" };
			},
			renderResult: (result: { content: readonly { text?: string }[] }) => {
				projections++;
				return { kind: "statusRow", title: result.content[0]?.text ?? "" };
			},
		},
	} as unknown as AnyAgentTool;
	return { tool, projections: () => projections };
}

function frameSink(frames: string[]): TUI {
	return {
		requestRender() {
			frames.push("full viewport repaint");
		},
		requestComponentRender(component: Component) {
			frames.push(component.render(100).join("\n"));
		},
	} as unknown as TUI;
}

const args = {
	action: "run",
	op: "run",
	language: "py",
	code: "print('value')",
	command: "printf value",
	input: "value",
	path: "src/example.ts",
};

describe("disposing a tool card stops detached render work", () => {
	for (const name of Object.keys(toolViewDefinitions)) {
		for (const settled of [false, true]) {
			for (const disposal of ["parent", "presentation-clear", "presentation-replace"] as const) {
				it(`${name} stops after ${disposal} disposal while ${settled ? "settled" : "pending"}`, () => {
					vi.useFakeTimers();
					const frames: string[] = [];
					const tui = frameSink(frames);
					const card = createToolExecution(name, args, {}, undefined, tui, process.cwd());
					const builder = new ChatTranscriptBuilder({
						ui: tui,
						cwd: process.cwd(),
						requestRender: () => tui.requestRender(),
					});
					const parent = disposal === "parent" ? new Container() : builder.container;
					parent.addChild(card);
					card.render(100);
					vi.advanceTimersByTime(240);
					if (settled) {
						card.setArgsComplete();
						card.updateResult({ content: [{ type: "text", text: "completed" }] }, false);
						card.render(100);
					}
					if (disposal === "parent") parent.disposeChildren();
					else if (disposal === "presentation-clear") builder.clearTranscript();
					else builder.setTranscriptBlocks([]);
					frames.length = 0;
					vi.advanceTimersByTime(2_000);
					expect(parent.render(100)).toEqual([]);
					expect(frames).toEqual([]);
				});
			}
		}
	}

	it("keeps reused renderer resources live and disposes replaced resources", () => {
		vi.useFakeTimers();
		const widgets: Component[] = [];
		const makeWidget = (): Component => {
			let ticks = 0;
			const timer = setInterval(() => {
				ticks++;
			}, 100);
			const widget: Component = {
				render: () => [`Tick ${ticks}`],
				dispose: () => clearInterval(timer),
			};
			widgets.push(widget);
			return widget;
		};
		let current = makeWidget();
		try {
			const card = createToolExecution(
				"example",
				{},
				{
					customRenderer: { renderResult: () => current },
				},
			);
			// A card replaces its renderer's component at the frame that draws the change, so each
			// change is followed by that frame.
			card.updateResult({ content: [{ type: "text", text: "first" }] }, false);
			card.render(80);
			vi.advanceTimersByTime(100);
			card.setExpanded(true);
			card.render(80);
			vi.advanceTimersByTime(100);
			expect(current.render(80)).toEqual(["Tick 2"]);
			const previous = current;
			current = makeWidget();
			card.updateResult({ content: [{ type: "text", text: "second" }] }, false);
			card.render(80);
			vi.advanceTimersByTime(100);
			expect(previous.render(80)).toEqual(["Tick 2"]);
			expect(current.render(80)).toEqual(["Tick 1"]);
			card.dispose();
			vi.advanceTimersByTime(100);
			expect(current.render(80)).toEqual(["Tick 1"]);
		} finally {
			for (const widget of widgets) widget.dispose?.();
		}
	});

	it("disposes resources belonging to child components", () => {
		vi.useFakeTimers();
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 100);
		const child: Component = {
			render: () => [`Tick ${ticks}`],
			dispose: () => clearInterval(timer),
		};
		try {
			const card = createToolExecution(
				"example",
				{},
				{
					customRenderer: { renderResult: () => child },
				},
			);
			card.updateResult({ content: [{ type: "text", text: "completed" }] }, false);
			vi.advanceTimersByTime(200);
			expect(card.render(80).join("\n")).toContain("Tick 2");
			card.dispose();
			vi.advanceTimersByTime(200);
			expect(child.render(80)).toEqual(["Tick 2"]);
		} finally {
			clearInterval(timer);
		}
	});

	it("detaches the producer on direct disposal and remains safe to dispose twice", () => {
		vi.useFakeTimers();
		const frames: string[] = [];
		const producer = new ToolExecutionProducer({ toolName: "example", args: { input: "initial" } });
		const card = createToolExecution(producer.block, { dataSource: producer, ui: frameSink(frames) });
		producer.updateArgs({ input: "before disposal" });
		expect(frames.join("\n")).toContain("before disposal");
		card.dispose();
		card.dispose();
		frames.length = 0;
		producer.updateArgs({ input: "after disposal" });
		vi.advanceTimersByTime(2_000);
		expect(frames).toEqual([]);
	});

	for (const disposal of ["parent", "presentation-clear", "presentation-replace"] as const) {
		it(`projects no view for a card removed by ${disposal} disposal`, () => {
			const { tool, projections } = countingTool();
			const tui = frameSink([]);
			const card = createToolExecution("widget", {}, {}, tool, tui, process.cwd());
			const builder = new ChatTranscriptBuilder({ ui: tui, cwd: process.cwd(), requestRender: () => {} });
			const parent = disposal === "parent" ? new Container() : builder.container;
			parent.addChild(card);
			card.updateResult({ content: [{ type: "text", text: "completed" }] }, false);
			expect(card.render(100).join("\n")).toContain("completed");
			const drawn = projections();
			if (disposal === "parent") parent.disposeChildren();
			else if (disposal === "presentation-clear") builder.clearTranscript();
			else builder.setTranscriptBlocks([]);
			expect(projections()).toBe(drawn);
		});
	}

	it("projects an unobserved producer's block when read, from its latest state", () => {
		const { tool, projections } = countingTool();
		const producer = new ToolExecutionProducer({ toolName: "widget", args: {}, tool });
		producer.updateResult({ content: [{ type: "text", text: "first" }] });
		expect(producer.block).toMatchObject({ display: { resultView: { title: "first" } } });
		const read = projections();
		producer.updateResult({ content: [{ type: "text", text: "second" }] });
		producer.seal();
		expect(projections()).toBe(read);
		// The context the card last drew with, which is the path a sealing card reads the block by.
		expect(producer.produceBlock({})).toMatchObject({
			status: "succeeded",
			display: { resultView: { title: "second" }, policies: { sealed: true } },
		});
		const built = projections();
		expect(built).toBeGreaterThan(read);
		expect(producer.block).toBe(producer.produceBlock());
		expect(projections()).toBe(built);
	});
});
