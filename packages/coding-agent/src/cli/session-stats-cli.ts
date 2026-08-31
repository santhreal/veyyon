/**
 * `veyyon session stats [id]` — load a stored session and report how it spent
 * its time and tokens. Reads only; it resolves the file, loads its entries, and
 * hands them to the pure {@link computeSessionStats}. When no id is given it
 * studies the most recent session in the current directory.
 */

import { errorMessage } from "@veyyon/utils";
import { listSessions, resolveResumableSession } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import { computeSessionStats, type SessionStatsReport } from "./session-stats";
import { formatSessionStats } from "./session-stats-render";

export interface SessionStatsCommandArgs {
	/** Session id or filename prefix; unset studies the most recent session in cwd. */
	id?: string;
	json: boolean;
	cwd?: string;
}

/** Resolve the session file to study, or a message explaining why none matched. */
async function resolveSessionFile(
	args: SessionStatsCommandArgs,
	storage: FileSessionStorage,
): Promise<{ path: string } | { error: string }> {
	const cwd = args.cwd ?? process.cwd();
	if (args.id) {
		const match = await resolveResumableSession(args.id, cwd, undefined, storage, {
			allowGlobalFallback: true,
		});
		if (!match) return { error: `No session matches "${args.id}".` };
		return { path: match.session.path };
	}

	const sessionDir = computeDefaultSessionDir(cwd, storage);
	const sessions = await listSessions(sessionDir, storage);
	const newest = sessions[0];
	if (!newest) return { error: `No sessions found for ${cwd}.` };
	return { path: newest.path };
}

/** Build the report for a session file. Exported so the command and tests share one path. */
export async function buildSessionStatsReport(
	filePath: string,
	storage: FileSessionStorage = new FileSessionStorage(),
): Promise<SessionStatsReport> {
	const entries = await loadEntriesFromFile(filePath, storage);
	return computeSessionStats(entries);
}

export async function runSessionStatsCommand(args: SessionStatsCommandArgs): Promise<void> {
	const storage = new FileSessionStorage();
	const resolved = await resolveSessionFile(args, storage);
	if ("error" in resolved) {
		console.error(errorMessage(resolved.error));
		process.exitCode = 1;
		return;
	}

	const report = await buildSessionStatsReport(resolved.path, storage);
	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(formatSessionStats(report));
}
