import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "../../helpers/tool-execution";

// WHY: #getTextOutput joins text blocks from tool result content. It was
// rewritten from .filter().map().join() to a single for-loop to avoid two
// throwaway arrays per render. This suite pins the observable contract:
// multiple text blocks are joined with "\n", non-text blocks are skipped,
// empty/missing content returns "", and the output flows through the render
// path that callers see.

describe("ToolExecutionComponent text output joining", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("joins multiple text blocks with newline", () => {
		const component = createToolExecution(
			"eval",
			{ language: "py", code: "print('a')" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{ type: "text", text: "first line" },
					{ type: "text", text: "second line" },
				],
			},
			true,
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("first line");
		expect(rendered).toContain("second line");
	});

	it("skips non-text blocks and includes text blocks", () => {
		const component = createToolExecution(
			"eval",
			{ language: "py", code: "print('a')" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{ type: "image", data: "base64data", mimeType: "image/png" },
					{ type: "text", text: "only text" },
				],
			},
			true,
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("only text");
		expect(rendered).not.toContain("base64data");
	});

	it("returns empty output when content has no text blocks", () => {
		const component = createToolExecution(
			"eval",
			{ language: "py", code: "print('a')" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
			},
			true,
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).not.toContain("base64data");
	});

	it("handles empty text in a block without adding extra newlines", () => {
		const component = createToolExecution(
			"eval",
			{ language: "py", code: "print('a')" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [
					{ type: "text", text: "" },
					{ type: "text", text: "real content" },
				],
			},
			true,
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("real content");
	});

	it("handles a single text block", () => {
		const component = createToolExecution(
			"eval",
			{ language: "py", code: "print('a')" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "solo output" }],
			},
			true,
		);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("solo output");
	});
});
