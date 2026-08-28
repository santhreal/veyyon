import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { sanitizeText } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";
import { globToolRenderer } from "../../src/tools/glob";
import { expectNotAccented, useFullColor } from "../helpers/theme-assertions";

beforeAll(async () => {
	await initTheme();
});

describe("globToolRenderer", () => {
	useFullColor();
	it("renders railed glob output without tree connectors and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
				cwd: "/workspace",
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");
		const rail = uiTheme.symbol("block.rail");
		expect(plainLines[0]!).toContain("2 files");
		expect(plainLines.length).toBe(3); // header + 2 file lines
		for (const line of plainLines) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expectNotAccented(uiTheme, renderedLines[0]!, [uiTheme.symbol("icon.search"), "Find"]);
	});

	it("respects collapsed vs expanded line budgets with railed overflow indicator", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const files = Array.from({ length: 15 }, (_, i) => `src/file_${i}.ts`);
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 15,
				files,
			},
		};

		const rail = uiTheme.symbol("block.rail");

		// Collapsed mode: shows 8 items + 1 overflow summary line
		const collapsedLines = globToolRenderer
			.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainCollapsed = sanitizeText(collapsedLines.join("\n")).split("\n");
		expect(plainCollapsed[0]!).toContain("15 files");
		expect(plainCollapsed.length).toBe(10); // header + 8 files + overflow
		for (const line of plainCollapsed.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainCollapsed[9]!).toContain("… 7 more files");

		// Expanded mode: shows all 15 items with no overflow summary line
		const expandedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainExpanded = sanitizeText(expandedLines.join("\n")).split("\n");
		expect(plainExpanded[0]!).toContain("15 files");
		expect(plainExpanded.length).toBe(16); // header + 15 files
		for (const line of plainExpanded.slice(1)) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└│]/);
		}
		expect(plainExpanded.some(l => l.includes("more file"))).toBe(false);
	});

	it("formats directory headers without file indent and files with 2-space indent under the rail", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 3,
				files: ["src/", "src/index.ts", "src/util.ts"],
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		const rail = uiTheme.symbol("block.rail");
		expect(plainLines[0]!).toContain("3 files");
		// Directory header line: rail + " " + " " (content padding) + folder icon/path (no extra 2-space file indent)
		expect(plainLines[1]!).toContain(`${rail}  `);
		expect(plainLines[1]!).toContain("src/");
		// File lines: rail + " " + " " (content padding) + "  " (file indent) + lang badge/path
		expect(plainLines[2]!).toContain(`${rail}    `);
		expect(plainLines[2]!).toContain("src/index.ts");
		expect(plainLines[3]!).toContain(`${rail}    `);
		expect(plainLines[3]!).toContain("src/util.ts");
	});

	it("budgets body width against outputBlockContentWidth so visual rows never wrap", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;
		const longPath =
			"src/very/deep/nested/directory/structure/that/is/exceptionally/long/and/will/overflow/if/not/budgeted/correctly/index.ts";
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 1,
				files: [longPath],
			},
		};

		const targetWidth = 40;
		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**" })
			.render(targetWidth);

		// Exactly 2 lines: 1 header line + 1 single truncated body row.
		// If budgeted against outer width instead of outputBlockContentWidth, outputBlock re-wraps the row into 2 lines (3 total).
		expect(renderedLines.length).toBe(2);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(targetWidth);
		}
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

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "~/.cache/*" })
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

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/*.zig" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No files found");
		expect(plain).not.toContain("incomplete");
	});
});

describe("globToolRenderer truncation reasons", () => {
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
		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**" })
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
		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));
		expect(plain.match(/limit 200 results/g)!.length).toBe(1);
	});
});
