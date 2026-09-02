import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@veyyon/agent-core";
import { renderGalleryState, resolveFixture } from "@veyyon/coding-agent/cli/gallery-cli";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { EditViewResult } from "@veyyon/coding-agent/edit/edit-view";
import { type EditViewArgs, editToolView } from "@veyyon/coding-agent/edit/edit-view";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import { getAnsiPolicy, setAnsiPolicy, Text, type TUI } from "@veyyon/tui";
import { removeWithRetries } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";
import { createToolExecution } from "../helpers/tool-execution";

/**
 * What the edit card says, drawn the way a session draws it: `editToolView` describes the card and
 * `drawToolView` puts it on a terminal.
 *
 * WHAT THIS DOES NOT CATCH. That the bytes are the ones main's renderer drew, which
 * `test/differential/the-edit-card-draws-what-main-drew.test.ts` owns; and diff-render caching,
 * which left with the injected `renderDiff` the old renderer took — the host memoizes one drawn
 * change and nothing outside it can observe the call count any more.
 */

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

/** The card a call draws, at `width`, as the plain rows a reader sees. */
function drawCall(
	args: EditViewArgs,
	uiTheme: Theme,
	options: { expanded?: boolean; partial?: boolean; width?: number } = {},
): string[] {
	const component = drawToolView(
		editToolView.renderCall(args, {
			expanded: options.expanded ?? false,
			partial: options.partial ?? true,
			frame: 0,
		}),
		uiTheme,
		0,
	);
	return component.render(options.width ?? 160).map(line => stripVTControlCharacters(line));
}

/** The card a result draws, at `width`, as the plain rows a reader sees. */
function drawResult(
	result: EditViewResult,
	args: EditViewArgs | undefined,
	uiTheme: Theme,
	options: { expanded?: boolean; width?: number } = {},
): string[] {
	const component = drawToolView(
		editToolView.renderResult(result, { expanded: options.expanded ?? false, partial: false }, args),
		uiTheme,
	);
	return component.render(options.width ?? 160).map(line => stripVTControlCharacters(line));
}

async function waitForRenderedText(
	component: ToolExecutionComponent,
	width: number,
	expectedText: string,
): Promise<string> {
	const deadline = Date.now() + 1_000;
	let rendered = "";
	while (Date.now() < deadline) {
		rendered = stripVTControlCharacters(component.render(width).join("\n"));
		if (rendered.includes(expectedText)) return rendered;
		await sleep(10);
	}
	return rendered;
}

