import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, fuzzyFind, type GlobMatch, glob, listWorkspace } from "@veyyon/natives";
import { openPath } from "../../utils/open";
import type { FileKind, FileNode } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

export const FILE_TREE_MAX_DEPTH = 16;
export const FILE_TREE_MAX_ENTRIES = 5000;
export const READ_FILE_MAX_BYTES = 512 * 1024;
export const BINARY_DETECTION_BUFFER_BYTES = 8 * 1024;
export const SEARCH_FILES_MAX_RESULTS = 100;

export function isWithinWorkspace(cwd: string, targetPath: string): boolean {
	const rel = path.relative(cwd, targetPath);
	if (rel === "" || rel === ".") return true;
	if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
	return true;
}

function toFileKind(type: FileType): FileKind {
	switch (type) {
		case FileType.Dir:
			return "Directory";
		case FileType.Symlink:
			return "Symlink";
		default:
			return "File";
	}
}

interface TreeNode {
	name: string;
	workspacePath: string;
	kind: FileKind;
	children: Map<string, TreeNode>;
}

function buildTree(entries: GlobMatch[], targetDir: string, cwd: string): Map<string, TreeNode> {
	const rootChildren = new Map<string, TreeNode>();
	const prefix = path.relative(cwd, targetDir).replaceAll("\\", "/");

	for (const entry of entries) {
		const segments = entry.path.split("/").filter(Boolean);
		if (segments.length === 0) continue;

		let currentMap = rootChildren;
		let currentRelPath = "";

		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			currentRelPath = currentRelPath ? `${currentRelPath}/${segment}` : segment;
			const isLast = i === segments.length - 1;
			const wsPath = prefix ? `${prefix}/${currentRelPath}` : currentRelPath;

			let node = currentMap.get(segment);
			if (!node) {
				node = {
					name: segment,
					workspacePath: wsPath,
					kind: isLast ? toFileKind(entry.fileType) : "Directory",
					children: new Map(),
				};
				currentMap.set(segment, node);
			} else if (isLast) {
				node.kind = toFileKind(entry.fileType);
			}
			currentMap = node.children;
		}
	}
	return rootChildren;
}

function flattenTreeDfs(
	map: Map<string, TreeNode>,
	depth = 0,
	result: FileNode[] = [],
	limit = FILE_TREE_MAX_ENTRIES,
): { nodes: FileNode[]; truncated: boolean } {
	let truncated = false;
	const sortedKeys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));

	for (const key of sortedKeys) {
		if (result.length >= limit) return { nodes: result, truncated: true };
		const node = map.get(key)!;
		result.push({
			path: node.workspacePath,
			name: node.name,
			kind: node.kind,
			depth,
		});

		if (node.children.size > 0) {
			const childRes = flattenTreeDfs(node.children, depth + 1, result, limit);
			if (childRes.truncated) {
				truncated = true;
				return { nodes: result, truncated: true };
			}
		}
	}
	return { nodes: result, truncated };
}

interface LoadFileTreePayload {
	root?: string | null;
}

