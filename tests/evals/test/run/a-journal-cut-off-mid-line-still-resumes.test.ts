/**
 * WHY: a journal line is written by one `write` and a sync. A process killed during that write, or a
 * disk that fills, leaves the file ending mid-line. The reader skips a torn line while it is the
 * last one, so the resume after it went ahead; but it opened the journal for append and wrote its
 * first record onto the end of the torn one. The joined line parses as nothing and is no longer the
 * last, so every later read of the journal failed with a corrupt-line error: the run could be neither
 * resumed again nor reported.
 *
 * THE CLASS: a journal whose last line is incomplete being appended to as it stands. The cases cut a
 * journal the two ways a write can end early, mid-record and after a record but before its newline,
 * reopen it the way a resume does, append, and read it back.
 *
 * Not caught: a torn header, which states no plan and is refused as a journal of an unstated shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { openRunJournal, readRunJournal } from "../../engine/run/journal";
import type { TrialResultRecord } from "../../engine/run/record";

const RUN_ID = "torn-run";
const PLAN = "0123456789abcdef";

function record(task: string): TrialResultRecord {
	return {
		cell: { variant: "arm", suite: "probe", task, repeat: 1 },
		score: { reward: 1, partial: null, error: null, usage: null, extra: {} },
		artifacts: { trialDir: `/runs/${task}` },
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:01:00.000Z",
		durationMs: 60_000,
	};
}

describe("a journal whose last write was cut short", () => {
	let temp: TempDir;

	beforeEach(async () => {
		temp = await TempDir.create("evals-torn-journal-");
	});

	afterEach(async () => {
		await temp.remove();
	});

	/** Settle `settled`, then cut the file so it ends with `tail`, as a write ended early leaves it. */
	async function journalEndingIn(settled: readonly string[], tail: (line: string) => string): Promise<string> {
		const journal = await openRunJournal(temp.path(), RUN_ID, PLAN);
		for (const task of settled) await journal.append(record(task));
		await journal.close();
		await fs.appendFile(journal.path, tail(JSON.stringify(record("torn"))));
		return journal.path;
	}

	it("drops a record cut mid-line, and a resume appends after the last whole one", async () => {
		await journalEndingIn(["first"], line => line.slice(0, line.length / 2));
		expect((await readRunJournal(temp.path(), RUN_ID)).map(row => row.cell.task)).toEqual(["first"]);

		const resumed = await openRunJournal(temp.path(), RUN_ID, PLAN);
		await resumed.append(record("second"));
		await resumed.close();

		expect((await readRunJournal(temp.path(), RUN_ID)).map(row => row.cell.task)).toEqual(["first", "second"]);
	});

	it("keeps a record that lost only its newline, and a resume appends after it", async () => {
		await journalEndingIn(["first"], line => line);

		const resumed = await openRunJournal(temp.path(), RUN_ID, PLAN);
		await resumed.append(record("second"));
		await resumed.close();

		expect((await readRunJournal(temp.path(), RUN_ID)).map(row => row.cell.task)).toEqual([
			"first",
			"torn",
			"second",
		]);
	});

	it("keeps resuming after a second cut", async () => {
		await journalEndingIn(["first"], line => line.slice(0, 7));
		const once = await openRunJournal(temp.path(), RUN_ID, PLAN);
		await once.append(record("second"));
		await once.close();
		const path = await journalEndingIn([], line => line.slice(0, 11));

		const twice = await openRunJournal(temp.path(), RUN_ID, PLAN);
		await twice.append(record("third"));
		await twice.close();

		expect((await readRunJournal(temp.path(), RUN_ID)).map(row => row.cell.task)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect((await fs.readFile(path, "utf8")).endsWith("\n")).toBe(true);
	});
});
