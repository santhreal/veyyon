import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

/**
 * Unified search owns one wire identity but three result shapes. This suite drives
 * the registered web renderer with canonical `{ type, input }` calls and nested
 * `{ type, result }` details so HTML export and collab cannot silently render every
 * search as text search. It does not assert terminal ANSI rendering.
 */
const renderer = resolveToolRenderer("search");

function render(component: "Summary" | "Body", args: Record<string, unknown>, result?: ToolResultLike): string {
	const Component = component === "Summary" ? renderer.Summary : renderer.Body;
	if (!Component) throw new Error(`search renderer has no ${component}`);
	return renderToStaticMarkup(createElement(Component, { name: "search", args, result } as ToolRenderProps));
}

function result(type: "files" | "text" | "structure", details: Record<string, unknown>): ToolResultLike {
	return {
		content: [{ type: "text", text: "search output" }],
		details: { type, result: details },
	};
}

describe("unified search web renderer", () => {
	it("renders canonical file input and nested file counts", () => {
		expect(render("Summary", { type: "files", input: "src/**/*.ts" })).toContain("src/**/*.ts");
		expect(render("Body", { type: "files", input: "src/**/*.ts" }, result("files", { fileCount: 2 }))).toContain(
			"2 files",
		);
	});

	it("renders canonical text input, scope, and nested match counts", () => {
		const args = { type: "text", input: "needle", path: "src" };
		expect(render("Summary", args)).toContain("/needle/");
		const body = render("Body", args, result("text", { matchCount: 3, fileCount: 2 }));
		expect(body).toContain("3 matches");
		expect(body).toContain("2 files");
	});

	it("renders canonical structure input and nested structural counts", () => {
		const args = { type: "structure", input: "call($A)", path: "src/**/*.ts" };
		expect(render("Summary", args)).toContain("call($A)");
		const body = render("Body", args, result("structure", { matchCount: 4, fileCount: 2, filesSearched: 6 }));
		expect(body).toContain("4 matches");
		expect(body).toContain("searched 6");
	});

	it("fails visibly for a malformed call with no type", () => {
		expect(render("Summary", { input: "needle" })).toContain("type");
		expect(render("Body", { input: "needle" })).toContain("type");
	});

	it("fails visibly for empty text and structure inputs", () => {
		expect(render("Summary", { type: "text", input: "   " })).toContain("input");
		expect(render("Summary", { type: "structure", input: "" })).toContain("input");
	});

	it("recovers search type from result details when omitted from args", () => {
		const res = result("files", { fileCount: 5 });
		expect(render("Summary", { input: "src/**/*.ts" }, res)).toContain("src/**/*.ts");
		expect(render("Body", { input: "src/**/*.ts" }, res)).toContain("5 files");
	});

	it("renders case badges for text search without emitting a redundant type badge", () => {
		const sensitiveSummary = render("Summary", { type: "text", input: "needle", path: "src", case: true });
		expect(sensitiveSummary).toContain("case");
		expect(sensitiveSummary).not.toContain("type=");

		const insensitiveSummary = render("Summary", { type: "text", input: "needle", path: "src", case: false });
		expect(insensitiveSummary).toContain("no-case");
		expect(insensitiveSummary).not.toContain("type=");
	});

	it("renders file search truncation, missing paths, and hidden overrides", () => {
		const body = render(
			"Body",
			{ type: "files", input: "src/**/*.ts", hidden: false },
			result("files", { fileCount: 10, resultLimitReached: 10, missingPaths: ["missing/dir"] }),
		);
		expect(body).toContain("no-hidden");
		expect(body).toContain("truncated at 10");
		expect(body).toContain("skipped missing: missing/dir");

		const defaultHiddenBody = render(
			"Body",
			{ type: "files", input: "src/**/*.ts" },
			result("files", { fileCount: 1 }),
		);
		expect(defaultHiddenBody).not.toContain("no-hidden");
		expect(defaultHiddenBody).not.toContain("hidden");
	});

	it("renders semicolon-delimited scope paths cleanly for text and structure searches", () => {
		const textSummary = render("Summary", { type: "text", input: "needle", path: "src; tests" });
		expect(textSummary).toContain("src, tests");

		const structBody = render(
			"Body",
			{ type: "structure", input: "call($A)", path: "src; tests" },
			result("structure", { matchCount: 1, fileCount: 1 }),
		);
		expect(structBody).toContain("src");
		expect(structBody).toContain("tests");
	});

	it("renders structure search parse issues and limits", () => {
		const body = render(
			"Body",
			{ type: "structure", input: "call($A)", path: "src" },
			result("structure", {
				matchCount: 0,
				fileCount: 0,
				limitReached: true,
				parseErrors: ["syntax error at line 1"],
			}),
		);
		expect(body).toContain("limit reached");
		expect(body).toContain("parse issues");
		expect(body).toContain("syntax error at line 1");

		const errorBody = render(
			"Body",
			{ type: "structure", input: "call($A)" },
			result("structure", { error: "failed to parse query" }),
		);
		expect(errorBody).toContain("failed to parse query");
	});

	it("fails visibly on malformed input across all search types", () => {
		expect(render("Summary", { type: "files" })).toContain("input");
		expect(render("Summary", { type: "text", input: 123 })).toContain("input");
		expect(render("Summary", { type: "structure" })).toContain("input");
		expect(render("Summary", { type: "structure", pat: "fn($A)" })).toContain("input");
	});

	it("fails safely for invalid type or malformed details", () => {
		expect(render("Summary", { type: "unknown", input: "test" })).toContain("type");
		expect(render("Body", { type: "unknown", input: "test" })).toContain("type");
		expect(
			render(
				"Body",
				{ type: "files", input: "src/*.ts" },
				{
					content: [{ type: "text", text: "search output" }],
					details: "malformed" as unknown as Record<string, unknown>,
				},
			),
		).toContain("search output");
		expect(
			render(
				"Body",
				{ type: "text", input: "foo" },
				{
					content: [{ type: "text", text: "search output" }],
					details: { type: "text", result: null } as unknown as Record<string, unknown>,
				},
			),
		).toContain("/foo/");
	});
});
