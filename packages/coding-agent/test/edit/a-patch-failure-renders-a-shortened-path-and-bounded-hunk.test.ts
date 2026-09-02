import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { editToolView } from "@veyyon/coding-agent/edit/edit-view";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import { drawToolView } from "@veyyon/coding-agent/tui/draw-tool-view";

/**
 * WHY:
 *
 * When an edit patch fails to apply, the resulting ApplyPatchError contains the raw resolved
 * absolute path (including the home directory). If rendered unshortened, this leaks local usernames
 * and machine paths to the TUI and transcript. Furthermore, when a failed hunk contains a large
 * unmatched region (e.g. hundreds of lines), formatting the entire oldText without truncation
 * causes the framed error block to expand without bound and floods the transcript.
 *
 * This suite defends two contracts:
 * 1. Patch failure error rendering shortens absolute paths (using shortenPath) so home directories
 *    are rendered as '~' rather than leaking absolute home paths.
 * 2. In collapsed view, a large failed hunk is bounded to PREVIEW_LIMITS.DIFF_COLLAPSED_LINES and
 *    the card says how many lines it kept back. In expanded view, the full error content is visible
 *    with nothing held back.
 *
 * What this does not catch:
 * Failures outside tool rendering that log raw error objects directly to disk diagnostic logs.
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

/** The failed card a session draws for `filePath`, as the plain rows it occupies. */
function renderFailure(errorText: string, filePath: string, uiTheme: Theme, expanded: boolean): string {
	const component = drawToolView(
		editToolView.renderResult(
			{
				content: [{ type: "text", text: errorText }],
				details: { diff: "", op: "update", path: filePath },
				isError: true,
			},
			{ expanded, partial: false },
			{ file_path: filePath },
		),
		uiTheme,
	);
	return stripVTControlCharacters(component.render(120).join("\n"));
}

describe("patch failure error rendering", () => {
	it("renders a shortened home path rather than an absolute path containing the home directory", async () => {
		const uiTheme = await getUiTheme();
		const home = os.homedir();
		const absolutePath = path.join(home, "workspace", "project", "src", "index.ts");
		const shortenedPath = `~/workspace/project/src/index.ts`;
		const errorText = `Failed to find expected lines in ${absolutePath}:\nconst value = 1;`;

		const rendered = renderFailure(errorText, absolutePath, uiTheme, false);
		expect(rendered).toContain(shortenedPath);
		expect(rendered).not.toContain(home);
	});

	it("bounds a large unmatched hunk in collapsed view and shows an accurate omitted-line count", async () => {
		const uiTheme = await getUiTheme();
		const home = os.homedir();
		const absolutePath = path.join(home, "workspace", "project", "src", "large-file.ts");
		const shortenedPath = `~/workspace/project/src/large-file.ts`;

		// 100 old lines + 1 header line = 101 total lines in error body
		const oldLines = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`);
		const errorText = `Failed to find expected lines in ${absolutePath}:\n${oldLines.join("\n")}`;

		const collapsedRendered = renderFailure(errorText, absolutePath, uiTheme, false);
		expect(collapsedRendered).toContain(shortenedPath);
		expect(collapsedRendered).not.toContain(home);

		// First visible lines should be present
		expect(collapsedRendered).toContain("const line1 = 1;");
		expect(collapsedRendered).toContain("const line35 = 35;");

		// Total lines = 101. Bound = PREVIEW_LIMITS.DIFF_COLLAPSED_LINES (40). Omitted = 61 lines.
		const expectedHidden = 101 - PREVIEW_LIMITS.DIFF_COLLAPSED_LINES;
		expect(expectedHidden).toBe(61);
		expect(collapsedRendered).toContain(`${expectedHidden} more lines`);

		// Later lines past the bound should NOT be rendered in collapsed view
		expect(collapsedRendered).not.toContain("const line80 = 80;");
		expect(collapsedRendered).not.toContain("const line100 = 100;");

		const expandedRendered = renderFailure(errorText, absolutePath, uiTheme, true);
		expect(expandedRendered).toContain(shortenedPath);
		expect(expandedRendered).not.toContain(home);
		expect(expandedRendered).toContain("const line1 = 1;");
		expect(expandedRendered).toContain("const line80 = 80;");
		expect(expandedRendered).toContain("const line100 = 100;");
		expect(expandedRendered).not.toContain("more lines");
	});

	it("shortens paths across all error message variant shapes", async () => {
		const uiTheme = await getUiTheme();
		const home = os.homedir();
		const targetFile = path.join(home, "workspace", "module", "demo.ts");
		const shortened = `~/workspace/module/demo.ts`;

		const errorVariants = [
			`Failed to find expected lines in ${targetFile}:\nold line`,
			`Found 3 occurrences in ${targetFile}:\n\npreview 1\n\npreview 2`,
			`Found 2 high-confidence matches in ${targetFile}. The text must be unique.`,
			`Could not find a close enough match in ${targetFile}. Closest match (80% similar) at line 12.`,
			`File not found: ${targetFile}`,
			`Refusing partial-line match in ${targetFile} at line 15: dropped content.`,
			`Line hint 0 is out of range for ${targetFile} (line numbers start at 1)`,
			`Overlapping hunks detected in ${targetFile} at lines 1-5 and 4-10.`,
		];

		for (const errorText of errorVariants) {
			const rendered = renderFailure(errorText, targetFile, uiTheme, false);
			expect(rendered).toContain(shortened);
			expect(rendered).not.toContain(home);
		}
	});
});
