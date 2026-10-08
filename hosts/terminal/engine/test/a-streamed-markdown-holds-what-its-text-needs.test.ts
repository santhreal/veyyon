/**
 * A streamed Markdown holds a bounded number of copies of its text while it streams, and once sealed
 * holds what one render of the same text holds.
 *
 * THE DEFECT. The streaming lexer re-lexes only the tail past the frozen prefix, and the tail was a
 * slice of the frame's text. A slice shares the buffer it was cut from, and so does every token marked
 * cuts from it. A provider builds its text by appending, so every frame reads a new buffer, and the
 * tokens frozen on each frame held that frame's whole text: one 206,000-character answer held 76 MiB.
 * Sealing changed nothing: the frozen tokens, the frozen rows and the text of the last settled
 * exposure stayed for the life of the block.
 *
 * THE CLASS. A string a Markdown keeps from a stream frame beyond what its current text and rows
 * need: a token, a row, a prefix, an exposure. Every block shape the streaming lexer freezes on, and a
 * diff fence the stream keeps open until its last line, is streamed one chunk per frame into a buffer
 * of its own, and the string bytes one instance holds afterwards are bounded against the same text
 * rendered once: while streaming, by twelve copies of the text, where the defect held hundreds; once
 * sealed, by half a copy. The closing paragraph keeps arriving for several frames after the last
 * block freezes, so the frame that froze last is never the frame that sealed. The measurement runs in
 * `fixtures/markdown-stream-retention.ts`, in a process of its own, and reads string bytes from a
 * heap snapshot rather than `heapStats().extraMemorySize`, which also counts compiled code and moved
 * by several copies of the text from one run to the next.
 *
 * WHAT IT DOES NOT CATCH. A sealed block that keeps less than half a copy of its text passes. The
 * streamed-diff line cache is refilled only for a diff fence that is neither the last token nor
 * frozen, so in every shape here its last refill reads the final frame, whose buffer the sealed text
 * holds anyway: keeping it past the seal costs one string cell and passes.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { type RetentionReport, SHAPE_NAMES } from "./fixtures/markdown-stream-retention";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "markdown-stream-retention.ts");

/** Every shape is measured by one fixture run, which takes several seconds. */
const MEASURE_TIMEOUT_MS = 120_000;

let report: RetentionReport | undefined;

function measured(shape: string): RetentionReport[string] {
	if (!report) {
		const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", timeout: MEASURE_TIMEOUT_MS });
		if (run.status !== 0) throw new Error(`fixture failed (${run.status}): ${run.stderr}`);
		report = JSON.parse(run.stdout) as RetentionReport;
	}
	const arms = report[shape];
	if (!arms) throw new Error(`fixture measured no ${shape}`);
	return arms;
}

describe("a streamed Markdown holds what its text needs", () => {
	it.each(SHAPE_NAMES.map(name => [name] as const))(
		"%s: while it streams, under twelve copies of the text",
		shape => {
			expect(measured(shape).streaming).toBeLessThan(12);
		},
		MEASURE_TIMEOUT_MS,
	);

	it.each(SHAPE_NAMES.map(name => [name] as const))(
		"%s: once sealed, what one render of the text holds",
		shape => {
			expect(measured(shape).sealed).toBeLessThan(0.5);
		},
		MEASURE_TIMEOUT_MS,
	);
});
