import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { genericRenderer } from "../src/generic";
import { getRegisteredToolNames, resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

describe("runtime tool-renderer registry sweep", () => {
	const registeredKeys = getRegisteredToolNames();

	it("has registered tool names", () => {
		expect(registeredKeys.length).toBeGreaterThan(30);
	});

	for (const key of registeredKeys) {
		it(`renders ${key} Summary and Body at runtime without throwing`, () => {
			const renderer = resolveToolRenderer(key);
			expect(renderer).toBeDefined();
			expect(renderer).not.toBe(genericRenderer);
			expect(typeof renderer.Summary).toBe("function");

			const dummyResult: ToolResultLike = {
				content: [{ type: "text", text: "ok" }],
				details: {},
			};

			const dummyErrorResult: ToolResultLike = {
				content: [{ type: "text", text: "failed" }],
				details: {},
				isError: true,
			};

			// Test with undefined result (in-flight call)
			const summaryEmpty = renderToStaticMarkup(
				createElement(renderer.Summary, { name: key, args: {}, result: undefined } as ToolRenderProps),
			);
			expect(typeof summaryEmpty).toBe("string");

			// Test with success result
			const summarySuccess = renderToStaticMarkup(
				createElement(renderer.Summary, { name: key, args: {}, result: dummyResult } as ToolRenderProps),
			);
			expect(typeof summarySuccess).toBe("string");

			// Test with error result
			const summaryError = renderToStaticMarkup(
				createElement(renderer.Summary, { name: key, args: {}, result: dummyErrorResult } as ToolRenderProps),
			);
			expect(typeof summaryError).toBe("string");

			if (renderer.Body) {
				const bodyEmpty = renderToStaticMarkup(
					createElement(renderer.Body, { name: key, args: {}, result: undefined } as ToolRenderProps),
				);
				expect(typeof bodyEmpty).toBe("string");

				const bodySuccess = renderToStaticMarkup(
					createElement(renderer.Body, { name: key, args: {}, result: dummyResult } as ToolRenderProps),
				);
				expect(typeof bodySuccess).toBe("string");

				const bodyError = renderToStaticMarkup(
					createElement(renderer.Body, { name: key, args: {}, result: dummyErrorResult } as ToolRenderProps),
				);
				expect(typeof bodyError).toBe("string");
			}
		});
	}

	it("fails for an unknown tool by falling back to genericRenderer", () => {
		const unknown = resolveToolRenderer("__unknown_unregistered_tool_name__");
		expect(unknown).toBe(genericRenderer);
	});
});