describe("edit card", () => {
	it("shows the target path from partial JSON while edit args stream", async () => {
		const uiTheme = await getUiTheme();
		const rendered = drawCall(
			{
				edits: [{}],
				editMode: "replace",
				__partialJson: '{"edits":[{"path":"packages/coding-agent/src/edit/edit-view.ts","old_text":"before',
			},
			uiTheme,
		).join("\n");

		expect(rendered).toContain("packages/coding-agent/src/edit/edit-view.ts");
	});

	it("windows the expanded streaming diff to the viewport tail", async () => {
		const uiTheme = await getUiTheme();
		// Pin a tall viewport so previewWindowRows() (rows - reserve) lands at 30:
		// collapsed stays at the 12-row fixed tail, expanded widens to the viewport
		// less the headroom the settled card lands in.
		const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
		try {
			const makeDiff = (length: number): string =>
				Array.from({ length }, (_, index) => (index === 0 ? "-head-line-1" : `+tail-line-${index + 1}`)).join("\n");
			const renderPreview = (diff: string, expanded: boolean): string =>
				drawCall({ file_path: "/tmp/preview.ts", previewDiff: diff, editMode: "replace" }, uiTheme, {
					expanded,
					width: 200,
				}).join("\n");

			const collapsed = renderPreview(makeDiff(20), false);
			expect(collapsed).toContain("tail-line-20");
			expect(collapsed).not.toContain("head-line-1");
			expect(collapsed).toMatch(/\d+ earlier lines/);

			// Within the viewport window, expanded shows the whole diff.
			const expanded = renderPreview(makeDiff(20), true);
			expect(expanded).toContain("head-line-1");
			expect(expanded).toContain("tail-line-20");
			expect(expanded).not.toMatch(/earlier lines/);

			// Beyond it, expanded stays a viewport-sized tail window: an unbounded
			// live preview scrolls above the native-scrollback commit boundary and
			// freezes a stale snapshot that duplicates the block at finalize.
			const expandedTall = renderPreview(makeDiff(40), true);
			expect(expandedTall).toContain("tail-line-40");
			expect(expandedTall).not.toContain("head-line-1");
			expect(expandedTall).toMatch(/\d+ earlier lines/);
		} finally {
			if (originalRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
		}
	});

	it("uses hashline input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const rendered = drawCall(
			{
				input: "[packages/coding-agent/src/edit/edit-view.ts]\nINS.TAIL:\n+// preview",
				editMode: "hashline",
			},
			uiTheme,
		).join("\n");

		expect(rendered).toContain("packages/coding-agent/src/edit/edit-view.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("shows hashline envelope target path while preview diff is not computable yet", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = createToolExecution(
			"edit",
			{
				input: [
					"*** Begin Patch",
					"[natives/bridge/addon/src/shell.rs]",
					"INS.TAIL:",
					"+pub fn streaming_preview() {",
				].join("\n"),
			},
			{},
			hashlineTool,
			uiStub,
		);

		const rendered = stripVTControlCharacters(component.render(160).join("\n"));
		expect(rendered).toContain("natives/bridge/addon/src/shell.rs");
		expect(rendered).not.toContain("INS.TAIL:");
		expect(rendered).not.toContain("+pub fn streaming_preview() {");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactRendered = drawCall(
			{ input: "[foo bar.ts]\nINS.HEAD:\n+// preview", editMode: "hashline" },
			uiTheme,
			{
				expanded: true,
			},
		).join("\n");
		const quotedRendered = drawCall(
			{ input: "['baz qux.ts']\nINS.HEAD:\n+// preview", editMode: "hashline" },
			uiTheme,
		).join("\n");

		expect(compactRendered).toContain("foo bar.ts");
		expect(quotedRendered).toContain("baz qux.ts");
	});

	it("strips bracket delimiters from hashline input headers", async () => {
		const uiTheme = await getUiTheme();

		// Canonical `[PATH]` form — the parser strips the delimiters and the card
		// keeps the title clean.
		const canonicalRendered = drawCall(
			{
				input: "[packages/coding-agent/src/slash-commands/builtin-registry.ts]\nINS.HEAD:\n+// preview",
				editMode: "hashline",
			},
			uiTheme,
			{ expanded: true },
		).join("\n");

		// While streaming, the closing bracket may not have arrived yet.
		const partialRendered = drawCall({ input: "[a/b/c.ts\nINS.HEAD:\n+// preview", editMode: "hashline" }, uiTheme, {
			expanded: true,
		}).join("\n");

		expect(canonicalRendered).toContain("packages/coding-agent/src/slash-commands/builtin-registry.ts");
		expect(canonicalRendered).not.toMatch(/\[packages\/coding-agent/);
		expect(partialRendered).toContain("a/b/c.ts");
		expect(partialRendered).not.toMatch(/\[a\/b\/c\.ts/);
	});

	it("uses hashline input headers for completed single-file result path", async () => {
		const uiTheme = await getUiTheme();
		const rendered = drawResult(
			{
				content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/edit-view.ts" }],
				details: { diff: "+1|// preview", op: "update" },
			},
			{
				input: "[packages/coding-agent/src/edit/edit-view.ts]\nINS.TAIL:\n+// preview",
				editMode: "hashline",
			},
			uiTheme,
		).join("\n");

		expect(rendered).toContain("packages/coding-agent/src/edit/edit-view.ts");
		expect(rendered).not.toContain(" …");
	});

	it("omits changed-line suffixes from completed edit headers and middle-elides long paths", async () => {
		const uiTheme = await getUiTheme();
		const result: EditViewResult = {
			content: [{ type: "text", text: "Updated transcript-container.test.ts" }],
			details: {
				diff: "+1│const value = 2;",
				firstChangedLine: 251,
				op: "update",
				path: "/tmp/project/packages/coding-agent/test/modes/components/transcript-container.test.ts",
			},
		};
		const args: EditViewArgs = {
			file_path: "packages/coding-agent/test/modes/components/transcript-container.test.ts",
			editMode: "hashline",
		};

		const wideHeader = drawResult(result, args, uiTheme)[0]!;
		expect(wideHeader).toContain("packages/coding-agent/test/modes/components/transcript-container.test.ts");
		expect(wideHeader).not.toContain(":251");

		const narrowHeader = drawResult(result, args, uiTheme, { width: 72 })[0]!;
		expect(narrowHeader).toContain("…");
		expect(narrowHeader).toContain("container.test.ts");
		expect(narrowHeader).not.toContain(":251");
	});

	it("computes the hashline preview diff once a single-line edit finishes streaming", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-preview-"));
		try {
			const content = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
			const filePath = path.join(tmpDir, "memory.ts");
			await fs.writeFile(filePath, content);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, content);

			// The trailing payload line carries no newline — the common shape for a
			// single-line edit. The streaming pass trims that in-flight line, so the
			// preview only becomes computable once args are marked complete.
			const input = `[memory.ts#${tag}]\nSWAP 2.=2:\n+export const b = 22;`;
			const component = createToolExecution("edit", { input }, { snapshots }, hashlineTool, uiStub, tmpDir);

			component.setArgsComplete();

			// The preview diff computes asynchronously after args complete; poll
			// instead of a fixed sleep so the slower CI VM has time to finish it.
			const rendered = await waitForRenderedText(component, 160, "export const b = 22;");
			expect(rendered).toContain("export const b = 22;");
			expect(rendered).not.toContain("No changes would be made");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("renders raw custom hashline input carried only in partialJson", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-custom-stream-preview-"));
		try {
			const content = "export const a = 1;\nexport const b = 2;\n";
			const filePath = path.join(tmpDir, "memory.ts");
			await fs.writeFile(filePath, content);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, content);
			const input = `[memory.ts#${tag}]\nSWAP 2.=2:\n+export const b = 22;\n`;
			const component = createToolExecution(
				"edit",
				{ __partialJson: input },
				{ snapshots },
				hashlineTool,
				uiStub,
				tmpDir,
			);

			const rendered = await waitForRenderedText(component, 160, "export const b = 22;");
			expect(rendered).toContain("memory.ts");
			expect(rendered).toContain("export const b = 22;");
			expect(rendered.split("\n").find(line => line.includes("memory.ts"))).not.toContain("…");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("renders raw custom apply_patch input carried only in partialJson", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const input = [
			"*** Begin Patch",
			"*** Update File: src/demo.ts",
			"@@",
			"-const value = 1;",
			"+const value = 2;",
			"*** End Patch",
		].join("\n");

		const component = createToolExecution("apply_patch", { __partialJson: input }, {}, undefined, uiStub);
		const rendered = await waitForRenderedText(component, 160, "const value = 2;");

		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("const value = 2;");
		// The row naming the file states it whole; the card's own trailing "… (streaming)" row is the
		// host saying the call is still arriving, not an elided path.
		expect(rendered.split("\n").find(line => line.includes("src/demo.ts"))).not.toContain("…");
	});

	it("normalizes raw streamed text input for any renderer", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const customTextTool = {
			name: "custom_text",
			label: "Custom Text",
			renderCall(args: unknown) {
				const input =
					typeof (args as { input?: unknown }).input === "string" ? (args as { input: string }).input : "";
				return new Text(input, 0, 0);
			},
		} as unknown as AgentTool;

		const component = createToolExecution(
			"custom_text",
			{ __partialJson: "plain streamed text" },
			{},
			customTextTool,
			uiStub,
		);

		const rendered = stripVTControlCharacters(component.render(160).join("\n"));
		expect(rendered).toContain("plain streamed text");
	});

	it("renders change stats inline on the result header with no separate metadata or stats row", async () => {
		const uiTheme = await getUiTheme();
		const diff = [" 115│ ctx", "-116│ old", "+117│ new one", "+118│ new two"].join("\n");
		const lines = drawResult(
			{
				content: [{ type: "text", text: "Updated demo.go" }],
				details: { diff, op: "update" },
			},
			{ file_path: "demo.go", editMode: "hashline" },
			uiTheme,
		);

		// Stats ride on the header line next to the path…
		expect(lines[0]).toContain("demo.go");
		expect(lines[0]).toContain("+2");
		expect(lines[0]).toContain("-1");
		// …only there (no standalone stats row), and the diff starts immediately
		// below the header (no blank line, no lone lang-icon metadata row).
		expect(lines[1]).toContain("115│ ctx");
		expect(lines.filter(line => line.includes("+2") && line.includes("-1"))).toHaveLength(1);
	});

	it("renders completed edit gutters without inherited frame padding", async () => {
		const uiTheme = await getUiTheme();
		const lines = drawResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: { diff: "+1│const renamedIdentifier = computeValueFromSomeVeryLongInputName();", op: "update" },
			},
			{ file_path: "demo.ts", editMode: "hashline" },
			uiTheme,
			{ width: 48 },
		);

		// One rectangle, and it never reaches past the terminal: the block is as wide as
		// its own widest row rather than as wide as the screen.
		const widths = new Set(lines.map(visibleWidth));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBeLessThanOrEqual(48);
		// The gutter starts immediately after the block's chrome — the rail glyph and
		// one space — with no inherited pad column between them. It used to be a box
		// border here (`│+1│`), a shape the product no longer draws.
		const rail = uiTheme.symbol("block.rail");
		expect(lines[1]).toStartWith(`${rail} +1│`);
		expect(lines[1]).not.toStartWith(`${rail}  +1│`);
	});

	it("does not leak the first file's no-change preview into a multi-file delete result", async () => {
		const uiTheme = await getUiTheme();
		const paths = ["scripts/a.ts", "scripts/a.user.md", "scripts/a.system.md"];
		const rendered = drawResult(
			{
				content: [{ type: "text", text: paths.map(p => `Deleted ${p}`).join("\n") }],
				details: {
					diff: "",
					perFileResults: paths.map(filePath => ({
						path: filePath,
						diff: "",
						op: "delete" as const,
						oldText: "x\n",
					})),
				},
			},
			{
				editMode: "hashline",
				// The streaming preview only ever holds the first file's result; a
				// delete card must not fall back to it (issue: every card showed
				// "No changes would be made to <first file>").
				preview: { error: "No changes would be made to scripts/a.ts." },
			},
			uiTheme,
		).join("\n");

		expect(rendered).not.toContain("No changes would be made");
		for (const filePath of paths) expect(rendered).toContain(filePath);
	});

	it("renders a move-only result as source → destination with no diff body", async () => {
		const uiTheme = await getUiTheme();
		const lines = drawResult(
			{
				content: [{ type: "text", text: "Moved a.ts to b.ts" }],
				details: { diff: "", op: "update", path: "b.ts", move: "b.ts", sourcePath: "a.ts" },
			},
			{
				input: "[a.ts#1a2b]\nMV b.ts",
				editMode: "hashline",
				preview: { error: "No changes would be made to other.ts." },
			},
			uiTheme,
		);

		// Header shows the move as source → destination, not the buggy dest → dest.
		expect(lines[0]).toContain("a.ts");
		expect(lines[0]).toContain("b.ts");
		expect(lines[0]).toContain("→");
		expect(lines.join("\n")).not.toContain("No changes");
	});

	it("uses the result's own path for a genuine no-op, not the shared preview", async () => {
		const uiTheme = await getUiTheme();
		const rendered = drawResult(
			{
				content: [{ type: "text", text: "no change" }],
				details: { diff: "", op: "update", path: "scripts/real.ts" },
			},
			{
				file_path: "scripts/real.ts",
				editMode: "hashline",
				preview: { error: "No changes would be made to scripts/WRONG.ts." },
			},
			uiTheme,
		).join("\n");

		expect(rendered).toContain("No changes were made");
		expect(rendered).toContain("scripts/real.ts");
		expect(rendered).not.toContain("WRONG");
	});

	it("renders the delete gallery fixture as a Delete card without a no-change body", async () => {
		await getUiTheme();
		const text = (await renderGalleryState("edit_delete", resolveFixture("edit_delete"), "success", 160))
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(text).toContain("Delete");
		expect(text).toContain("scripts/prune-changelogs.ts");
		expect(text).not.toContain("No changes");
	});

	it("renders the move gallery fixture as source → destination", async () => {
		await getUiTheme();
		const text = (await renderGalleryState("edit_move", resolveFixture("edit_move"), "success", 160))
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(text).toContain("scripts/prune-changelogs.ts");
		expect(text).toContain("scripts/archived/prune-changelogs.ts");
		expect(text).toContain("→");
		expect(text).not.toContain("No changes");
	});
});

