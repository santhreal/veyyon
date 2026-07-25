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
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Component, TUI } from "@veyyon/tui";

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

function toolWith(renderers: Partial<Pick<AnyAgentTool, "renderCall" | "renderResult">>): AnyAgentTool {
	return { name: "widget", label: "widget", ...renderers } as unknown as AnyAgentTool;
}

function boom(): never {
	throw new Error("payload has no rows");
}

describe("renderCall throws", () => {
	it("reports the tool, the phase, and the failure", () => {
		const component = new ToolExecutionComponent("widget", { id: 1 }, {}, toolWith({ renderCall: boom }), uiStub);

		const text = flatten(component);

		expect(text).toContain('tool "widget" call renderer threw');
		expect(text).toContain("payload has no rows");
		expect(text).toContain("showing the tool name only");
	});

	/** The degraded render is still the render: losing the tool name too would
	 * leave a block that says only that something broke. */
	it("still shows the tool label underneath the notice", () => {
		const component = new ToolExecutionComponent("widget", { id: 1 }, {}, toolWith({ renderCall: boom }), uiStub);

		expect(flatten(component)).toContain("widget");
	});
});

describe("renderResult throws", () => {
	function withResult(text: string, renderResult: () => never): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
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
		const component = new ToolExecutionComponent("widget", {}, {}, toolWith({ renderCall: boom }), uiStub);

		const line = component
			.render(WIDTH)
			.map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
			.find(l => l.includes("renderer threw"));

		expect(line).toBeDefined();
		expect(line).toMatch(/^(?:✗||\[!!\])\s/);
	});

	/** A renderer that works must not pay for this: no notice, no glyph, nothing. */
	it("is absent when the renderer succeeds", () => {
		const component = new ToolExecutionComponent(
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
