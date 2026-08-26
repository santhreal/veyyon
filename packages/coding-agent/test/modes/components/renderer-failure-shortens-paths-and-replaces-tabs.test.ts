/**
 * WHY: `rendererFailureNotice` previously rendered error messages, subjects, and fallback
 * descriptions without sanitization. An error thrown by a third-party tool or extension renderer
 * frequently embeds local file paths (e.g. `ENOENT: /home/username/project/file.ts`), raw tabs
 * (which open visual holes in TUI layout), or massive multiline strings / diffs that corrupt the
 * transcript card.
 *
 * This suite closes the class by verifying that:
 * 1. Home directory paths embedded in errors, subjects, or fallback descriptions are shortened
 *    to `~` via `shortenEmbeddedPaths` and never leak the user's home directory.
 * 2. Tabs are converted to spaces with `replaceTabs`.
 * 3. Overly long error payloads are bounded with `truncateToWidth` using `TRUNCATE_LENGTHS.LINE`.
 * 4. Whitespace error messages still fall back cleanly to "no message" and empty messages report error name.
 *
 * GAP: Does not assert on terminal color rendering; styling is stripped before text assertions.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { rendererFailureNotice, reportRendererFailure } from "@veyyon/coding-agent/modes/components/renderer-failure";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";

describe("rendererFailureNotice sanitization", () => {
	const homedir = os.homedir();

	beforeAll(async () => {
		await initTheme();
	});

	it("shortens home directory paths embedded in error messages", () => {
		const error = new Error(`ENOENT: no such file or directory, open '${homedir}/src/app.ts'`);
		const notice = rendererFailureNotice("tool widget", error, "showing raw output");

		expect(notice).not.toContain(homedir);
		expect(notice).toContain("~/src/app.ts");
	});

	it("shortens home directory paths in fallback descriptions", () => {
		const error = new Error("renderer crashed");
		const notice = rendererFailureNotice(
			"tool edit",
			error,
			`no result is shown for ${homedir}/projects/my-repo/index.ts`,
		);

		expect(notice).not.toContain(homedir);
		expect(notice).toContain("no result is shown for ~/projects/my-repo/index.ts");
	});

	it("shortens home directory paths in subjects", () => {
		const error = new Error("failed");
		const notice = rendererFailureNotice(`tool "${homedir}/bin/custom-tool"`, error, "showing fallback");

		expect(notice).not.toContain(homedir);
		expect(notice).toContain('tool "~/bin/custom-tool"');
	});

	it("replaces tabs with spaces in errors, subjects, and fallbacks", () => {
		const error = new Error("column1\tcolumn2\tcolumn3");
		const notice = rendererFailureNotice("tool\ttest", error, "fallback\tdetail");

		expect(notice).not.toContain("\t");
		expect(notice).toContain("column1 column2 column3");
		expect(notice).toContain("tool test");
		expect(notice).toContain("fallback detail");
	});

	it("collapses multi-line errors into a single line", () => {
		const error = new Error("line 1\nline 2\r\nline 3\n\nline 4");
		const notice = rendererFailureNotice("tool", error, "fallback");

		expect(notice).not.toContain("\n");
		expect(notice).not.toContain("\r");
		expect(notice).toContain("line 1 line 2 line 3 line 4");
	});

	it("truncates very long error messages to TRUNCATE_LENGTHS.LINE", () => {
		const hugeMessage = "error_payload_".repeat(50);
		const error = new Error(hugeMessage);
		const notice = rendererFailureNotice("tool", error, "fallback");

		// Detail should be truncated and end with ellipsis
		expect(notice).toContain("…");
		// Ensure the error detail inside the notice does not span unbounded columns
		const match = notice.match(/renderer threw: (.*) — fallback/);
		expect(match).toBeDefined();
		const detail = match![1];
		expect(detail.length).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});

	it('falls back to "no message" when error message is only whitespace', () => {
		expect(rendererFailureNotice("tool", new Error("   \t  "), "fallback")).toContain("renderer threw: no message —");
	});

	it("falls back to error name when error message is empty", () => {
		expect(rendererFailureNotice("tool", new Error(""), "fallback")).toContain("renderer threw: Error —");
		expect(rendererFailureNotice("tool", new TypeError(""), "fallback")).toContain("renderer threw: TypeError —");
	});

	it("handles non-Error thrown objects and strings with paths", () => {
		const thrownString = `failed reading ${homedir}/config.json`;
		const noticeStr = rendererFailureNotice("tool", thrownString, "fallback");
		expect(noticeStr).not.toContain(homedir);
		expect(noticeStr).toContain("~/config.json");

		const thrownObj = { path: `${homedir}/data.db` };
		const noticeObj = rendererFailureNotice("tool", thrownObj, "fallback");
		expect(noticeObj).not.toContain(homedir);
	});

	it("reportRendererFailure produces a Text component with sanitized notice", () => {
		const error = new Error(`crash at ${homedir}/script.js\twith tabs`);
		const text = reportRendererFailure("tool", error, `check ${homedir}/log.txt`);

		const rendered = Bun.stripANSI(text.render(200).join("\n"));
		expect(rendered).not.toContain(homedir);
		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("~/script.js");
		expect(rendered).toContain("~/log.txt");
	});
});
