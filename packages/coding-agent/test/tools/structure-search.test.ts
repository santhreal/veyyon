import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { visibleWidth } from "@veyyon/tui";
import { removeWithRetries, sanitizeText } from "@veyyon/utils";
import { searchToolRenderer } from "../../src/tools/search-renderer";
import { structureSearchRenderer } from "../../src/tools/structure-search";
import { expectNotAccented, useFullColor } from "../helpers/theme-assertions";

beforeAll(async () => {
	await initTheme();
});

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("search structure parse errors", () => {
	it("reports parse errors for the searched file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-parse-"));
		try {
			const filePath = path.join(tempDir, "broken.ts");
			await Bun.write(filePath, "export function broken( { return 1; }");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-parse", {
				type: "structure",
				input: "someUnlikelyCall($A)",
				path: filePath,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(0);
			expect(text).toContain("No matches found");
			expect(text).toContain("Parse issues mean the query may be mis-scoped");
			expect(structureResult?.parseErrors).toHaveLength(1);
			expect(structureResult?.parseErrors?.[0]).toContain(
				"broken.ts: parse error (syntax tree contains error nodes)",
			);
			expect(structureResult?.parseErrors?.[0]).not.toContain("someUnlikelyCall($A):");
			expect(text.match(/parse error \(syntax tree contains error nodes\)/g)?.length ?? 0).toBe(1);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
	it("caps parseErrors at PARSE_ERRORS_LIMIT and records the original total", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-parse-cap-"));
		try {
			const fileCount = 35;
			for (let i = 0; i < fileCount; i++) {
				await Bun.write(path.join(tempDir, `broken-${i}.ts`), "export function broken( { return 1; }");
			}

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-parse-cap", {
				type: "structure",
				input: "someUnlikelyCall($A)",
				path: tempDir,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(0);
			expect(structureResult?.parseErrors?.length).toBe(20);
			expect(structureResult?.parseErrorsTotal).toBe(fileCount);
			expect(text).toContain(`Parse issues (20 / ${fileCount}):`);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "const providerOptions = {};\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "const providerOptions = { nested: true };\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "const providerOptions = {};\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "const providerOptions = {};\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-glob", {
				type: "structure",
				input: "providerOptions",
				path: `${packagesDir}/pkg-*/src/**/*.ts`,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4}/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4}/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(structureResult?.matchCount).toBe(2);
			expect(structureResult?.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps multi-target paging globally ordered without truncating match totals", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-multi-page-"));
		try {
			const earlyDir = path.join(tempDir, "a");
			const lateDir = path.join(tempDir, "z");
			await fs.mkdir(earlyDir, { recursive: true });
			await fs.mkdir(lateDir, { recursive: true });
			await Bun.write(path.join(earlyDir, "early.ts"), 'marker("early");\n');
			for (let index = 0; index < 60; index++) {
				await Bun.write(path.join(lateDir, `late-${index.toString().padStart(2, "0")}.ts`), 'marker("late");\n');
			}

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-multi-page", {
				type: "structure",
				input: "marker($A)",
				path: `${lateDir}; ${earlyDir}`,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(text).toMatch(/^## early\.ts#[0-9A-F]{4}/m);
			expect(structureResult?.matchCount).toBe(61);
			expect(structureResult?.fileCount).toBe(61);
			expect(structureResult?.limitReached).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("parses PlusCal content through the tlaplus language aliases", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-tlaplus-"));
		try {
			const filePath = path.join(tempDir, "Spec.tla");
			await Bun.write(
				filePath,
				`---- MODULE Spec ----\n(* --algorithm Demo\nvariables x = 0;\nbegin\n  Inc:\n    x := x + 1;\nend algorithm; *)\n====\n`,
			);

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-tlaplus", {
				type: "structure",
				input: "Inc",
				path: filePath,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(text).toContain("Inc");
			expect(structureResult?.matchCount).toBe(1);
			expect(structureResult?.parseErrors).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

// WHY THIS SUITE EXISTS (BACKLOG DOG-3)
// -------------------------------------
// A bare "No matches found" hid the most common cause of a surprising zero:
// ast_grep selects files by language, so a language/path mismatch searches ZERO
// files and still reports "no matches" — a silent recall hole (Law 10). The empty
// result now states how many files were searched, and a zero-file search reads as a
// scoping problem, not proven absence. These tests lock the diagnostic in.
describe("search structure zero-match diagnostics", () => {
	it("says NO FILES were searched when the path has nothing to search", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-empty-"));
		try {
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-empty", {
				type: "structure",
				input: "someCall($A)",
				path: tempDir,
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(0);
			expect(structureResult?.filesSearched).toBe(0);
			expect(text).toContain("NO FILES were searched");
			expect(text).toContain("selects files by language");
			// It must NOT read as proven absence.
			expect(text).not.toBe("No matches found");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("reports the searched-file count when files were searched but nothing matched", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-nomatch-"));
		try {
			await Bun.write(path.join(tempDir, "code.ts"), "export const x = 1;\nexport function y() { return 2; }\n");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-nomatch", {
				type: "structure",
				input: "thisCallDoesNotExist($A)",
				path: tempDir,
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(0);
			expect(structureResult?.filesSearched ?? 0).toBeGreaterThan(0);
			expect(text).toContain("searched");
			expect(text).toContain("file");
			expect(text).not.toContain("NO FILES were searched");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("search structure mixed-language and pagination contracts", () => {
	it("does not surface unrelated language pattern errors when a mixed directory has a valid match", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-mixed-"));
		try {
			await fs.writeFile(
				path.join(tempDir, "app.ts"),
				"export function compute(x: number) {\n\treturn x * 2;\n}\n",
				"utf8",
			);
			await fs.writeFile(path.join(tempDir, "helper.py"), "def compute(x):\n    return x * 2\n", "utf8");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			// 1. TypeScript search in mixed directory
			const tsResult = await tool!.execute("ast-grep-ts", {
				type: "structure",
				input: "export function compute($$$ARGS) { $$$BODY }",
				path: tempDir,
			});

			const tsText = tsResult.content.find(content => content.type === "text")?.text ?? "";
			const tsDetails = tsResult.details;
			const tsStructure =
				tsDetails && typeof tsDetails === "object" && "result" in tsDetails ? tsDetails.result : undefined;

			expect(tsStructure?.matchCount).toBe(1);
			expect(tsStructure?.fileCount).toBe(1);
			expect(tsStructure?.parseErrors).toBeUndefined();
			expect(tsText).toContain("compute");
			expect(tsText).not.toContain("Parse issues");
			expect(tsText).not.toContain("helper.py");
			expect(tsResult.useless).toBeUndefined();

			// 2. Python search in mixed directory
			const pyResult = await tool!.execute("ast-grep-py", {
				type: "structure",
				input: "def compute($$$ARGS): $$$BODY",
				path: tempDir,
			});

			const pyText = pyResult.content.find(content => content.type === "text")?.text ?? "";
			const pyDetails = pyResult.details;
			const pyStructure =
				pyDetails && typeof pyDetails === "object" && "result" in pyDetails ? pyDetails.result : undefined;

			expect(pyStructure?.matchCount).toBe(1);
			expect(pyStructure?.fileCount).toBe(1);
			expect(pyStructure?.parseErrors).toBeUndefined();
			expect(pyText).toContain("compute");
			expect(pyText).not.toContain("Parse issues");
			expect(pyText).not.toContain("app.ts");
			expect(pyResult.useless).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("fails loud with parse error diagnostics when pattern is invalid across all candidate languages", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-invalid-pat-"));
		try {
			await fs.writeFile(
				path.join(tempDir, "app.ts"),
				"export function compute(x: number) {\n\treturn x * 2;\n}\n",
				"utf8",
			);
			await fs.writeFile(path.join(tempDir, "helper.py"), "def compute(x):\n    return x * 2\n", "utf8");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-invalid", {
				type: "structure",
				input: "let a = 1; let b = 2; let c = 3;",
				path: tempDir,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(0);
			expect(structureResult?.parseErrors).toBeDefined();
			expect((structureResult?.parseErrors?.length ?? 0) > 0).toBe(true);
			expect(text).toContain("No matches found. Parse issues mean the query may be mis-scoped");
			expect(text).toContain("Parse issues:");
			expect(result.useless).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("preserves genuine source parse errors when malformed source exists alongside matching files", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-source-err-"));
		try {
			await fs.writeFile(path.join(tempDir, "broken.ts"), "export function broken( { return 1; }", "utf8");
			await fs.writeFile(
				path.join(tempDir, "valid.ts"),
				"export function compute(x: number) {\n\treturn x * 2;\n}\n",
				"utf8",
			);
			await fs.writeFile(path.join(tempDir, "helper.py"), "def compute(x):\n    return x * 2\n", "utf8");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-grep-source-err", {
				type: "structure",
				input: "export function compute($$$ARGS) { $$$BODY }",
				path: tempDir,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details;
			const structureResult =
				details && typeof details === "object" && "result" in details ? details.result : undefined;

			expect(structureResult?.matchCount).toBe(1);
			expect(structureResult?.fileCount).toBe(1);
			expect(structureResult?.parseErrors).toHaveLength(1);
			expect(structureResult?.parseErrors?.[0]).toContain(
				"broken.ts: parse error (syntax tree contains error nodes)",
			);
			expect(text).toContain("compute");
			expect(text).toContain("broken.ts: parse error (syntax tree contains error nodes)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("handles pagination before, at, and after end, preserving totals and useless status", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-page-"));
		try {
			const fileCount = 5;
			for (let i = 1; i <= fileCount; i++) {
				await fs.writeFile(path.join(tempDir, `item-${i}.ts`), `export const item_${i} = ${i};\n`, "utf8");
			}

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			// 1. skip: 2 (before end)
			const beforeResult = await tool!.execute("ast-grep-page-before", {
				type: "structure",
				input: "export const $NAME = $VAL;",
				path: tempDir,
				skip: 2,
			});
			const beforeText = beforeResult.content.find(content => content.type === "text")?.text ?? "";
			const beforeDetails =
				beforeResult.details && typeof beforeResult.details === "object" && "result" in beforeResult.details
					? beforeResult.details.result
					: undefined;

			expect(beforeDetails?.matchCount).toBe(5);
			expect(beforeDetails?.files?.length).toBe(3);
			expect(beforeText).toContain("item_3");
			expect(beforeResult.useless).toBeUndefined();

			// 2. skip: 5 (at end: skip >= totalMatches > 0)
			const atResult = await tool!.execute("ast-grep-page-at", {
				type: "structure",
				input: "export const $NAME = $VAL;",
				path: tempDir,
				skip: 5,
			});
			const atText = atResult.content.find(content => content.type === "text")?.text ?? "";
			const atDetails =
				atResult.details && typeof atResult.details === "object" && "result" in atResult.details
					? atResult.details.result
					: undefined;

			expect(atDetails?.matchCount).toBe(5);
			expect(atText).toBe("No more results (5 matches total; skip=5 has exhausted the result set)");
			expect(atResult.useless).toBeUndefined();

			// 3. skip: 10 (after end: skip > totalMatches > 0)
			const afterResult = await tool!.execute("ast-grep-page-after", {
				type: "structure",
				input: "export const $NAME = $VAL;",
				path: tempDir,
				skip: 10,
			});
			const afterText = afterResult.content.find(content => content.type === "text")?.text ?? "";
			const afterDetails =
				afterResult.details && typeof afterResult.details === "object" && "result" in afterResult.details
					? afterResult.details.result
					: undefined;

			expect(afterDetails?.matchCount).toBe(5);
			expect(afterText).toBe("No more results (5 matches total; skip=10 has exhausted the result set)");
			expect(afterResult.useless).toBeUndefined();

			// 4. True zero match control: pattern never matches any file
			const zeroResult = await tool!.execute("ast-grep-zero-control", {
				type: "structure",
				input: "thisPatternMatchesNothingInAnyFile($$$)",
				path: tempDir,
				skip: 0,
			});
			const zeroText = zeroResult.content.find(content => content.type === "text")?.text ?? "";
			const zeroDetails =
				zeroResult.details && typeof zeroResult.details === "object" && "result" in zeroResult.details
					? zeroResult.details.result
					: undefined;

			expect(zeroDetails?.matchCount).toBe(0);
			expect(zeroText).toContain("No matches found (searched 5 files)");
			expect(zeroResult.useless).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("rejects line selectors on search path", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-selector-"));
		try {
			const filePath = path.join(tempDir, "file.ts");
			await fs.writeFile(filePath, "export const x = 1;\n", "utf8");

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "search");
			expect(tool).toBeDefined();

			await expect(
				tool!.execute("ast-grep-line-sel", {
					type: "structure",
					input: "export const x = 1;",
					path: `${filePath}:1-10`,
				}),
			).rejects.toThrow();
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});

describe("structureSearchRenderer and searchToolRenderer (structure)", () => {
	useFullColor();

	it("renders matched groups with railed lines and no tree connectors", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 2,
				fileCount: 2,
				filesSearched: 10,
				limitReached: false,
				displayContent: [
					"# src/",
					"## first.ts",
					"  *10│const a = 1;",
					"",
					"# src/",
					"## second.ts",
					"  *20│const b = 2;",
				].join("\n"),
			},
		};

		const renderedLines = structureSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "const $A = $_" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		const unifiedRenderedLines = searchToolRenderer
			.renderResult(
				{ content: result.content, details: { type: "structure", result: result.details } },
				{ expanded: true, isPartial: false },
				uiTheme,
				{ type: "structure", input: "const $A = $_" },
			)
			.render(240);
		const unifiedPlainLines = sanitizeText(unifiedRenderedLines.join("\n")).split("\n");

		expect(plainLines[0]!).toContain("Search structure");
		expect(plainLines[0]!).toContain("2 matches");
		expect(plainLines[0]!).toContain("2 files");
		expect(unifiedPlainLines).toEqual(plainLines);

		const rail = uiTheme.symbol("block.rail");
		const bodyLines = plainLines.slice(1);
		expect(bodyLines.length).toBe(6);
		for (const line of bodyLines) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└]/);
		}
		expectNotAccented(uiTheme, renderedLines[0]!, [uiTheme.symbol("icon.search"), "Search"]);
		expectNotAccented(uiTheme, unifiedRenderedLines[0]!, [uiTheme.symbol("icon.search"), "Search"]);
	});

	it("truncates collapsed results and appends a dim summary row on the rail", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;

		// Ten three-line groups: far more than the collapsed line budget, so the
		// collapsed view must drop whole groups and account for the rest in one row.
		const groups = Array.from({ length: 10 }, (_, i) => ["# src/", `## file${i}.ts`, `  *${i + 1}│const x${i} = true;`]);
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 10,
				fileCount: 10,
				filesSearched: 20,
				limitReached: false,
				displayContent: groups.map(group => group.join("\n")).join("\n\n"),
			},
		};

		const rail = uiTheme.symbol("block.rail");
		const collapsedLines = sanitizeText(
			structureSearchRenderer
				.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, { input: "const $A = true" })
				.render(240)
				.join("\n"),
		).split("\n");
		const collapsedBody = collapsedLines.slice(1);

		expect(collapsedBody.length).toBeLessThan(30);
		expect(collapsedBody.filter(line => line.includes("more matches"))).toHaveLength(1);
		// The summary row accounts for every group that was dropped, not just that some were.
		expect(collapsedBody.at(-1)).toContain("9 more matches");
		for (const line of collapsedBody) {
			expect(line.startsWith(`${rail} `)).toBe(true);
			expect(line).not.toMatch(/[├└]/);
		}

		const expandedBody = sanitizeText(
			structureSearchRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "const $A = true" })
				.render(240)
				.join("\n"),
		)
			.split("\n")
			.slice(1);
		expect(expandedBody.length).toBe(30);
		expect(expandedBody.some(line => line.includes("more matches"))).toBe(false);
	});

	it("budgets body width against outputBlockContentWidth so lines do not overflow the outer width", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				filesSearched: 5,
				limitReached: false,
				displayContent: [
					"# src/",
					"## very-long-file-name-that-exceeds-the-narrow-terminal-width.ts",
					"  *1│const veryLongVariableNameToEnsureWidthBudgetTruncatesProperly = true;",
				].join("\n"),
			},
		};

		const width = 40;
		const renderedLines = structureSearchRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { input: "const $A = $_" })
			.render(width);

		// One header plus three body rows: budgeting body lines against the outer
		// width instead of outputBlockContentWidth makes the frame re-wrap them,
		// which shows up as extra lines.
		expect(renderedLines).toHaveLength(4);
		for (const line of renderedLines.slice(1)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
