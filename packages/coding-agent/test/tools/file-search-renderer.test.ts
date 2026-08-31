import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";
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

/** WHY: these three visual contracts were asserted against the retired `glob`
 * renderer and were not carried over when the tool became `search files`. The
 * rendering shape they defend — the collapsed/expanded item budget, the
 * directory-versus-file indent, and the body width budget that keeps a row from
 * wrapping — is unchanged by the rename, so a regression in any of them was
 * unobserved. They do not cover the text or structure renderers, which own
 * their own row shapes. */
describe("fileSearchRenderer row layout", () => {
	useFullColor();

	it("respects collapsed vs expanded line budgets with a railed overflow indicator", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const files = Array.from({ length: 15 }, (_, i) => `src/file_${i}.ts`);
		const result = { content: [{ type: "text", text: "" }], details: { fileCount: 15, files } };
		const rail = uiTheme.symbol("block.rail");

		const plainCollapsed = sanitizeText(
			fileSearchRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { input: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		).split("\n");
		expect(plainCollapsed[0]!).toContain("15 files");
		expect(plainCollapsed.length).toBe(10); // header + 8 files + overflow
		for (const line of plainCollapsed.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainCollapsed[9]!).toContain("… 7 more files");

		const plainExpanded = sanitizeText(
			fileSearchRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**/*.ts" })
				.render(240)
				.join("\n"),
		).split("\n");
		expect(plainExpanded[0]!).toContain("15 files");
		expect(plainExpanded.length).toBe(16); // header + 15 files
		for (const line of plainExpanded.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainExpanded.some(line => line.includes("more file"))).toBe(false);
	});

	it("formats directory headers without the file indent and files with it", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: { fileCount: 3, files: ["src/", "src/index.ts", "src/util.ts"] },
		};

		const plainLines = sanitizeText(
			fileSearchRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**" })
				.render(240)
				.join("\n"),
		).split("\n");

		const rail = uiTheme.symbol("block.rail");
		expect(plainLines[0]!).toContain("3 files");
		expect(plainLines[1]!).toContain(`${rail}  `);
		expect(plainLines[1]!).toContain("src/");
		expect(plainLines[2]!).toContain(`${rail}    `);
		expect(plainLines[2]!).toContain("src/index.ts");
		expect(plainLines[3]!).toContain(`${rail}    `);
		expect(plainLines[3]!).toContain("src/util.ts");
	});

	it("budgets body width against the block content width so a row never wraps", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const longPath =
			"src/very/deep/nested/directory/structure/that/is/exceptionally/long/and/will/overflow/if/not/budgeted/correctly/index.ts";
		const result = { content: [{ type: "text", text: "" }], details: { fileCount: 1, files: [longPath] } };

		const targetWidth = 40;
		const renderedLines = fileSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "src/**" })
			.render(targetWidth);

		// One header row and one truncated body row. Budgeted against the outer
		// width instead of the block content width, the body row re-wraps to two.
		expect(renderedLines.length).toBe(2);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(targetWidth);
		}
	});
});
