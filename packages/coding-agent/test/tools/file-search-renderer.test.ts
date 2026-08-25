import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { sanitizeText } from "@veyyon/utils";
import { fileSearchRenderer } from "../../src/tools/file-search";
import { searchToolRenderer } from "../../src/tools/search-renderer";
import { expectNotAccented, useFullColor } from "../helpers/theme-assertions";

describe("fileSearchRenderer and searchToolRenderer (files)", () => {
	useFullColor();
	it("indents inline glob output and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
			},
		};

		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		const unifiedRenderedLines = searchToolRenderer
			.renderResult(
				{ content: result.content, details: { type: "files", result: result.details } },
				{ expanded: true, isPartial: false },
				uiTheme,
				{ type: "files", input: "src/**/*.ts" },
			)
			.render(240);
		const unifiedPlainLines = sanitizeText(unifiedRenderedLines.join("\n")).split("\n");

		const rail = uiTheme.symbol("block.rail");
		expect(plainLines.every(line => line.startsWith(`${rail} `))).toBe(true);
		expect(unifiedPlainLines.every(line => line.startsWith(`${rail} `))).toBe(true);
		expectNotAccented(uiTheme, renderedLines[0]!, [uiTheme.symbol("icon.search"), "Search files"]);
		expectNotAccented(uiTheme, unifiedRenderedLines[0]!, [uiTheme.symbol("icon.search"), "Search files"]);
	});

	it("renders a timed-out empty scan as incomplete instead of a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// `truncated` with zero files only happens on the timeout path — the
		// scan died mid-walk, so "No files found" would be a false claim.
		const result = {
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
			},
		};

		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "~/.cache/*" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No matches before timeout (scan incomplete)");
		expect(plain).toContain("timed out");
		expect(plain).not.toContain("No files found");
	});

	it("renders a genuinely empty result as no files found", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: false,
			},
		};

		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/*.zig" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No files found");
		expect(plain).not.toContain("incomplete");
	});
});

describe("fileSearchRenderer truncation reasons", () => {
	/** details.resultLimitReached and meta.limits.resultLimit describe the SAME
	 * cap; both being present once rendered "truncated: limit 200 results, limit
	 * 200 results". Exactly one reason may appear. */
	it("emits the result-cap reason once when details and limits both carry it", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 200,
				files: Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`),
				truncated: true,
				resultLimitReached: 200,
				meta: { limits: { resultLimit: { reached: 200 } } },
			},
		};
		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));
		expect(plain).toContain("truncated: limit 200 results");
		expect(plain.match(/limit 200 results/g)!.length).toBe(1);
	});

	/** The limits-only path (no details.resultLimitReached) must still surface
	 * the cap — deduping may not silently drop the reason entirely. */
	it("still emits the reason when only meta.limits carries the cap", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 200,
				files: ["src/a.ts"],
				truncated: true,
				meta: { limits: { resultLimit: { reached: 200 } } },
			},
		};
		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));
		expect(plain.match(/limit 200 results/g)!.length).toBe(1);
	});
});
