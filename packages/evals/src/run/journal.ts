/**
 * Append-only JSONL journal for trial execution.
 *
 * Each settled trial is written immediately as a single JSON line and synced
 * to disk (<runsDir>/<runId>/trials.jsonl). Large artifacts (file trees, logs)
 * are stored as disk paths, and rawOutput is bounded to a 64 KiB tail.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TrialArtifacts, TrialCell, TrialResultRecord } from "../core";
export const MAX_RAW_OUTPUT_CHARS = 65_536; // 64 KiB character ceiling

/**
 * Returns the canonical path to the trials.jsonl journal for a run.
 */
export function journalPathFor(runsDir: string, runId: string): string {
	return path.join(runsDir, runId, "trials.jsonl");
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
 */
export async function openRunJournal(runsDir: string, runId: string): Promise<RunJournal> {
	const journalPath = journalPathFor(runsDir, runId);
	await fs.mkdir(path.dirname(journalPath), { recursive: true });

	const handle = await fs.open(journalPath, "a");
	let writeQueue = Promise.resolve();

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
 * Returns an empty array if the journal does not exist.
 * Malformed or partial trailing lines are discarded.
 */
export async function readRunJournal(runsDir: string, runId: string): Promise<readonly TrialResultRecord[]> {
	const journalPath = journalPathFor(runsDir, runId);
	let content: string;
	try {
		content = await fs.readFile(journalPath, "utf-8");
	} catch {
		return [];
	}

	const lines = content.split("\n");
	const records: TrialResultRecord[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as TrialResultRecord;
			if (parsed?.cell && parsed.score) {
				records.push(sanitizeTrialRecord(parsed));
			}
		} catch {
			// Skip unparseable lines (e.g. truncated from abrupt termination)
		}
	}

	return records;
}
