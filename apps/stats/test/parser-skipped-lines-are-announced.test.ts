/**
 * A session line the parser cannot read is reported, because every number on the dashboard is a sum
 * over the lines it could.
 *
 * WHY THIS SUITE EXISTS. `parseSessionFile` walks a session file line by line and drops any line
 * that does not parse. Dropping is right: one corrupt line must not cost the whole session, and the
 * sibling suite `parser-malformed-entries.test.ts` covers keeping the run alive. What was missing is
 * that nothing said a line had been dropped.
 *
 * The consequence is quantitative and invisible. Token counts, cost, tool-call totals and message
 * counts are all sums over the entries that parsed, so a dropped line lowers every one of them, and
 * the result still looks like a complete session. A user comparing a week's spend against their
 * provider bill has no reason to suspect the parser rather than the bill (Law 10).
 *
 * A trailing PARTIAL line is deliberately NOT reported and that distinction is the load-bearing part
 * of this suite. The dashboard reads session files while the agent is still appending to them, so a
 * cut-off last line is the ordinary case on nearly every incremental pass; it is picked up whole on
 * the next pass from the same offset. Reporting it would produce a warning per poll per active
 * session and bury the real ones.
 */

import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionFile } from "@veyyon/stats/parser";
import { getSessionsDir, logger } from "@veyyon/utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-skipped-lines-");

const SKIP_MESSAGE = "Session file has unparseable lines; their messages are missing from every statistic";

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A well-formed assistant entry, so a test's only defect is the one it introduces. */
function assistantEntry(id: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-07-12T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			content: [{ type: "text", text: "hi" }],
			stopReason: "stop",
			usage: USAGE,
			timestamp: 1752000000000,
		},
	});
}

let counter = 0;

/** Writes the exact bytes given, so a trailing newline is the test's choice and not the helper's. */
async function writeSessionBytes(text: string): Promise<string> {
	counter += 1;
	const dir = path.join(getSessionsDir(), "--tmp--skipped-lines");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `session-${counter}.jsonl`);
	await Bun.write(file, text);
	return file;
}

/** Only this parser's warnings, so unrelated logging cannot satisfy or break an assertion. */
async function parseWithWarnings(
	file: string,
	fromOffset = 0,
): Promise<{ statCount: number; warnings: Array<Record<string, unknown>> }> {
	const captured: Array<Record<string, unknown>> = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		if (message === SKIP_MESSAGE) captured.push(fields ?? {});
	});
	try {
		const result = await parseSessionFile(file, fromOffset);
		return { statCount: result.stats.length, warnings: captured };
	} finally {
		spy.mockRestore();
	}
}

