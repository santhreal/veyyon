/** Shared helpers for internal-url protocol handlers that resolve IDs against registered agent sessions. */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

/** Distinct conversation scopes with a LIVE root session in this process. A handler whose `ResolveContext` carries no agent id cannot tell which */
export function liveConversationScopes(): string[] {
	const scopes: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind !== "main" || !ref.session) continue;
		if (ref.scope === undefined || scopes.includes(ref.scope)) continue;
		scopes.push(ref.scope);
	}
	return scopes;
}

/** Snapshot of artifacts dirs for every registered session, deduped. Collects TWO candidate dirs per ref, because a subagent reads from its */
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

/** Recursively scan artifacts dirs for agent session transcripts, keyed by agent id (the `.jsonl` basename). Used by `history://` so transcripts of */
export async function sessionFilesFromDisk(): Promise<Map<string, string>> {
	const { files } = await scanSessionFilesFromDisk();
	return files;
}

/** Agent ids whose transcript was found in more than one artifacts dir, and so was deliberately omitted from {@link sessionFilesFromDisk}. Lets a caller distinguish */
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
			// The SAME file reached twice through two dir entries is not a collision: `artifactsDirsFromRegistry` deliberately returns overlapping roots (the
			if (existing === full) continue;
			ambiguous.add(id);
			found.delete(id);
		}
	};
	for (const dir of artifactsDirsFromRegistry()) await scan(dir, 0);
	return { files: found, ambiguous };
}
