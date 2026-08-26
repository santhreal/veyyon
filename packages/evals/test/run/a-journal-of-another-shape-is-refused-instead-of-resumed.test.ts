/**
 * WHY THIS SUITE EXISTS.
 *
 * The defect it closes: `--resume` read `trials.jsonl` as whatever shape the running build
 * expects. The journal carried no statement of the shape it was written in, so a run resumed
 * across a change to the trial record mixed two shapes in one result set, and every line whose
 * shape the reader did not recognise was dropped without a word -- a resumed run that reported
 * fewer trials than it settled, and a report built from a denominator nobody could reproduce.
 * The trial record changed under exactly this file: an outcome is now classified from
 * `score.reward` as well as `score.error`, so a record predating that field is not a grade.
 *
 * The class, not the incident: this suite does not pin one version number. It asserts the
 * journal states its record shape, that a header stating any other shape is rejected on both
 * the read path and the append path, and that a line the reader cannot use is reported rather
 * than skipped -- with one exception, a torn final line, which is what an abrupt termination
 * leaves and the only loss a resume may absorb. Bumping `RUN_JOURNAL_VERSION` needs no edit
 * here, and removing the header, the version check, or the mid-file corruption check turns
 * this suite red.
 *
 * What it does not catch: whether the records of the current version are semantically right
 * for the suite that wrote them -- the header states a shape, not a provenance -- and it does
 * not prove `fsync` reached the platter, only that the bytes are in the file in order.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TrialResultRecord } from "../../src/core";

/** Any journal these cases open belongs to one plan; the digest itself is not the subject. */
const PLAN_DIGEST = "0123456789abcdef";

import {
	CorruptRunJournalError,
	journalPathFor,
	openRunJournal,
	RUN_JOURNAL_KIND,
	RUN_JOURNAL_VERSION,
	readRunJournal,
	StaleRunJournalError,
} from "../../src/run/journal";

const RUN_ID = "run-journal-shape";

let runsDir = "";

beforeEach(async () => {
	runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "evals-journal-"));
});

afterEach(async () => {
	await fs.rm(runsDir, { recursive: true, force: true });
});

function trial(task: string, reward: number | null = 1): TrialResultRecord {
	return {
		cell: { variant: "baseline", suite: "demo", task, repeat: 0 },
		score: { reward, partial: null, error: null, usage: null, extra: {} },
		finishedAt: "2026-01-01T00:00:00.000Z",
	};
}

/** Writes a journal by hand, the way an earlier build or a torn write left one. */
async function writeJournal(lines: readonly string[]): Promise<string> {
	const journalPath = journalPathFor(runsDir, RUN_ID);
	await fs.mkdir(path.dirname(journalPath), { recursive: true });
	await fs.writeFile(journalPath, lines.join("\n"), "utf-8");
	return journalPath;
}

function headerLine(version: number): string {
	return JSON.stringify({ journal: RUN_JOURNAL_KIND, version, runId: RUN_ID, plan: PLAN_DIGEST });
}

