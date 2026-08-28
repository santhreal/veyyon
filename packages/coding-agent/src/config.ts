import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	errorMessage,
	getConfigAgentDirName,
	getProjectDir,
	isMissingPath,
	logger,
} from "@veyyon/utils";
import { expandTilde } from "./tools/path-utils";

export * from "./config/config-file";

const priorityList = [
	{ dir: CONFIG_DIR_NAME, globalAgentDir: getConfigAgentDirName },
	{ dir: ".claude" },
	{ dir: ".codex" },
	{ dir: ".gemini" },
];

/** Walk up from `startDir` looking for a `package.json`. Returns the directory containing the marker, or `undefined` when the walk hits the filesystem root */
export function walkUpForPackageDir(startDir: string): string | undefined {
	let dir = startDir;
	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

/** Get the base directory for resolving optional package assets (docs, examples, CHANGELOG.md). Honors `VEYYON_PACKAGE_DIR` (useful for Nix/Guix store paths); otherwise walks */
export function getPackageDir(): string | undefined {
	const envDir = process.env.VEYYON_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}
	return walkUpForPackageDir(import.meta.dir);
}

/** Path to veyyon's own `CHANGELOG.md`, or `undefined` when the package directory cannot be resolved (e.g. inside `bun --compile` binaries that don't bundle */
export function getChangelogPath(): string | undefined {
	const packageDir = getPackageDir();
	return packageDir ? path.resolve(packageDir, "CHANGELOG.md") : undefined;
}

/** Config directory bases in priority order (highest first). User-level: the active profile's agent dir, `~/.veyyon/profiles/<name>/agent` (resolved via getConfigAgentDirName), ~/.claude, ~/.codex, ~/.gemini */
const USER_CONFIG_BASES = priorityList.map(({ dir, globalAgentDir }) => ({
	base: (home: string) => path.join(home, globalAgentDir ? globalAgentDir() : dir),
	name: dir,
}));

const PROJECT_CONFIG_BASES = priorityList.map(({ dir }) => ({
	base: dir,
	name: dir,
}));

export interface ConfigDirEntry {
	path: string;
	source: string; // e.g., ".veyyon", ".claude"
	level: "user" | "project";
}

export interface GetConfigDirsOptions {
	/** Include user-level directories (`~/.veyyon/profiles/<name>/agent/...`). Default: true */
	user?: boolean;
	/** Include project-level directories (.veyyon/...). Default: true */
	project?: boolean;
	/** Current working directory for project paths. Default: getProjectDir() */
	cwd?: string;
	/** Home directory for user paths. Default: os.homedir() */
	home?: string;
	/** Only return directories that exist. Default: false */
	existingOnly?: boolean;
}

/** Get all config directories for a subpath, ordered by priority (highest first). @param subpath - Subpath within config dirs (e.g., "commands", "hooks", "agents") @param options - Options for filtering @returns Array of directory entries, highest priority first // Get all command directories */
export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), home = os.homedir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	// User-level directories (highest priority)
	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const resolvedPath = path.resolve(base(home), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

	// Project-level directories
	if (project) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			const resolvedPath = path.resolve(cwd, base, subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "project" });
			}
		}
	}

	return results;
}

/** Get all config directory paths for a subpath (convenience wrapper). Returns just the paths, highest priority first. */
export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map(e => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

/** Find the first existing config file (for non-JSON files such as TITLE_SYSTEM.md). Returns just the path, or undefined if not found. */
export function findConfigFile(subpath: string, options: GetConfigDirsOptions = {}): string | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return filePath;
		}
	}

	return undefined;
}

/**
 * Find the first existing config file with metadata.
 */
export function findConfigFileWithMeta(
	subpath: string,
	options: GetConfigDirsOptions = {},
): Omit<ConfigFileResult<never>, "content"> | undefined {
	const dirs = getConfigDirs("", { ...options, existingOnly: false });

	for (const { path: base, source, level } of dirs) {
		const filePath = path.join(base, subpath);
		if (fs.existsSync(filePath)) {
			return { path: filePath, source, level };
		}
	}

	return undefined;
}

/** Find all nearest config directories by walking up from cwd. Returns one entry per config base (.veyyon, .claude) - the nearest one found. */
export function findAllNearestProjectConfigDirs(subpath: string, cwd: string = getProjectDir()): ConfigDirEntry[] {
	const results: ConfigDirEntry[] = [];
	const foundBases = new Set<string>();

	let currentDir = cwd;

	while (foundBases.size < PROJECT_CONFIG_BASES.length) {
		for (const { base, name } of PROJECT_CONFIG_BASES) {
			if (foundBases.has(name)) continue;

			const candidate = path.join(currentDir, base, subpath);
			try {
				if (fs.statSync(candidate).isDirectory()) {
					results.push({ path: candidate, source: name, level: "project" });
					foundBases.add(name);
				}
			} catch (error) {
				// The walk probes one candidate per config base per ancestor directory, so absence is the overwhelmingly common answer and stays silent. A candidate that
				if (!isMissingPath(error)) {
					logger.warn("Config directory could not be read while walking up; skipped it", {
						path: candidate,
						error: errorMessage(error),
					});
				}
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Sort by priority order
	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
