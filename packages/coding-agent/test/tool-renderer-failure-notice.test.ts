/**
 * A tool renderer that throws must say so in the transcript.
 *
 * A tool may supply `renderCall` and `renderResult`, and either can throw on an
 * unexpected payload. `ToolExecutionComponent` has always survived that, but the
 * surviving render is a DEGRADED one: the tool's name where its card should be,
 * raw output where its diff should be, and in the multi-file edit case an empty
 * box. Five call sites did that behind nothing louder than a `logger.warn`, which
 * no operator is reading mid-session, so a broken renderer looked exactly like a
 * tool that had nothing to show (Law 10: no silent fallback).
 *
 * Every case here asserts the notice is IN the rendered lines, because that is
 * the only channel the operator actually sees. The suite also pins that the
 * degraded content still arrives — a notice that replaced the output would trade
 * one information loss for another.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AnyAgentTool } from "@veyyon/agent-core";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { ToolExecutionProducer } from "@veyyon/coding-agent/presentation/tool-execution";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type ToolViewDefinition, toolViewDefinitions } from "@veyyon/coding-agent/tools/view-registry";
import { type Component, Text, type TUI } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

const WIDTH = 160;

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme();
});

/** Rendered lines with styling removed, wrapped rows re-joined for substring reads. */
function flatten(component: Component): string {
	return component
		.render(WIDTH)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function toolWith(
	renderers: Partial<Pick<AnyAgentTool, "renderCall" | "renderResult">>,
): AnyAgentTool & Pick<ToolViewDefinition, "mergeCallAndResult"> {
	return { name: "widget", label: "widget", ...renderers } as unknown as AnyAgentTool;
}

function boom(): never {
	throw new Error("payload has no rows");
}

it("retains disclosure context without repeating unchanged view callbacks", () => {
	let projections = 0;
	const tool = toolWith({});
	tool.view = {
		renderCall: (_args, context) => {
			projections++;
			return {
				kind: "statusRow",
				title: `${context.expanded ? "expanded" : "collapsed"} ${context.frame} ${context.frozen ? "frozen" : "live"}`,
			};
		},
	};
	const producer = new ToolExecutionProducer({ toolName: "widget", args: {}, tool });
	try {
		producer.produceBlock({ expanded: true, frame: 9, frozen: true });
		const previous = projections;
		expect(producer.produceBlock()).toMatchObject({ display: { callView: { title: "expanded 9 frozen" } } });
		expect(producer.produceBlock({ expanded: true, frame: 9, frozen: true })).toMatchObject({
			display: { callView: { title: "expanded 9 frozen" } },
		});
		expect(projections).toBe(previous);
		expect(producer.produceBlock({ expanded: false, frame: 10, frozen: false })).toMatchObject({
			display: { callView: { title: "collapsed 10 live" } },
		});
		expect(projections).toBe(previous + 1);
	} finally {
		producer.seal();
	}
});

describe("host renderer precedence", () => {
	it.each([
		["renderCall", false],
		["renderCall", true],
		["renderResult", false],
		["renderResult", true],
	] as const)("%s overrides view rendering with own view=%s", (phase, ownView) => {
		for (const name of ["widget", ...Object.keys(toolViewDefinitions)]) {
			const tool = toolWith({
				[phase]: function (this: AnyAgentTool) {
					return new Text(`host-${phase}: ${this.label}`, 0, 0);
				},
			});
			tool.name = name;
			tool.label = `label-${name}`;
			tool.mergeCallAndResult = false;
			if (ownView) {
				tool.view = {
					renderCall: () => ({ kind: "statusRow", title: "view-call" }),
					renderResult: () => ({ kind: "statusRow", title: "view-result" }),
				};
			}
			const component = createToolExecution(name, {}, {}, tool, uiStub);
			if (phase === "renderResult") component.updateResult({ content: [{ type: "text", text: "result" }] }, false);
			const text = flatten(component);
			expect(text).toContain(`host-${phase}: label-${name}`);
			expect(text).not.toContain(phase === "renderCall" ? "view-call" : "view-result");
			if (ownView && phase === "renderResult") expect(text).toContain("view-call");
			component.stopAnimation();
		}
	});
});

describe("renderCall throws", () => {
	it("reports the tool, the phase, and the failure", () => {
		const component = createToolExecution("widget", { id: 1 }, {}, toolWith({ renderCall: boom }), uiStub);

		const text = flatten(component);

		expect(text).toContain('tool "widget" call renderer threw');
		expect(text).toContain("payload has no rows");
		expect(text).toContain("showing the tool name only");
	});

	/** The degraded render is still the render: losing the tool name too would
	 * leave a block that says only that something broke. */
	it("still shows the tool label underneath the notice", () => {
		const component = createToolExecution("widget", { id: 1 }, {}, toolWith({ renderCall: boom }), uiStub);

		expect(flatten(component)).toContain("widget");
	});
});

describe("renderResult throws", () => {
	it("retains both phase failures when the result renderer also throws", () => {
		const tool = toolWith({});
		tool.mergeCallAndResult = false;
		tool.view = {
			renderCall: () => {
				throw new Error("call phase failed");
			},
			renderResult: () => {
				throw new Error("result phase failed");
			},
		};
		const component = createToolExecution("widget", {}, {}, tool, uiStub);
		component.updateResult({ content: [{ type: "text", text: "retained output" }] }, false);
		const text = flatten(component);
		expect(text).toContain('tool "widget" call renderer threw: call phase failed');
		expect(text).toContain('tool "widget" result renderer threw: result phase failed');
		expect(text).toContain("retained output");
	});

	function withResult(text: string, renderResult: () => never): ToolExecutionComponent {
		const component = createToolExecution(
			"widget",
			{ id: 1 },
			{},
			toolWith({ renderResult: renderResult as unknown as AnyAgentTool["renderResult"] }),
			uiStub,
		);
		component.updateResult({ content: text ? [{ type: "text", text }] : [] }, false);
		return component;
	}

	it("reports the result phase, distinctly from the call phase", () => {
		const text = flatten(withResult("done in 4ms", boom));

		expect(text).toContain('tool "widget" result renderer threw');
		expect(text).not.toContain("call renderer threw");
	});

	it("says it is showing raw output, and shows it", () => {
		const text = flatten(withResult("done in 4ms", boom));

		expect(text).toContain("showing raw output");
		expect(text).toContain("done in 4ms");
	});

	/** With no text content there is nothing to degrade to, and claiming "showing
	 * raw output" above an empty block would be a lie. */
	it("says there is nothing to show instead when the result carries no text", () => {
		const text = flatten(withResult("", boom));

		expect(text).toContain("there is no raw output to show instead");
		expect(text).not.toContain("showing raw output");
	});
});

describe("the notice as a signal", () => {
	/** The inline TUI paints no backgrounds and a monochrome terminal drops the
	 * foreground, so the marker has to be a glyph, present with styling stripped. */
	it("carries an error glyph that survives stripped styling", () => {
		const component = createToolExecution("widget", {}, {}, toolWith({ renderCall: boom }), uiStub);

		const line = component
			.render(WIDTH)
			.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
			.find(l => l.includes("renderer threw"));

		expect(line).toBeDefined();
		expect(line).toMatch(/^(?:✗||\[!!\])\s/);
	});

	/** A renderer that works must not pay for this: no notice, no glyph, nothing. */
	it("is absent when the renderer succeeds", () => {
		const component = createToolExecution(
			"widget",
			{},
			{},
			toolWith({
				renderCall: (() => ({ render: () => ["widget ok"], invalidate: () => {} })) as AnyAgentTool["renderCall"],
			}),
			uiStub,
		);

		const text = flatten(component);

		expect(text).toContain("widget ok");
		expect(text).not.toContain("renderer threw");
	});
});

describe("live view methods remain optional", () => {
	it.each(["renderCall", "renderResult"] as const)("omitting %s does not corrupt a live tool's card", absent => {
		const tool = toolWith({});
		tool.name = "read";
		tool.mergeCallAndResult = false;
		tool.view =
			absent === "renderCall"
				? { renderResult: () => ({ kind: "statusRow", title: "live result" }) }
				: { renderCall: () => ({ kind: "statusRow", title: "live call" }) };
		const component = createToolExecution("read", {}, {}, tool, uiStub);
		expect(flatten(component)).not.toContain("renderer threw");
		component.updateResult({ content: [{ type: "text", text: "raw result" }] }, false);
		const text = flatten(component);
		expect(text).not.toContain("renderer threw");
		expect(text).toContain(absent === "renderCall" ? "live result" : "raw result");
		component.updateResult(
			{
				content: [{ type: "text", text: "raw multi-file result" }],
				details: { perFileResults: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
			},
			false,
		);
		const multiFileText = flatten(component);
		expect(multiFileText).not.toContain("renderer threw");
		expect(multiFileText).toContain(absent === "renderCall" ? "live result" : "raw multi-file result");
	});
});

// A malformed registry entry must report failure rather than use the optional-method fallback
// for live tools. The sweep follows the canonical views used by every rebuilt card.
describe("a registered renderer loses a required method", () => {
	it.each([
		["renderCall", false],
		["renderResult", false],
		["renderResult", true],
	] as const)("%s reports failure for registered cards with multi-file=%s", (method, multiFile) => {
		for (const [name, { view: renderer }] of Object.entries(toolViewDefinitions)) {
			const descriptor = Object.getOwnPropertyDescriptor(renderer, method);
			if (!descriptor) throw new Error(`Registered renderer ${name} has no ${method} descriptor`);
			Object.defineProperty(renderer, method, { configurable: true, writable: true, value: undefined });
			try {
				const component = createToolExecution(name, {}, {}, undefined, uiStub);
				if (method === "renderResult") {
					component.updateResult(
						{
							content: [{ type: "text", text: "retained result output" }],
							...(multiFile
								? { details: { perFileResults: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } }
								: {}),
						},
						false,
					);
				}
				const text = flatten(component);
				const phase = method === "renderCall" ? "call" : "result";
				expect(text).toContain(`tool "${name}" ${phase} renderer threw`);
				expect(text).toContain(
					method === "renderCall"
						? "showing the tool name only"
						: multiFile
							? "no result is shown for src/a.ts"
							: "retained result output",
				);
				component.stopAnimation();
			} finally {
				Object.defineProperty(renderer, method, descriptor);
			}
		}
	});
});
