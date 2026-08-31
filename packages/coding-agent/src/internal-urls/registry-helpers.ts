/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { isMissingPath } from "@veyyon/utils/fs-error";
import { isSessionFileName, sessionFileStem } from "@veyyon/utils/session-file";
import { AgentRegistry } from "../registry/agent-registry";

const extraArtifactsDirs = new Set<string>();

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Distinct conversation scopes with a LIVE root session in this process.
 *
 * A handler whose `ResolveContext` carries no agent id cannot tell which
 * conversation asked it a question. That is harmless while the process drives
 * one conversation, and is a guess the moment it drives two: ACP's `session/new`
 * keeps every session it has opened in one map, so a `veyyon acp` process
 * routinely holds several live `kind: "main"` refs at once, each with its own
 * scope.
 *
 * `length > 1` is therefore the honest trigger for refusing rather than
 * guessing, the same test `local://` already applies to its own root lookup.
 * A root with no scope (a collab mirror, a hand-built test ref) contributes
 * nothing: it cannot make a process multi-conversation on its own, and counting
 * it would break every render-only caller.
 */
export function liveConversationScopes(): string[] {
	const scopes: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind !== "main" || !ref.session) continue;
		if (ref.scope === undefined || scopes.includes(ref.scope)) continue;
		scopes.push(ref.scope);
	}
	return scopes;
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are written
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output therefore lives in the write-time dir, not the
 * adopted one, so `agent://` must scan both or it 404s a live nested peer.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 */
export function artifactsDirsFromRegistry(): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

/**
 * Recursively scan artifacts dirs for agent session transcripts, keyed by
 * agent id (the `.jsonl` basename). Used by `history://` so transcripts of
 * agents no longer in the registry (unregistered one-shot helpers, released
 * agents, or any agent after session resume) remain reachable — mirroring how
 * `agent://` reads `.md` outputs straight off disk.
 *
 * Layout follows `task/index.ts`: a subagent's transcript is
 * `<artifactsDir>/<AgentId>.jsonl`, and its own children nest one level deeper
 * under `<artifactsDir>/<AgentId>/<AgentId>.<ChildId>.jsonl`. Advisor
 * transcripts (`__advisor*.jsonl`) are observability-only and excluded;
 * EPERM-rewrite backups (`.bak`) are skipped.
 *
 * AN ID FOUND IN MORE THAN ONE DIR IS OMITTED rather than resolved to the first
 * hit. Two conversations in one process can each run an agent of the same name,
 * and `history://Worker` then meant "whichever dir the registry enumerated
 * first": another conversation's transcript, returned as though it were the
 * caller's. A transcript is what an operator reads to decide what an agent did,
 * so handing over the wrong one silently is worse than reporting it unavailable.
 * Omitting rather than throwing keeps this a pure lookup, and the caller reports
 * the miss; {@link ambiguousSessionFileIds} names the ids that were dropped so a
 * caller can say "ambiguous" instead of "not found".
 *
 * The proper fix is to key transcripts by conversation as well as agent id,
 * which would make the collision impossible rather than merely detected. Not
 * done here: it changes the on-disk layout and every existing reference.
 */
export async function sessionFilesFromDisk(): Promise<Map<string, string>> {
	const { files } = await scanSessionFilesFromDisk();
	return files;
}

/**
 * Agent ids whose transcript was found in more than one artifacts dir, and so was
 * deliberately omitted from {@link sessionFilesFromDisk}. Lets a caller distinguish
 * "no such agent" from "several agents share that name in this process", which are
 * different problems with different remedies.
 */
export async function ambiguousSessionFileIds(): Promise<Set<string>> {
	const { ambiguous } = await scanSessionFilesFromDisk();
	return ambiguous;
}

async function scanSessionFilesFromDisk(): Promise<{ files: Map<string, string>; ambiguous: Set<string> }> {
	const found = new Map<string, string>();
	const ambiguous = new Set<string>();
	const seenDirs = new Set<string>();
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > 8 || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (isMissingPath(err)) return;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const name = entry.name;
			if (!isSessionFileName(name)) continue;
			if (name.startsWith("__advisor")) continue;
			const id = sessionFileStem(name);
			const full = path.join(dir, name);
			const existing = found.get(id);
			if (existing === undefined) {
				found.set(id, full);
				continue;
			}
			// The SAME file reached twice through two dir entries is not a collision:
			// `artifactsDirsFromRegistry` deliberately returns overlapping roots (the
			// adopted dir and the write-time dir), and the recursive walk can arrive at
			// one transcript by both routes. Only two DISTINCT paths are ambiguous.
			if (existing === full) continue;
			ambiguous.add(id);
			found.delete(id);
		}
	};
	for (const dir of artifactsDirsFromRegistry()) await scan(dir, 0);
	return { files: found, ambiguous };
}