describe("a journal of another shape is refused instead of resumed", () => {
	it("opens a new journal with a header stating the record shape, before any trial", async () => {
		const journal = await openRunJournal(runsDir, RUN_ID, PLAN_DIGEST);
		await journal.append(trial("t1"));
		await journal.close();

		const lines = (await fs.readFile(journal.path, "utf-8")).trim().split("\n");
		expect(JSON.parse(lines[0])).toEqual({
			journal: RUN_JOURNAL_KIND,
			version: RUN_JOURNAL_VERSION,
			runId: RUN_ID,
			plan: PLAN_DIGEST,
		});
		expect(JSON.parse(lines[1]).cell.task).toBe("t1");
		expect(lines).toHaveLength(2);
	});

	it("reads back every appended trial in the order it settled", async () => {
		const journal = await openRunJournal(runsDir, RUN_ID, PLAN_DIGEST);
		for (const task of ["t1", "t2", "t3"]) await journal.append(trial(task));
		await journal.close();

		const records = await readRunJournal(runsDir, RUN_ID);
		expect(records.map(r => r.cell.task)).toEqual(["t1", "t2", "t3"]);
	});

	it("reads a header-only journal as no settled trials", async () => {
		const journal = await openRunJournal(runsDir, RUN_ID, PLAN_DIGEST);
		await journal.close();
		expect(await readRunJournal(runsDir, RUN_ID)).toEqual([]);
	});

	it("reads an absent journal as no settled trials", async () => {
		expect(await readRunJournal(runsDir, "never-ran")).toEqual([]);
	});

	it("reopens its own journal and appends without a second header", async () => {
		const first = await openRunJournal(runsDir, RUN_ID, PLAN_DIGEST);
		await first.append(trial("t1"));
		await first.close();

		const second = await openRunJournal(runsDir, RUN_ID, PLAN_DIGEST);
		await second.append(trial("t2"));
		await second.close();

		const lines = (await fs.readFile(second.path, "utf-8")).trim().split("\n");
		expect(lines).toHaveLength(3);
		expect((await readRunJournal(runsDir, RUN_ID)).map(r => r.cell.task)).toEqual(["t1", "t2"]);
	});

	it("refuses a journal that states no shape at all", async () => {
		const journalPath = await writeJournal([JSON.stringify(trial("t1")), ""]);
		const failure = readRunJournal(runsDir, RUN_ID);
		await expect(failure).rejects.toThrow(StaleRunJournalError);
		await expect(failure).rejects.toThrow(journalPath);
	});

	it("refuses a journal written in an older or newer shape, naming both versions", async () => {
		for (const version of [RUN_JOURNAL_VERSION - 1, RUN_JOURNAL_VERSION + 1]) {
			await writeJournal([headerLine(version), JSON.stringify(trial("t1")), ""]);
			const caught = await readRunJournal(runsDir, RUN_ID).then(
				() => null,
				(err: unknown) => err as StaleRunJournalError,
			);
			expect(caught?.name).toBe("StaleRunJournalError");
			expect(caught?.foundVersion).toBe(version);
			expect(caught?.message).toContain(`version ${RUN_JOURNAL_VERSION}`);
			expect(caught?.message).toContain(String(version));
		}
	});

	it("refuses to append to a journal of another shape rather than mixing shapes", async () => {
		await writeJournal([headerLine(RUN_JOURNAL_VERSION + 1), JSON.stringify(trial("t1")), ""]);
		await expect(openRunJournal(runsDir, RUN_ID, PLAN_DIGEST)).rejects.toThrow(StaleRunJournalError);

		await writeJournal([JSON.stringify(trial("t1")), ""]);
		await expect(openRunJournal(runsDir, RUN_ID, PLAN_DIGEST)).rejects.toThrow(StaleRunJournalError);
	});

	it("absorbs a torn final line and keeps the trials that settled before it", async () => {
		await writeJournal([headerLine(RUN_JOURNAL_VERSION), JSON.stringify(trial("t1")), '{"cell":{"var']);
		const records = await readRunJournal(runsDir, RUN_ID);
		expect(records.map(r => r.cell.task)).toEqual(["t1"]);
	});

	it("reports a torn line that is not the last one, naming the line", async () => {
		await writeJournal([headerLine(RUN_JOURNAL_VERSION), '{"cell":{"var', JSON.stringify(trial("t2")), ""]);
		const caught = await readRunJournal(runsDir, RUN_ID).then(
			() => null,
			(err: unknown) => err as CorruptRunJournalError,
		);
		expect(caught?.name).toBe("CorruptRunJournalError");
		expect(caught?.lineNumber).toBe(2);
	});

	it("reports a complete line that is not a settled trial rather than dropping it", async () => {
		await writeJournal([
			headerLine(RUN_JOURNAL_VERSION),
			JSON.stringify(trial("t1")),
			JSON.stringify({ note: "something else entirely" }),
			"",
		]);
		const caught = await readRunJournal(runsDir, RUN_ID).then(
			() => null,
			(err: unknown) => err as CorruptRunJournalError,
		);
		expect(caught?.name).toBe("CorruptRunJournalError");
		expect(caught?.lineNumber).toBe(3);
	});

	it("reports a trial line missing its score, which no reader can grade", async () => {
		await writeJournal([headerLine(RUN_JOURNAL_VERSION), JSON.stringify({ cell: trial("t1").cell }), ""]);
		await expect(readRunJournal(runsDir, RUN_ID)).rejects.toThrow(CorruptRunJournalError);
	});
});
