/**
 * Generic tool execution component does not duplicate image placeholder rows across rebuilds.
 *
 * WHY THIS SUITE EXISTS. A tool card using the generic fallback renderer path (MCP or extension
 * tools with no custom renderer) accumulated duplicate image placeholder rows without bound on
 * every rebuild (expansion/collapse, streaming updates, theme changes). In `#rebuildDisplay`,
 * the custom and built-in renderer branches cleared `#contentBox` before repopulating it, but the
 * generic fallback branch did not. As a result, each `#rebuildDisplay` call appended an additional
 * placeholder row to `#contentBox`, causing visual row duplication and leaking Component instances.
 *
 * This suite defends the contract that generic fallback tool cards replace their content rather
 * than appending on rebuild, ensuring image placeholder rows remain stable across routine rebuilds.
 *
 * Gap left: Does not test terminal-specific pixel rendering or Kitty protocol binary transmission.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

describe("generic tool image placeholders do not accumulate on rebuild", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const mockUi = {
		requestRender() {},
		requestComponentRender() {},
		imageBudget: undefined,
	} as unknown as TUI;

	function countPlaceholderRows(lines: readonly string[]): number {
		const plain = stripVTControlCharacters(lines.join("\n"));
		return plain.split("\n").filter(line => line.includes("image not shown")).length;
	}

	it("retains exactly one placeholder row across repeated expand, collapse, and update rebuilds", () => {
		const component = createToolExecution(
			"mcp_custom_tool",
			{ query: "generate chart" },
			{ showImages: false },
			undefined,
			mockUi,
			process.cwd(),
		);

		const singleImageResult = {
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		// 1. Initial result arrives (partial)
		component.updateResult(singleImageResult, true);
		let rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 2. Expand card
		component.setExpanded(true);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 3. Collapse card
		component.setExpanded(false);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 4. Multiple invalidations (e.g. frame renders)
		for (let i = 0; i < 5; i++) {
			component.invalidate();
		}
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 5. Final result arrives (non-partial)
		component.updateResult(singleImageResult, false);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 6. Expand again after final result
		component.setExpanded(true);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);

		// 7. Collapse again
		component.setExpanded(false);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(1);
	});

	it("preserves exact placeholder count for multi-image results across rebuilds", () => {
		const component = createToolExecution(
			"extension_image_analyzer",
			{ images: ["a.png", "b.png"] },
			{ showImages: false },
			undefined,
			mockUi,
			process.cwd(),
		);

		const multiImageResult = {
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		component.updateResult(multiImageResult, false);
		let rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(2);

		component.setExpanded(true);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(2);

		component.setExpanded(false);
		rendered = component.render(80);
		expect(countPlaceholderRows(rendered)).toBe(2);
	});

	it("shortens file path in image placeholder text", () => {
		const homeDir = os.homedir();
		const longPath = `${homeDir}/very/long/nested/directory/path/to/diagram.png`;
		const component = createToolExecution(
			"mcp_viewer",
			{ path: longPath },
			{ showImages: false },
			undefined,
			mockUi,
			process.cwd(),
		);

		const resultWithPath = {
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		component.updateResult(resultWithPath, false);
		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("… image not shown");
		expect(rendered).toContain("~/very/long/nested/directory/path/to/diagram.png");
		expect(countPlaceholderRows(component.render(80))).toBe(1);
	});
});