describe("edit card diff line wrapping", () => {
	// Renders a completed single-line replacement (`-N|old` + `+N|new`) through
	// the host's own diff drawing so the result carries its production shapes: a
	// blanked dedup gutter on the `+` row (`   +│`) and intra-line inverse highlights.
	async function renderSingleLineReplacement(
		oldLine: string,
		newLine: string,
		width: number,
	): Promise<readonly string[]> {
		const uiTheme = await getUiTheme();
		const component = drawToolView(
			editToolView.renderResult(
				{
					content: [{ type: "text", text: "Updated demo.ts" }],
					details: { diff: `-42|${oldLine}\n+42|${newLine}`, op: "update", path: "demo.ts" },
				},
				{ expanded: true, partial: false },
				{ file_path: "demo.ts" },
			),
			uiTheme,
		);
		return component.render(width);
	}

	/** Net SGR inverse state after scanning a row; 38/48 extended-color args must not be misread as attribute 7. */
	function inverseActiveAtRowEnd(row: string): boolean {
		let inverse = false;
		for (const match of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const params = match[1].split(";");
			for (let i = 0; i < params.length; i++) {
				const param = params[i];
				if (param === "38" || param === "48") {
					i += params[i + 1] === "2" ? 4 : params[i + 1] === "5" ? 2 : 0;
				} else if (param === "" || param === "0") inverse = false;
				else if (param === "7") inverse = true;
				else if (param === "27") inverse = false;
			}
		}
		return inverse;
	}

	it("keeps added-line continuation rows inside the blanked dedup gutter", async () => {
		// renderDiff blanks the repeated line number on the `+` row of a
		// single-line replacement (`   +│`); the wrapper must still recognize that
		// gutter instead of falling back to generic wrapping at column 0.
		const rows = (
			await renderSingleLineReplacement(
				"    the previous synopsis paragraph rambled across quarterly reconciliation notes enumerating every provisional ledger amendment the archival committee had deferred pending review by the regional custodians during the extended winter recess of the auditing season",
				"    the revised synopsis paragraph now catalogues seasonal festival logistics enumerating lantern shipments drum rehearsals and ribbon inventories that the parade stewards confirmed before dawn, closing with the zephyrQuota tally and the marbledFinale banner",
				100,
			)
		).map(row => stripVTControlCharacters(row));

		// The tail of the added line lands on continuation rows, which must carry the
		// spaces-only continuation gutter rather than start as bare prose — and carry
		// it in the SAME column as the gutter it continues. A regex for "whitespace
		// then a separator" cannot see that: the rail's own space satisfies it, so a
		// continuation prefix stripped of its padding reads as correct.
		const rail = (await getUiTheme()).symbol("block.rail");
		const separatorColumn = (row: string): number => row.indexOf("│");
		const tailRows = rows.filter(row => row.includes("zephyrQuota") || row.includes("marbledFinale"));
		expect(tailRows.length).toBeGreaterThanOrEqual(1);
		for (const row of tailRows) expect(separatorColumn(row)).toBe(separatorColumn(rows[1]!));
		// Every body row stays inside a code-frame gutter (`-42│`, `   +│`, `    │`),
		// hung on the rail. There is no bottom border to exclude any more: the last
		// row of the block is a body row.
		for (const row of rows.slice(1)) expect(row).toMatch(new RegExp(`^${rail}\\s*[+-]?\\s*\\d*│`));
	});

	it("closes inverse video at every wrapped row end so frame padding stays uninverted", async () => {
		// One changed token is wider than a row, so the wrap boundary must land
		// inside an inverse-highlighted span. The frame pads each row with spaces,
		// and inverse left active at row end paints those cells as gray blocks.
		const previousPolicy = getAnsiPolicy();
		setAnsiPolicy("full");
		let rows: readonly string[];
		try {
			rows = await renderSingleLineReplacement(
				`    ${"ancestralChronicle".repeat(12)}`,
				`    ${"luminousFestival".repeat(12)}`,
				100,
			);
		} finally {
			setAnsiPolicy(previousPolicy);
		}

		// Precondition: some continuation row's content reopens with inverse right
		// after its gutter, proving a highlighted span crossed a wrap boundary. If
		// diffWords tokenization ever changes so no span crosses, this fails loudly
		// instead of letting the row-end assertions pass vacuously.
		expect(rows.some(row => /│\x1b\[7m/.test(row))).toBe(true);
		for (const row of rows) expect(inverseActiveAtRowEnd(row)).toBe(false);
	});

	// Error results reuse the same body-line wrapper as diff rows; these tests
	// pin the boundary between prose that merely looks pipe-ish and real gutters.
	async function renderErrorResultRows(errorText: string): Promise<string[]> {
		const uiTheme = await getUiTheme();
		return drawResult(
			{
				content: [{ type: "text", text: errorText }],
				details: { diff: "", op: "update", path: "demo.ts" },
				isError: true,
			},
			{ file_path: "demo.ts" },
			uiTheme,
			{ expanded: true, width: 100 },
		);
	}

	it("does not give pipe-leading error text a phantom diff gutter when wrapping", async () => {
		// Error text is not a diff row even when it starts with `|`: an empty
		// gutter must wrap generically, not spawn `|` continuation prefixes.
		const rows = await renderErrorResultRows(
			"| pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		// Body rows are everything after the header. The block ends on its last body
		// row, so there is no trailing border to drop.
		const rail = (await getUiTheme()).symbol("block.rail");
		const bodyRows = rows.slice(1);
		// Precondition: the text actually wrapped, and the `|` lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(new RegExp(`^${rail} \\| `));
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(new RegExp(`^${rail}\\s*\\|`));
	});

	it("wraps spaces-then-bare-pipe error text generically instead of minting a gutter", async () => {
		// A digit-less ASCII "|" gutter never comes out of formatCodeFrameLine or
		// canonical diff rows; indented bare-pipe error text must wrap generically.
		const rows = await renderErrorResultRows(
			"   | indented bare-pipe diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		const rail = (await getUiTheme()).symbol("block.rail");
		const bodyRows = rows.slice(1);
		// Precondition: the text actually wrapped, and the pipe lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(new RegExp(`^${rail}\\s+\\| `));
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(new RegExp(`^${rail}\\s*\\|`));
	});

	it("wraps digit-leading pipe error text generically when the marker column is missing", async () => {
		// Canonical ASCII-pipe rows always carry a marker column (`-42|`, ` 42|`);
		// `123|` prose has a digit there instead, so it is not a diff row.
		const rows = await renderErrorResultRows(
			"123| numbered pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		const rail = (await getUiTheme()).symbol("block.rail");
		const bodyRows = rows.slice(1);
		// Precondition: the text actually wrapped, and the numbered lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(new RegExp(`^${rail} 123\\| `));
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(new RegExp(`^${rail}\\s*\\|`));
	});

	it("keeps the numbered ASCII-pipe gutter for canonical rows", async () => {
		// A numbered "-42|" row takes the gutter path and carries an "   |"
		// continuation gutter, not generic prose wrapping.
		const uiTheme = await getUiTheme();
		const rows = drawResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: {
					diff: "-42|    the previous synopsis paragraph rambled across quarterly reconciliation notes enumerating every provisional ledger amendment the archival committee had deferred pending review by the regional custodians",
					op: "update",
					path: "demo.ts",
				},
			},
			{ file_path: "demo.ts" },
			uiTheme,
			{ expanded: true, width: 100 },
		);

		const rail = uiTheme.symbol("block.rail");
		const bodyRows = rows.slice(1);
		// Precondition: the row actually wrapped past its first visual line.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(new RegExp(`^${rail}\\s*-42[│|]`));
		// Same column as the gutter it continues, not merely "some spaces then a pipe":
		// the rail contributes a space of its own, so the looser shape is satisfied by a
		// continuation prefix that lost its padding entirely.
		const separator = (row: string): number => Math.max(row.indexOf("|"), row.indexOf("│"));
		for (const row of bodyRows.slice(1)) expect(separator(row)).toBe(separator(bodyRows[0]!));
	});
});