describe("a session file with an unreadable line", () => {
	it("reports the count and the byte offset, and still returns the lines that parsed", async () => {
		// The regression. Two good entries and one corrupt one between them: the corrupt line is
		// gone from every statistic, and this warning is the only thing that says so.
		const good = assistantEntry("a1");
		const file = await writeSessionBytes(`${good}\n{"broken": \n${assistantEntry("a2")}\n`);

		const { statCount, warnings } = await parseWithWarnings(file);

		expect(statCount).toBe(2);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.path).toBe(file);
		expect(warnings[0]?.skipped).toBe(1);
		// The offset is the line's first byte, so the line can be found with a seek rather than
		// by re-reading the file and guessing which one it was.
		expect(warnings[0]?.offsets).toEqual([good.length + 1]);
		expect(warnings[0]?.truncatedOffsets).toBe(false);
	});

	it("counts every unreadable line and lists each offset", async () => {
		// One warning per FILE, not per line: a file that lost thirty lines is one event with a
		// count of thirty, which is what a reader can act on.
		const first = assistantEntry("a1");
		const bad1 = "not json at all";
		const bad2 = '{"unclosed": [1, 2';
		const file = await writeSessionBytes(`${first}\n${bad1}\n${bad2}\n${assistantEntry("a2")}\n`);

		const { statCount, warnings } = await parseWithWarnings(file);

		expect(statCount).toBe(2);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.skipped).toBe(2);
		expect(warnings[0]?.offsets).toEqual([first.length + 1, first.length + 1 + bad1.length + 1]);
	});

	it("caps the offset list and says it was capped", async () => {
		// A file corrupted throughout would otherwise put thousands of offsets in one log record.
		// The cap keeps the record readable; `truncatedOffsets` keeps it honest.
		const lines = Array.from({ length: 25 }, (_, index) => `not json ${index}`);
		const file = await writeSessionBytes(`${lines.join("\n")}\n`);

		const { warnings } = await parseWithWarnings(file);

		expect(warnings.length).toBe(1);
		expect(warnings[0]?.skipped).toBe(25);
		expect((warnings[0]?.offsets as number[] | undefined)?.length).toBe(20);
		expect(warnings[0]?.truncatedOffsets).toBe(true);
	});

	it("reports offsets in the whole file, not in the slice it happened to read", async () => {
		// Incremental parsing starts at a saved offset. An offset relative to the slice would
		// point at the wrong line in every pass after the first, which makes the field worse than
		// absent: it would send the reader to a line that is fine.
		const first = assistantEntry("a1");
		const start = first.length + 1;
		const file = await writeSessionBytes(`${first}\nbroken line\n${assistantEntry("a2")}\n`);

		const { warnings } = await parseWithWarnings(file, start);

		expect(warnings.length).toBe(1);
		expect(warnings[0]?.offsets).toEqual([start]);
	});
});

describe("a session file with nothing wrong with it", () => {
	it("says nothing about a file whose every line parses", async () => {
		const file = await writeSessionBytes(`${assistantEntry("a1")}\n${assistantEntry("a2")}\n`);

		const { statCount, warnings } = await parseWithWarnings(file);

		expect(statCount).toBe(2);
		expect(warnings).toEqual([]);
	});

	it("says nothing about a trailing partial line, which is a file still being written", async () => {
		// The load-bearing silence. The agent appends while the dashboard reads, so this is the
		// state of nearly every active session on nearly every pass. A warning here would fire
		// continuously and make the real ones unreadable.
		const good = assistantEntry("a1");
		const file = await writeSessionBytes(`${good}\n{"type":"message","id":"a2","mess`);

		const { statCount, warnings } = await parseWithWarnings(file);

		expect(statCount).toBe(1);
		expect(warnings).toEqual([]);
	});

	it("reports the partial line only once it has been completed and is genuinely broken", async () => {
		// The pair to the test above, and the reason the distinction is safe to make: nothing is
		// lost by staying quiet, because the line is re-read from the same offset next pass. Here
		// the completed line is malformed, so the second pass is where it is finally reported.
		const good = assistantEntry("a1");
		const partial = await writeSessionBytes(`${good}\n{"type":"messa`);
		expect((await parseWithWarnings(partial)).warnings).toEqual([]);

		const completed = await writeSessionBytes(`${good}\n{"type":"messa\n`);
		const { warnings } = await parseWithWarnings(completed);

		expect(warnings.length).toBe(1);
		expect(warnings[0]?.skipped).toBe(1);
	});

	it("says nothing about blank lines, which carry no message to lose", async () => {
		// An empty line is not a dropped record. Reporting it would make the warning fire on any
		// file with a stray newline and cost it all its meaning.
		const file = await writeSessionBytes(`${assistantEntry("a1")}\n\n\n${assistantEntry("a2")}\n`);

		const { statCount, warnings } = await parseWithWarnings(file);

		expect(statCount).toBe(2);
		expect(warnings).toEqual([]);
	});

	it("says nothing about a file that does not exist", async () => {
		const missing = path.join(getSessionsDir(), "--tmp--skipped-lines", "absent.jsonl");

		const { statCount, warnings } = await parseWithWarnings(missing);

		expect(statCount).toBe(0);
		expect(warnings).toEqual([]);
	});
});
