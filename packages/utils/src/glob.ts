import * as path from "node:path";
import { Glob } from "bun";
import { getProjectDir } from "./dirs";
import { scopedTimeoutSignal } from "./scoped-timeout";

export interface GlobPathsOptions {
	cwd?: string;
	exclude?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	dot?: boolean;
	onlyFiles?: boolean;
	gitignore?: boolean;
}

const ALWAYS_IGNORED = ["**/.git", "**/.git/**"];

const NODE_MODULES_IGNORED = ["**/node_modules", "**/node_modules/**"];

function anchorGitignorePattern(relativePattern: string, gitignoreDir: string, baseDir: string): string[] {
	const absolutePattern = path.join(gitignoreDir, relativePattern);
	const relativeToBase = path.relative(baseDir, absolutePattern);
	if (relativeToBase.startsWith("..")) return [];
	const anchored = relativeToBase.replace(/\\/g, "/");
	if (!anchored) return [];
	return [anchored, `${anchored}/**`];
}

export function parseGitignorePatterns(content: string, gitignoreDir: string, baseDir: string): string[] {
	const patterns: string[] = [];

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("!")) {
			continue;
		}

		let pattern = line;

		if (pattern.endsWith("/")) {
			pattern = pattern.slice(0, -1);
		}

		if (pattern.startsWith("/")) {
			patterns.push(...anchorGitignorePattern(pattern.slice(1), gitignoreDir, baseDir));
		} else if (pattern.includes("/")) {
			patterns.push(...anchorGitignorePattern(pattern, gitignoreDir, baseDir));
		} else {
			patterns.push(`**/${pattern}`, `**/${pattern}/**`);
		}
	}

	return patterns;
}

export async function loadGitignorePatterns(baseDir: string): Promise<string[]> {
	const patterns: string[] = [];
	const absoluteBase = path.resolve(baseDir);

	let current = absoluteBase;
	const maxDepth = 50; // Prevent infinite loops

	for (let i = 0; i < maxDepth; i++) {
		const gitignorePath = path.join(current, ".gitignore");

		try {
			const content = await Bun.file(gitignorePath).text();
			const filePatterns = parseGitignorePatterns(content, current, absoluteBase);
			for (let pi = 0; pi < filePatterns.length; pi++) patterns.push(filePatterns[pi]!);
		} catch {}

		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return patterns;
}

export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, exclude, signal, timeoutMs, dot, onlyFiles = true, gitignore } = options;

	const patternArray = Array.isArray(patterns) ? patterns : [patterns];
	const mentionsNodeModules = patternArray.some(p => p.includes("node_modules"));

	const baseExclude = mentionsNodeModules ? ALWAYS_IGNORED.slice() : ALWAYS_IGNORED.concat(NODE_MODULES_IGNORED);
	let effectiveExclude = exclude ? baseExclude.concat(exclude) : baseExclude;

	if (gitignore) {
		const gitignorePatterns = await loadGitignorePatterns(cwd ?? getProjectDir());
		effectiveExclude = effectiveExclude.concat(gitignorePatterns);
	}

	const base = cwd ?? getProjectDir();
	const allResults: string[] = [];
	const seen = new Set<string>();

	const excludeGlobs = effectiveExclude.map(pattern => new Glob(pattern));

	const scopedTimeout = timeoutMs ? scopedTimeoutSignal(timeoutMs, signal) : undefined;
	const combinedSignal = scopedTimeout?.signal ?? signal;

	try {
		for (const pattern of patternArray) {
			const glob = new Glob(pattern);
			const scanOptions = {
				cwd: base,
				dot,
				onlyFiles,
				throwErrorOnBrokenSymlink: false,
			};

			for await (const entry of glob.scan(scanOptions)) {
				if (combinedSignal?.aborted) {
					const reason = combinedSignal.reason;
					if (reason instanceof Error) throw reason;
					throw new DOMException("Aborted", "AbortError");
				}

				const normalized = entry.replace(/\\/g, "/");
				if (seen.has(normalized)) continue;
				let excluded = false;
				for (const excludeGlob of excludeGlobs) {
					if (excludeGlob.match(normalized)) {
						excluded = true;
						break;
					}
				}
				if (!excluded) {
					seen.add(normalized);
					allResults.push(normalized);
				}
			}
		}
	} finally {
		scopedTimeout?.cancel();
	}

	return allResults;
}
