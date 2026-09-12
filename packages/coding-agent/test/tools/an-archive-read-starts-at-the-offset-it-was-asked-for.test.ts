/**
 * WHY THIS SUITE EXISTS:
 *
 * `read.ts` converts a 1-indexed `offset` into a 0-indexed slice start at four separate sites,
 * each written out longhand. `.captures/check-read-offset-slice-mutations.ts` mutates all four and
 * requires a suite to catch each one. Two sites had no such suite: the in-memory text window
 * (`#buildInMemoryTextResult`, reached here through an archive MEMBER read) and the archive entry
 * listing (`#readArchiveDirectory`). Both mutations survived, which is the gate reporting a test
 * nobody wrote rather than a defect.
 *
 * DEFENDS, for each of those two sites:
 * 1. `drop-offset` — ignoring the offset and answering from the first row.
 * 2. `off-by-one` — using the 1-indexed value as a 0-indexed index, dropping the first requested row.
 *
 * The member read uses a RAW selector deliberately. Raw mode never expands leading or trailing
 * context, so the returned window is exactly the requested row; with context expansion an
 * off-by-one start can still emit the requested row as padding and survive.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * The end of either window. `limit`, the trailing-context expansion and the head truncation that
 * run after the slice have their own suites, so a defect in how the window ENDS will not surface
 * here. It also proves nothing about the on-disk text or directory paths, which
 * `read-directory-range.test.ts` and the range suites own.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "read.summarize.enabled": false }),
	});
}

/** Zero-padded so `LINE-001` is never a substring of another marker. */
function numberedLines(count: number): Uint8Array {
	const rows: string[] = [];
	for (let n = 1; n <= count; n++) rows.push(`LINE-${String(n).padStart(3, "0")}`);
	return new TextEncoder().encode(`${rows.join("\n")}\n`);
}

describe("an archive read starts at the offset it was asked for", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-archive-offset-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("answers an archive member's raw single-line window from that line, not the first", async () => {
		const archivePath = path.join(tmpDir, "lines.zip");
		await Bun.write(archivePath, zip({ "lines.txt": numberedLines(60) }));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-member-offset", {
			path: `${archivePath}:lines.txt:raw:50-50`,
		});
		const output = getText(result);

		expect(output).toContain("LINE-050");
		// `drop-offset` answers from the beginning; `off-by-one` answers from line 51.
		expect(output).not.toContain("LINE-001");
		expect(output).not.toContain("LINE-051");
	});

	it("answers an archive directory listing from the requested entry, not the first", async () => {
		const archivePath = path.join(tmpDir, "tree.zip");
		const members: Record<string, Uint8Array> = {};
		for (let n = 1; n <= 30; n++) {
			members[`dir/entry-${String(n).padStart(3, "0")}.txt`] = new TextEncoder().encode(`body ${n}\n`);
		}
		await Bun.write(archivePath, zip(members));

		const tool = new ReadTool(createSession(tmpDir));
		const result = await tool.execute("read-archive-listing-offset", { path: `${archivePath}:dir:20` });
		const output = getText(result);

		expect(output).toContain("entry-020");
		// `drop-offset` lists from the first entry; `off-by-one` skips to the 21st.
		expect(output).not.toContain("entry-001");
		expect(output).not.toContain("entry-019");
	});
});
