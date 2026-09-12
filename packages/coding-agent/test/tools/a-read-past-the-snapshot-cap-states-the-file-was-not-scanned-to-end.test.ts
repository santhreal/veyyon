/**
 * WHY THIS SUITE EXISTS:
 *
 * `read huge.txt` on a 10 MB, 104,857-line file printed `[Showing lines 1-300 of 324. Use :301 to
 * continue]`. A file over `SNAPSHOT_MAX_BYTES` is not scanned past the collected window (that is
 * the point of the cap: no full pass for an exact count), so `totalFileLines` is the window plus its
 * context, and the notice presented that lower bound as the file's length.
 *
 * CLASS: any truncation notice whose total came from a scan that stopped early. The read tool sets
 * `totalLinesUnknown` on every window it collects with `reachedEof === false` (plain file and
 * `artifact://`, unranged and ranged), and `formatTruncationMetaNotice` then prints the shown range
 * and states the file was not scanned to end, with no `of N`. The tool is driven through
 * `wrapToolWithMetaNotice`, the wrapper the registry applies to every builtin, because that is where
 * the notice is appended to the text the model reads. A file under the cap is the control: its
 * notice still reports the true total.
 *
 * DOES NOT CATCH: a scan that reaches EOF with a wrong count (the streamer's own suites), or the
 * summary path for parseable code, which has its own footer.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SNAPSHOT_MAX_BYTES } from "@veyyon/coding-agent/edit/file-snapshot-store";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

/** `count` rows of `width` bytes each, newline-terminated, so the byte size is exact. */
function rows(count: number, width: number): string {
	const body = "x".repeat(width - 1 - 6);
	let text = "";
	for (let n = 1; n <= count; n++) text += `${String(n).padStart(6, "0")}${body}\n`;
	return text;
}

const ROW_WIDTH = 100;
/** Rows needed to pass the cap by a margin, so the scan cannot reach EOF inside its window. */
const OVERSIZED_ROWS = Math.ceil((SNAPSHOT_MAX_BYTES * 1.25) / ROW_WIDTH);
const CONTROL_ROWS = 5000;

const UNSCANNED_NOTICE =
	/\[Showing lines (\d+)-(\d+) \(file not scanned to end(?:; [^)]+)?\)\. Use (?:artifact:\/\/0)?:(\d+) to continue\]/;
const TOTAL_CLAIM = / of \d+/;

describe("a read past the snapshot cap states the file was not scanned to end", () => {
	let tmpDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;

	function read(): ReadTool {
		return wrapToolWithMetaNotice(
			new ReadTool(
				makeToolSession({
					cwd: tmpDir,
					hasUI: false,
					getSessionFile: () => path.join(tmpDir, "session.jsonl"),
					getSessionSpawns: () => "*",
					getArtifactsDir: () => artifactDir,
					settings: Settings.isolated({ "read.summarize.enabled": false }),
				}),
			),
		);
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-unscanned-total-"));
		artifactDir = path.join(tmpDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await fs.writeFile(path.join(tmpDir, "huge.txt"), rows(OVERSIZED_ROWS, ROW_WIDTH));
		// No final newline, so the file has exactly CONTROL_ROWS lines and no trailing phantom row.
		await fs.writeFile(path.join(tmpDir, "small.txt"), rows(CONTROL_ROWS, ROW_WIDTH).slice(0, -1));
		await fs.writeFile(path.join(artifactDir, "0.bash.log"), rows(OVERSIZED_ROWS, ROW_WIDTH));
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await removeWithRetries(tmpDir);
	});

	// `shownFirstLine` is the first row printed: a ranged read pads one line of leading context, and
	// the notice states the window that was shown, not the one that was asked for.
	const oversized = [
		{ name: "plain file, no selector", target: "huge.txt", shownFirstLine: 1 },
		{ name: "plain file, open range", target: "huge.txt:40000-", shownFirstLine: 39999 },
		{ name: "plain file, bounded range longer than the window", target: "huge.txt:1-40000", shownFirstLine: 1 },
		{ name: "plain file, bounded range off the top", target: "huge.txt:100-40000", shownFirstLine: 99 },
		{ name: "artifact, no selector", target: "artifact://0", shownFirstLine: 1 },
		{ name: "artifact, open range", target: "artifact://0:40000-", shownFirstLine: 39999 },
		{ name: "artifact, bounded range longer than the window", target: "artifact://0:1-40000", shownFirstLine: 1 },
	] as const;

	for (const { name, target, shownFirstLine } of oversized) {
		it(`${name}: the notice states the shown range and no total`, async () => {
			const output = getText(await read().execute("r", { path: target }));
			const match = UNSCANNED_NOTICE.exec(output);
			expect(match).not.toBeNull();
			const [, start, end, next] = match as RegExpExecArray;
			expect(Number(start)).toBe(shownFirstLine);
			// The continuation selector is the line after the window, so paging never skips a row.
			expect(Number(next)).toBe(Number(end) + 1);
			// A bounded window of a file this size ends well before the file does.
			expect(Number(end)).toBeLessThan(OVERSIZED_ROWS);
			expect(output).not.toMatch(TOTAL_CLAIM);
		});
	}

	it("control: a file under the cap still reports its true total", async () => {
		const output = getText(await read().execute("r", { path: "small.txt" }));
		expect(output).toMatch(
			new RegExp(`\\[Showing lines 1-\\d+ of ${CONTROL_ROWS}(?: \\([^)]+\\))?\\. Use :\\d+ to continue\\]`),
		);
		expect(output).not.toContain("not scanned to end");
	});

	it("control: a bounded range that reaches past the end of an oversized file scans to EOF and reports its true total", async () => {
		// The selected-line accounting never hits its limit, so the scan runs to EOF and the count is
		// exact: the rows plus the trailing phantom row of a newline-terminated file.
		const output = getText(await read().execute("r", { path: `huge.txt:1-${OVERSIZED_ROWS * 2}` }));
		expect(output).toMatch(
			new RegExp(`\\[Showing lines 1-\\d+ of ${OVERSIZED_ROWS + 1}(?: \\([^)]+\\))?\\. Use :\\d+ to continue\\]`),
		);
		expect(output).not.toContain("not scanned to end");
	});
});
