import { beforeAll, describe, expect, it } from "bun:test";
import { editToolView } from "@veyyon/coding-agent/edit/edit-view";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { writeToolView } from "@veyyon/coding-agent/tools/fs/write-view";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import type { Component } from "@veyyon/tui";

interface InvalidPathCase {
	readonly name: string;
	readonly path: unknown;
}

const invalidPathCases: readonly InvalidPathCase[] = [
	{ name: "array path", path: ["src/example.ts"] },
	{ name: "object path", path: { value: "src/example.ts" } },
];

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

function renderPlain(component: Component, width = 120): string {
	let rendered = "";
	expect(() => {
		rendered = Bun.stripANSI(component.render(width).join("\n"));
	}).not.toThrow();
	return rendered;
}

describe("tool path renderers with invalid provider arguments", () => {
	for (const invalid of invalidPathCases) {
		it(`read renderer does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = drawToolView(
					readToolView.renderCall({ path: invalid.path }, { expanded: false, partial: true }),
					uiTheme,
				);
			}).not.toThrow();
			expect(renderPlain(callComponent!)).toContain("Read");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = drawToolView(
					readToolView.renderResult(
						{
							content: [{ type: "text", text: "hello from read" }],
							details: {
								displayContent: { text: "hello from read", startLine: 1 },
								contentType: "text/plain",
							},
						},
						{ expanded: false, partial: false },
						{ path: invalid.path },
					),
					uiTheme,
				);
			}).not.toThrow();
			const rendered = renderPlain(resultComponent!);
			expect(rendered).toContain("Read");
			expect(rendered).toContain("hello from read");
		});

		it(`write renderer does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = drawToolView(
					writeToolView.renderCall(
						{ path: invalid.path, content: "first line\nsecond line" },
						{ expanded: false, partial: true, frame: 0 },
					),
					uiTheme,
					0,
				);
			}).not.toThrow();
			const callText = renderPlain(callComponent!);
			expect(callText).toContain("Write");
			expect(callText).toContain("second line");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = drawToolView(
					writeToolView.renderResult(
						{
							content: [{ type: "text", text: "Wrote file" }],
							details: { resolvedPath: "/tmp/example.ts" },
						},
						{ expanded: false, partial: false },
						{ path: invalid.path, content: "first line\nsecond line" },
					),
					uiTheme,
				);
			}).not.toThrow();
			const resultText = renderPlain(resultComponent!);
			expect(resultText).toContain("Write");
			expect(resultText).toContain("first line");
		});

		it(`edit view does not throw for ${invalid.name}`, () => {
			let callComponent: Component | undefined;
			expect(() => {
				callComponent = drawToolView(
					editToolView.renderCall(
						{ path: invalid.path, oldText: "before", newText: "after", editMode: "replace" },
						{ expanded: false, partial: true, frame: 0 },
					),
					uiTheme,
					0,
				);
			}).not.toThrow();
			expect(renderPlain(callComponent!)).toContain("Edit");

			let resultComponent: Component | undefined;
			expect(() => {
				resultComponent = drawToolView(
					editToolView.renderResult(
						{
							content: [{ type: "text", text: "updated" }],
							details: { diff: "-before\n+after" },
						},
						{ expanded: false, partial: false },
						{ path: invalid.path, oldText: "before", newText: "after", editMode: "replace" },
					),
					uiTheme,
				);
			}).not.toThrow();
			const rendered = renderPlain(resultComponent!);
			expect(rendered).toContain("Edit");
			expect(rendered).toContain("after");
		});
	}
});
