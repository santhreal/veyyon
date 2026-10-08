/**
 * The session snapshot `/export` and `/share` serialize: the header, entries and leaf of a session,
 * plus the agent transcripts stored beside its file. The HTML template and its inlined viewer assets
 * are in `./html`, which only the export writer loads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentState } from "@veyyon/agent-core";
import type { SessionEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { isEnoent } from "@veyyon/utils";
import { isSessionFileName, SESSION_BACKUP_EXTENSION } from "@veyyon/utils/session-file";

/** Embedded agent session transcript, keyed by slash-joined agent path in `SessionData.subSessions`. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
}

export interface SessionData {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	systemPrompt?: string;
	tools?: { name: string; description: string }[];
	subSessions?: Record<string, SubSession>;
}

/** Snapshot the session (plus optional agent state) into the JSON shape the viewer renders. */
export function buildSessionData(sm: SessionManager, state?: AgentState): SessionData {
	return {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt.join("\n\n"),
		tools: state?.tools?.map(t => ({ name: t.name, description: t.description })),
	};
}

/**
 * Collect agent session transcripts stored next to a session file.
 *
 * A session at `<dir>/<name>.jsonl` keeps its agent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each agent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Keys in the
 * returned record are slash-joined ids relative to the main session ("ToolAsk", "ToolAsk/Helper").
 * Empty files, backups, and unrelated files are skipped. A corrupt transcript refuses the export so
 * the resulting artifact cannot silently claim to contain a complete session.
 */
export async function collectSubSessions(sessionFile: string): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!isSessionFileName(sessionFile)) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	for (const name of names) {
		if (!isSessionFileName(name) || name.includes(SESSION_BACKUP_EXTENSION)) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const fileEntries = await loadEntriesFromFile(path.join(dir, name));
		// Empty/corrupt files (no valid session header) load as [] — skip silently.
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
			};
		}
		await collectSubSessionsFromDir(path.join(dir, agentId), key, out);
	}
}
