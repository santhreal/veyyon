import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalUrl, ResolveContext } from "./types";

export const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

export interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
}

export function parseArtifactId(url: InternalUrl): string {
	const id = url.rawHost || url.hostname;
	if (!id) {
		throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	}
	if (!/^\d+$/.test(id)) {
		throw new Error(`artifact:// ID must be numeric, got: ${id}`);
	}
	return id;
}

export async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	const dirs = artifactsDirsFromRegistry();
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	if (pinnedDir) {
		const pinnedIndex = dirs.indexOf(pinnedDir);
		if (pinnedIndex >= 0) dirs.splice(pinnedIndex, 1);
		dirs.unshift(pinnedDir);
	}

	if (dirs.length === 0) {
		throw new Error("No session - artifacts unavailable");
	}

	const matches: string[] = [];
	let anyDirExists = false;
	const availableIds = new Set<string>();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = await fs.readdir(dir);
			anyDirExists = true;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const match = files.find(f => f.startsWith(`${id}.`));
		if (match) {
			matches.push(path.join(dir, match));
			if (pinnedDir && dir === pinnedDir) break;
			continue;
		}
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) availableIds.add(m[1]);
		}
	}

	if (!anyDirExists) {
		throw new Error("No artifacts directory found");
	}

	if (matches.length > 1) {
		throw new Error(
			`Artifact ${id} is ambiguous: ${matches.length} conversations in this process each have an artifact ${id}. ` +
				`Artifact ids are per-session counters, so the id alone cannot say which one you mean. ` +
				`Re-read it from the session that produced it, or use the artifact's file path directly. ` +
				`Candidates: ${matches.join(", ")}`,
		);
	}

	const foundPath = matches[0];
	if (!foundPath) {
		const sorted = Array.from(availableIds).sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
		throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
	}

	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`Artifact ${id} resolved to a directory, not a file`);
	}
	return { id, path: foundPath, size: stat.size };
}
