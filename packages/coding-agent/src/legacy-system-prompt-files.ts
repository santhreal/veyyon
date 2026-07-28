import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@veyyon/utils";
import { findRepoRoot } from "./capability/fs";
import { getConfigDirPaths } from "./config";

export type LegacyPromptFileKind = "append" | "system";

export interface LegacyPromptFile {
	kind: LegacyPromptFileKind;
	path: string;
}

export interface FindLegacyPromptFilesOptions {
	cwd?: string;
	home?: string;
	agentDir?: string;
	repoRoot?: string | null;
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ancestorDirs(start: string, stopAt?: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(start);
	const boundary = stopAt ? path.resolve(stopAt) : path.parse(current).root;

	while (true) {
		dirs.push(current);
		if (current === boundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Find removed prompt files at every location where Veyyon previously discovered them.
 * The files are never read, renamed, or deleted. This scan exists only to make the
 * behavior change visible to the operator.
 */
export async function findLegacyPromptFiles(options: FindLegacyPromptFilesOptions = {}): Promise<LegacyPromptFile[]> {
	const cwd = path.resolve(options.cwd ?? getProjectDir());
	const home = path.resolve(options.home ?? os.homedir());
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	const repoRoot = options.repoRoot === undefined ? await findRepoRoot(cwd) : options.repoRoot;
	const systemPaths = new Set<string>();
	const appendPaths = new Set<string>();

	for (const configDir of getConfigDirPaths("", { cwd, home })) {
		systemPaths.add(path.join(configDir, "SYSTEM.md"));
		appendPaths.add(path.join(configDir, "APPEND_SYSTEM.md"));
	}

	// The native capability used the active agent dir directly, including SDK callers
	// that override it, and walked ancestor .veyyon directories to the repository root.
	systemPaths.add(path.join(agentDir, "SYSTEM.md"));
	for (const ancestor of ancestorDirs(cwd, repoRoot ?? undefined)) {
		systemPaths.add(path.join(ancestor, ".veyyon", "SYSTEM.md"));
	}

	// The Agents standard provider searched ~/.agent[s] and walked project ancestors.
	const agentsBoundary = repoRoot ?? (isWithin(home, cwd) ? home : undefined);
	for (const base of [".agent", ".agents"] as const) {
		systemPaths.add(path.join(home, base, "SYSTEM.md"));
		for (const ancestor of ancestorDirs(cwd, agentsBoundary ?? undefined)) {
			if (ancestor !== home) systemPaths.add(path.join(ancestor, base, "SYSTEM.md"));
		}
	}

	// Gemini used lowercase system.md in addition to the generic uppercase config lookup.
	systemPaths.add(path.join(home, ".gemini", "system.md"));
	systemPaths.add(path.join(cwd, ".gemini", "system.md"));

	const candidates: LegacyPromptFile[] = [
		...Array.from(systemPaths, filePath => ({ kind: "system" as const, path: filePath })),
		...Array.from(appendPaths, filePath => ({ kind: "append" as const, path: filePath })),
	];
	const present = await Promise.all(
		candidates.map(async candidate => ((await isFile(candidate.path)) ? candidate : null)),
	);
	return present
		.filter((candidate): candidate is LegacyPromptFile => candidate !== null)
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Operator-facing migration instruction for a removed prompt file. */
export function describeLegacyPromptFile(file: LegacyPromptFile): string {
	if (file.kind === "append") {
		return `${file.path} is no longer read. Move appended instructions to AGENTS.md.`;
	}
	return `${file.path} is no longer read. Use PROMPT_SECTIONS/ to replace an assembled prompt section.`;
}
