import * as path from "node:path";
import { FileType, type GlobMatch, listWorkspace } from "@veyyon/natives";
import { formatAge, formatBytes } from "@veyyon/utils/format";

const WORKSPACE_DEFAULTS = {
	maxDepth: 3,
	perDirLimit: 12,
	lineCap: 120,
} as const;

export const AGENTS_MD_LIMIT = 200;

export interface DirectoryTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

export interface WorkspaceTree extends DirectoryTree {
	agentsMdFiles: string[];
}

export interface BuildDirectoryTreeOptions {
	maxDepth?: number;
	perDirLimit?: number | null;
	rootLimit?: number | null;
	lineCap?: number | null;
}

export interface BuildWorkspaceTreeOptions {
	timeoutMs?: number;
}

export async function buildDirectoryTree(cwd: string, options: BuildDirectoryTreeOptions = {}): Promise<DirectoryTree> {
	const rootPath = path.resolve(cwd);
	const maxDepth = options.maxDepth ?? 1;
	const perDirLimit = options.perDirLimit === undefined ? null : options.perDirLimit;
	const rootLimit = options.rootLimit === undefined ? perDirLimit : options.rootLimit;

	const { entries, truncated: nativeTruncated } = await listWorkspace({
		path: rootPath,
		maxDepth,
		hidden: true,
		gitignore: false,
	});

	return assembleTree(rootPath, entries, {
		perDirLimit,
		rootLimit,
		lineCap: options.lineCap === undefined ? null : options.lineCap,
		nativeTruncated,
		ageMode: "relative",
	});
}

export interface TopLevelDirectoryListing extends DirectoryTree {
	omittedTopLevel: number;
}

export interface BuildTopLevelDirectoryListingOptions {
	entryLimit?: number | null;
}

export async function buildTopLevelDirectoryListing(
	cwd: string,
	options: BuildTopLevelDirectoryListingOptions = {},
): Promise<TopLevelDirectoryListing> {
	const rootPath = path.resolve(cwd);
	const entryLimit = options.entryLimit === undefined ? null : options.entryLimit;

	const { entries, truncated: nativeTruncated } = await listWorkspace({
		path: rootPath,
		maxDepth: 2,
		hidden: true,
		gitignore: false,
	});

	const childCounts = new Map<string, number>();
	const topLevel: Array<{ name: string; isDir: boolean; mtimeMs: number; size: number }> = [];
	for (const entry of entries) {
		const slash = entry.path.lastIndexOf("/");
		const parentPath = slash === -1 ? "" : entry.path.slice(0, slash);
		if (parentPath === "") {
			topLevel.push({
				name: entry.path,
				isDir: entry.fileType === FileType.Dir,
				mtimeMs: entry.mtime ?? 0,
				size: entry.size ?? 0,
			});
		} else if (!parentPath.includes("/")) {
			childCounts.set(parentPath, (childCounts.get(parentPath) ?? 0) + 1);
		}
	}
	topLevel.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

	const capped = entryLimit !== null && topLevel.length > entryLimit;
	const shown = capped && entryLimit !== null ? topLevel.slice(0, entryLimit) : topLevel;
	const omitted = topLevel.length - shown.length;

	const formatNodeAge = makeAgeFormatter("relative");
	const lines: RenderedLine[] = [{ label: ".", depth: 0, isRoot: true }];
	for (const node of shown) {
		const count = childCounts.get(node.name) ?? 0;
		const countText = node.isDir ? `  (${count} ${count === 1 ? "entry" : "entries"})` : "";
		lines.push({
			label: `  - ${node.name}${node.isDir ? "/" : ""}${countText}`,
			depth: 1,
			isRoot: false,
			size: node.isDir ? undefined : formatBytes(node.size),
			age: formatNodeAge(node.mtimeMs),
		});
	}

	return {
		rootPath,
		rendered: formatLines(lines),
		truncated: nativeTruncated || capped,
		totalLines: lines.length,
		omittedTopLevel: omitted,
	};
}

export async function buildWorkspaceTree(cwd: string, options: BuildWorkspaceTreeOptions = {}): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth: WORKSPACE_DEFAULTS.maxDepth,
			hidden: false,
			gitignore: true,
			collectAgentsMd: true,
			timeoutMs: options.timeoutMs,
		});
		const tree = assembleTree(rootPath, result.entries, {
			perDirLimit: WORKSPACE_DEFAULTS.perDirLimit,
			rootLimit: WORKSPACE_DEFAULTS.perDirLimit,
			lineCap: WORKSPACE_DEFAULTS.lineCap,
			nativeTruncated: result.truncated,
			ageMode: "absolute",
		});
		return { ...tree, agentsMdFiles: result.agentsMdFiles };
	} catch {
		return { ...emptyTree(rootPath), agentsMdFiles: [] };
	}
}

interface Node {
	name: string;
	isDir: boolean;
	mtimeMs: number;
	size: number;
	depth: number;
	children: Node[];
	droppedCount: number;
}

interface RenderedLine {
	label: string;
	depth: number;
	isRoot: boolean;
	size?: string;
	age?: string;
}

interface AssembleOptions {
	perDirLimit: number | null;
	rootLimit: number | null;
	lineCap: number | null;
	nativeTruncated: boolean;
	ageMode: "relative" | "absolute";
}

