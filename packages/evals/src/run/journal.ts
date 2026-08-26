/**
 * Append-only JSONL journal for trial execution.
 *
 * Each settled trial is written immediately as a single JSON line and synced
 * to disk (<runsDir>/<runId>/trials.jsonl). Large artifacts (file trees, logs)
 * are stored as disk paths, and rawOutput is bounded to a 64 KiB tail.
 *
 * The first line is a header stating the record shape the rest of the file holds. A resume
 * reads trials written by an earlier build of this package, so a shape it does not know is
 * rejected rather than mixed into a run: an outcome classified from fields a record predates
 * is not a measurement.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TrialArtifacts, TrialCell, TrialResultRecord } from "../core";
export const MAX_RAW_OUTPUT_CHARS = 65_536; // 64 KiB character ceiling

/** Marks a file as this journal rather than any other JSONL a run directory holds. */
export const RUN_JOURNAL_KIND = "veyyon-evals-trials";

/**
 * The trial record shape the journal writes. Bump this whenever a reader of a settled trial
 * starts depending on a field or a meaning the previous shape did not carry.
 */
export const RUN_JOURNAL_VERSION = 1;

export interface RunJournalHeader {
	readonly journal: string;
	readonly version: number;
	readonly runId: string;
}

/** A journal written before this shape existed, or by a build that writes another one. */
export class StaleRunJournalError extends Error {
	readonly journalPath: string;
	readonly foundVersion: number | null;

	constructor(journalPath: string, foundVersion: number | null) {
		super(
			`Journal '${journalPath}' holds trial records of ${
				foundVersion === null ? "an unstated shape" : `shape version ${foundVersion}`
			}; this build reads version ${RUN_JOURNAL_VERSION}. Start a new run id instead of resuming this one.`,
		);
		this.name = "StaleRunJournalError";
		this.journalPath = journalPath;
		this.foundVersion = foundVersion;
	}
}

/** A line that parses as JSON and is not a trial record: the file is not what its header says. */
export class CorruptRunJournalError extends Error {
	readonly journalPath: string;
	readonly lineNumber: number;

	constructor(journalPath: string, lineNumber: number) {
		super(`Journal '${journalPath}' line ${lineNumber} parses as JSON but is not a settled trial.`);
		this.name = "CorruptRunJournalError";
		this.journalPath = journalPath;
		this.lineNumber = lineNumber;
	}
}

/** A resume that names a run whose journal was never written. */
export class ResumeWithoutJournalError extends Error {
	readonly journalPath: string;
	readonly runId: string;

	constructor(journalPath: string, runId: string) {
		super(
			`Run '${runId}' has no trial journal at '${journalPath}', so there is nothing to resume. ` +
				`Drop --resume to start it, or pass the --run-id of a run that has already settled trials.`,
		);
		this.name = "ResumeWithoutJournalError";
		this.journalPath = journalPath;
		this.runId = runId;
	}
}

/**
 * Returns the canonical path to the trials.jsonl journal for a run.
 */
export function journalPathFor(runsDir: string, runId: string): string {
	return path.join(runsDir, runId, "trials.jsonl");
}

/**
 * Whether a run has a journal to resume from.
 *
 * Checked before the journal is opened for append, since opening one creates it: a resume
 * that ran the existence check afterwards found the file it had just written and read a
 * mistyped --run-id as a fresh run of every task.
 */
export async function journalExists(runsDir: string, runId: string): Promise<boolean> {
	try {
		await fs.access(journalPathFor(runsDir, runId));
		return true;
	} catch {
		return false;
	}
}

/** The header a journal opens with, or null when the first line is not one. */
function parseHeader(line: string): RunJournalHeader | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const header = parsed as Record<string, unknown>;
	if (header.journal !== RUN_JOURNAL_KIND) return null;
	if (typeof header.version !== "number") return null;
	return { journal: RUN_JOURNAL_KIND, version: header.version, runId: String(header.runId ?? "") };
}

/**
 * The header of an existing journal, or null when the file is absent or empty.
 * Throws when a journal exists and states a shape this build does not read.
 */
