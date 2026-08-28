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

export function getPackageDir(): string | undefined {
	const envDir = process.env.VEYYON_PACKAGE_DIR;
	if (envDir) {
		return expandTilde(envDir);
	}
	return walkUpForPackageDir(import.meta.dir);
}

export function getChangelogPath(): string | undefined {
	const packageDir = getPackageDir();
	return packageDir ? path.resolve(packageDir, "CHANGELOG.md") : undefined;
}

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
	user?: boolean;
	project?: boolean;
	cwd?: string;
	home?: string;
	existingOnly?: boolean;
}

export function getConfigDirs(subpath: string, options: GetConfigDirsOptions = {}): ConfigDirEntry[] {
	const { user = true, project = true, cwd = getProjectDir(), home = os.homedir(), existingOnly = false } = options;
	const results: ConfigDirEntry[] = [];

	if (user) {
		for (const { base, name } of USER_CONFIG_BASES) {
			const resolvedPath = path.resolve(base(home), subpath);
			if (!existingOnly || fs.existsSync(resolvedPath)) {
				results.push({ path: resolvedPath, source: name, level: "user" });
			}
		}
	}

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

export function getConfigDirPaths(subpath: string, options: GetConfigDirsOptions = {}): string[] {
	return getConfigDirs(subpath, options).map(e => e.path);
}

export interface ConfigFileResult<T> {
	path: string;
	source: string;
	level: "user" | "project";
	content: T;
}

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

	const order = PROJECT_CONFIG_BASES.map(b => b.name);
	results.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));

	return results;
}