const handleLoadFileTree: ActionHandler<LoadFileTreePayload | undefined> = async (ctx, payload) => {
	const targetDir = payload?.root ? path.resolve(ctx.cwd, payload.root) : ctx.cwd;

	if (!isWithinWorkspace(ctx.cwd, targetDir)) {
		ctx.reply.failure({
			scope: "File",
			code: "OUTSIDE_WORKSPACE",
			message: `Path is outside workspace: ${payload?.root ?? targetDir}`,
			retryable: false,
		});
		return;
	}

	let stats: Stats;
	try {
		stats = await fs.stat(targetDir);
	} catch {
		ctx.reply.failure({
			scope: "File",
			code: "DIRECTORY_NOT_FOUND",
			message: `Directory not found: ${payload?.root ?? targetDir}`,
			retryable: false,
		});
		return;
	}

	if (!stats.isDirectory()) {
		ctx.reply.failure({
			scope: "File",
			code: "DIRECTORY_NOT_FOUND",
			message: `Path is not a directory: ${payload?.root ?? targetDir}`,
			retryable: false,
		});
		return;
	}

	try {
		const { entries, truncated: nativeTruncated } = await listWorkspace({
			path: targetDir,
			maxDepth: FILE_TREE_MAX_DEPTH,
			hidden: false,
			gitignore: true,
		});

		const treeMap = buildTree(entries, targetDir, ctx.cwd);
		const { nodes, truncated: dfsTruncated } = flattenTreeDfs(treeMap, 0, [], FILE_TREE_MAX_ENTRIES);

		ctx.reply.snapshot({
			FileTree: {
				root: targetDir,
				entries: nodes,
				truncated: nativeTruncated || dfsTruncated,
			},
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "File",
			code: "DIRECTORY_READ_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface ReadFilePayload {
	path?: string;
}

const handleReadFile: ActionHandler<ReadFilePayload | undefined> = async (ctx, payload) => {
	if (!payload?.path || typeof payload.path !== "string") {
		ctx.reply.failure({
			scope: "File",
			code: "INVALID_ARGUMENTS",
			message: "ReadFile requires a path parameter",
			retryable: false,
		});
		return;
	}

	const targetPath = path.resolve(ctx.cwd, payload.path);
	if (!isWithinWorkspace(ctx.cwd, targetPath)) {
		ctx.reply.failure({
			scope: "File",
			code: "OUTSIDE_WORKSPACE",
			message: `Path is outside workspace: ${payload.path}`,
			retryable: false,
		});
		return;
	}

	const relativePath = path.relative(ctx.cwd, targetPath).replaceAll("\\", "/");
	let stats: Stats;
	try {
		stats = await fs.stat(targetPath);
	} catch {
		ctx.reply.failure({
			scope: "File",
			code: "FILE_NOT_FOUND",
			message: `File not found: ${relativePath}`,
			retryable: false,
		});
		return;
	}

	if (stats.isDirectory()) {
		ctx.reply.failure({
			scope: "File",
			code: "FILE_NOT_FOUND",
			message: `Path is a directory, not a file: ${relativePath}`,
			retryable: false,
		});
		return;
	}

	try {
		const size_bytes = stats.size;
		const buffer = await fs.readFile(targetPath);
		const checkLength = Math.min(buffer.length, BINARY_DETECTION_BUFFER_BYTES);
		let isBinary = false;
		for (let i = 0; i < checkLength; i++) {
			if (buffer[i] === 0) {
				isBinary = true;
				break;
			}
		}

		if (isBinary) {
			ctx.reply.snapshot({
				FileContent: {
					path: relativePath,
					content: "",
					size_bytes,
					truncated: false,
					binary: true,
				},
			});
			ctx.reply.success();
			return;
		}

		const truncated = buffer.length > READ_FILE_MAX_BYTES;
		const contentBuffer = truncated ? buffer.subarray(0, READ_FILE_MAX_BYTES) : buffer;
		const content = contentBuffer.toString("utf8");

		ctx.reply.snapshot({
			FileContent: {
				path: relativePath,
				content,
				size_bytes,
				truncated,
				binary: false,
			},
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "File",
			code: "FILE_READ_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface SearchFilesPayload {
	query?: string;
}

const handleSearchFiles: ActionHandler<SearchFilesPayload | undefined> = async (ctx, payload) => {
	if (!payload?.query || typeof payload.query !== "string" || payload.query.trim().length === 0) {
		ctx.reply.failure({
			scope: "File",
			code: "INVALID_ARGUMENTS",
			message: "SearchFiles requires a non-empty query parameter",
			retryable: false,
		});
		return;
	}

	const query = payload.query.trim();
	try {
		let paths: string[] = [];
		let truncated = false;

		const isGlob = /[*?[\]{}]/.test(query);
		if (isGlob) {
			const globResult = await glob({
				pattern: query,
				path: ctx.cwd,
				recursive: true,
				hidden: false,
				gitignore: true,
				maxResults: SEARCH_FILES_MAX_RESULTS + 1,
			});
			truncated = globResult.matches.length > SEARCH_FILES_MAX_RESULTS;
			paths = globResult.matches.slice(0, SEARCH_FILES_MAX_RESULTS).map(m => m.path.replaceAll("\\", "/"));
		} else {
			const fuzzyResult = await fuzzyFind({
				query,
				path: ctx.cwd,
				hidden: false,
				gitignore: true,
				maxResults: SEARCH_FILES_MAX_RESULTS + 1,
			});
			truncated =
				fuzzyResult.matches.length > SEARCH_FILES_MAX_RESULTS ||
				fuzzyResult.totalMatches > SEARCH_FILES_MAX_RESULTS;
			paths = fuzzyResult.matches.slice(0, SEARCH_FILES_MAX_RESULTS).map(m => m.path.replaceAll("\\", "/"));
		}

		ctx.reply.snapshot({
			SearchResults: {
				query: payload.query,
				paths,
				truncated,
			},
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "File",
			code: "DIRECTORY_READ_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface OpenExternalPayload {
	path?: string;
}

const handleOpenExternal: ActionHandler<OpenExternalPayload | undefined> = async (ctx, payload) => {
	if (!payload?.path || typeof payload.path !== "string") {
		ctx.reply.failure({
			scope: "File",
			code: "INVALID_ARGUMENTS",
			message: "OpenExternal requires a path parameter",
			retryable: false,
		});
		return;
	}

	const targetPath = path.resolve(ctx.cwd, payload.path);
	if (!isWithinWorkspace(ctx.cwd, targetPath)) {
		ctx.reply.failure({
			scope: "File",
			code: "OUTSIDE_WORKSPACE",
			message: `Path is outside workspace: ${payload.path}`,
			retryable: false,
		});
		return;
	}

	try {
		await fs.stat(targetPath);
	} catch {
		ctx.reply.failure({
			scope: "File",
			code: "FILE_NOT_FOUND",
			message: `File not found: ${payload.path}`,
			retryable: false,
		});
		return;
	}

	try {
		openPath(targetPath);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "File",
			code: "OPEN_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const filesActionHandlers: ActionHandlersMap = {
	LoadFileTree: handleLoadFileTree as ActionHandler<never>,
	ReadFile: handleReadFile as ActionHandler<never>,
	SearchFiles: handleSearchFiles as ActionHandler<never>,
	OpenExternal: handleOpenExternal as ActionHandler<never>,
};