async function requireReadableJournal(journalPath: string): Promise<{ header: RunJournalHeader; body: string } | null> {
	let content: string;
	try {
		content = await fs.readFile(journalPath, "utf-8");
	} catch {
		return null;
	}
	if (content.trim() === "") return null;

	const newline = content.indexOf("\n");
	const firstLine = (newline === -1 ? content : content.slice(0, newline)).trim();
	const header = parseHeader(firstLine);
	if (header === null) {
		throw new StaleRunJournalError(journalPath, null);
	}
	if (header.version !== RUN_JOURNAL_VERSION) {
		throw new StaleRunJournalError(journalPath, header.version);
	}
	return { header, body: newline === -1 ? "" : content.slice(newline + 1) };
}

/**
 * Stable key for identifying a single trial cell across runs.
 */
export function cellKey(cell: TrialCell): string {
	return `${cell.suite}::${cell.task}::${cell.variant}::${cell.repeat}`;
}

/**
 * Trims the artifacts so they never retain unbounded memory in the journal or in-memory records.
 *
 * Only `rawOutput` is bounded. Every other field is carried through: an enumerated
 * allow-list silently dropped `usage`, which is the trial's only record of what the
 * provider billed, so a run's spend read as unmeasured after a resume.
 */
export function sanitizeArtifacts(artifacts: TrialArtifacts | undefined): TrialArtifacts | undefined {
	if (!artifacts) return undefined;

	let rawOutput = artifacts.rawOutput;
	if (typeof rawOutput === "string" && rawOutput.length > MAX_RAW_OUTPUT_CHARS) {
		rawOutput = rawOutput.slice(-MAX_RAW_OUTPUT_CHARS);
	}

	return { ...artifacts, rawOutput };
}

/**
 * Sanitizes a settled trial record before persisting or retaining in memory.
 */
export function sanitizeTrialRecord(record: TrialResultRecord): TrialResultRecord {
	return {
		cell: record.cell,
		score: record.score,
		artifacts: sanitizeArtifacts(record.artifacts),
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		durationMs: record.durationMs,
	};
}

export interface RunJournal {
	readonly path: string;
	append(record: TrialResultRecord): Promise<void>;
	close(): Promise<void>;
}

/**
 * Opens or creates an append-only JSONL journal for a run.
 * Concurrent appends are serialized and fsynced to disk per line.
 * A journal already on disk must state the record shape this build writes.
 */
export async function openRunJournal(runsDir: string, runId: string): Promise<RunJournal> {
	const journalPath = journalPathFor(runsDir, runId);
	await fs.mkdir(path.dirname(journalPath), { recursive: true });

	const existing = await requireReadableJournal(journalPath);
	const handle = await fs.open(journalPath, "a");
	let writeQueue = Promise.resolve();

	if (existing === null) {
		const header: RunJournalHeader = { journal: RUN_JOURNAL_KIND, version: RUN_JOURNAL_VERSION, runId };
		writeQueue = writeQueue.then(async () => {
			await handle.write(`${JSON.stringify(header)}\n`);
			await handle.sync();
		});
	}

	return {
		path: journalPath,
		append(record: TrialResultRecord): Promise<void> {
			const sanitized = sanitizeTrialRecord(record);
			const line = `${JSON.stringify(sanitized)}\n`;
			const next = writeQueue.then(async () => {
				await handle.write(line);
				await handle.sync();
			});
			writeQueue = next.catch(() => {});
			return next;
		},
		async close(): Promise<void> {
			try {
				await writeQueue;
			} finally {
				await handle.close();
			}
		},
	};
}

/**
 * Reads all settled trial records from an existing run journal.
 * Returns an empty array if the journal does not exist or holds only its header.
 * A partial trailing line from an abrupt termination is discarded; a complete line that is
 * not a settled trial, and a journal of another record shape, are reported.
 */
export async function readRunJournal(runsDir: string, runId: string): Promise<readonly TrialResultRecord[]> {
	const journalPath = journalPathFor(runsDir, runId);
	const existing = await requireReadableJournal(journalPath);
	if (existing === null) return [];

	const lines = existing.body.split("\n");
	const records: TrialResultRecord[] = [];

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// A torn write leaves one unparseable line, always the last one.
			if (i === lines.length - 1) continue;
			throw new CorruptRunJournalError(journalPath, i + 2);
		}
		const record = parsed as TrialResultRecord;
		if (!record?.cell || !record.score) {
			throw new CorruptRunJournalError(journalPath, i + 2);
		}
		records.push(sanitizeTrialRecord(record));
	}

	return records;
}