function assembleTree(rootPath: string, entries: readonly GlobMatch[], opts: AssembleOptions): DirectoryTree {
	const byParent = new Map<string, Node[]>();
	for (const entry of entries) {
		const slash = entry.path.lastIndexOf("/");
		const name = slash === -1 ? entry.path : entry.path.slice(slash + 1);
		const parentPath = slash === -1 ? "" : entry.path.slice(0, slash);
		const node: Node = {
			name,
			isDir: entry.fileType === FileType.Dir,
			mtimeMs: entry.mtime ?? 0,
			size: entry.size ?? 0,
			depth: parentPath ? parentPath.split("/").length + 1 : 1,
			children: [],
			droppedCount: 0,
		};
		const bucket = byParent.get(parentPath);
		if (bucket) bucket.push(node);
		else byParent.set(parentPath, [node]);
	}

	const root: Node = {
		name: ".",
		isDir: true,
		mtimeMs: 0,
		size: 0,
		depth: 0,
		children: [],
		droppedCount: 0,
	};

	let truncated = opts.nativeTruncated;
	const stack: Array<{ node: Node; relPath: string }> = [{ node: root, relPath: "" }];
	while (stack.length > 0) {
		const { node, relPath } = stack.pop()!;
		const all = (byParent.get(relPath) ?? []).slice().sort(byRecency);
		const limit = node.depth === 0 ? opts.rootLimit : opts.perDirLimit;
		if (limit !== null && all.length > limit) {
			node.children = limit <= 1 ? all.slice(0, Math.max(0, limit)) : [...all.slice(0, limit - 1), all.at(-1)!];
			node.droppedCount = all.length - limit;
			truncated = true;
		} else {
			node.children = all;
		}
		for (const child of node.children) {
			if (!child.isDir) continue;
			stack.push({ node: child, relPath: relPath ? `${relPath}/${child.name}` : child.name });
		}
	}

	const rawLines: RenderedLine[] = [];
	renderNode(root, makeAgeFormatter(opts.ageMode), rawLines);
	const { lines, elidedCount } = applyLineCap(rawLines, opts.lineCap);

	return {
		rootPath,
		rendered: formatLines(lines),
		truncated: truncated || elidedCount > 0,
		totalLines: lines.length,
	};
}

function byRecency(a: Node, b: Node): number {
	return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

function makeAgeFormatter(mode: "relative" | "absolute"): (mtimeMs: number) => string {
	if (mode === "absolute") return formatMtimeStable;
	const nowMs = Date.now();
	return (mtimeMs: number) => formatAge(Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)));
}

function formatMtimeStable(mtimeMs: number): string {
	if (!mtimeMs) return "";
	return new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " ");
}

function renderNode(node: Node, formatNodeAge: (mtimeMs: number) => string, out: RenderedLine[]): void {
	if (node.depth === 0) {
		out.push({ label: node.name, depth: 0, isRoot: true });
	} else {
		const indent = "  ".repeat(node.depth);
		const suffix = node.isDir ? "/" : "";
		out.push({
			label: `${indent}- ${node.name}${suffix}`,
			depth: node.depth,
			isRoot: false,
			size: node.isDir ? undefined : formatBytes(node.size),
			age: formatNodeAge(node.mtimeMs),
		});
	}

	if (node.droppedCount === 0) {
		for (const child of node.children) renderNode(child, formatNodeAge, out);
		return;
	}

	const recent = node.children.slice(0, -1);
	const oldest = node.children.at(-1);
	for (const child of recent) renderNode(child, formatNodeAge, out);
	const childDepth = node.depth + 1;
	out.push({
		label: `${"  ".repeat(childDepth)}- … ${node.droppedCount} more`,
		depth: childDepth,
		isRoot: false,
	});
	if (oldest) renderNode(oldest, formatNodeAge, out);
}

function applyLineCap(
	lines: readonly RenderedLine[],
	lineCap: number | null,
): { lines: RenderedLine[]; elidedCount: number } {
	if (lineCap === null || lines.length <= lineCap) return { lines: lines.slice(), elidedCount: 0 };

	const PROTECTED_DEPTH = 1;
	const target = Math.max(1, lineCap - 1);
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => !line.isRoot && line.depth > PROTECTED_DEPTH)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, lines.length - target);
	if (removable.length === 0) return { lines: lines.slice(), elidedCount: 0 };

	const removed = new Set(removable.map(item => item.index));
	const kept = lines.filter((_, index) => !removed.has(index));
	kept.push({
		label: `[…${removable.length}ln elided…]`,
		depth: 0,
		isRoot: false,
	});
	return { lines: kept, elidedCount: removable.length };
}

function formatLines(lines: readonly RenderedLine[]): string {
	const maxLabelLength = lines.reduce((max, line) => Math.max(max, line.label.length), 0);
	return lines
		.map(line => {
			if (!line.age) return line.label;
			const sizeColumn = (line.size ?? "").padEnd(8);
			return `${line.label.padEnd(maxLabelLength + 2)}${sizeColumn}  ${line.age.padEnd(4)}`.trimEnd();
		})
		.join("\n");
}

function emptyTree(rootPath: string): DirectoryTree {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
	};
}
