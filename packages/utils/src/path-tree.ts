import { hasUrlScheme } from "./url";

export function isUrlLikePath(filePath: string): boolean {
	return hasUrlScheme(filePath);
}

export interface PathTreeNode {
	files: Array<{ name: string; key: string }>;
	fileNames: Set<string>;
	subdirs: Array<{ name: string; node: PathTreeNode }>;
	dirIndex: Map<string, PathTreeNode>;
}

export interface PathTreeInput {
	path: string;
	isDir: boolean;
	key?: string;
}

export interface GroupedTreeEvent {
	kind: "dir" | "file";
	depth: number;
	name: string;
	key: string;
}

function createNode(): PathTreeNode {
	return { files: [], fileNames: new Set(), subdirs: [], dirIndex: new Map() };
}

function addFile(node: PathTreeNode, name: string, key: string): void {
	if (node.fileNames.has(name)) return;
	node.fileNames.add(name);
	node.files.push({ name, key });
}

export function buildPathTree(entries: Iterable<PathTreeInput>): PathTreeNode {
	const root = createNode();
	for (const { path: rawPath, isDir, key } of entries) {
		const normalized = rawPath.replace(/\\/g, "/");
		const fileKey = key ?? rawPath;
		if (isUrlLikePath(normalized)) {
			addFile(root, normalized, fileKey);
			continue;
		}
		const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
		if (trimmed.length === 0) continue;
		const segments = trimmed.split("/");
		const dirCount = isDir ? segments.length : segments.length - 1;
		let node = root;
		for (let i = 0; i < dirCount; i++) {
			const segment = segments[i]!;
			let child = node.dirIndex.get(segment);
			if (!child) {
				child = createNode();
				node.dirIndex.set(segment, child);
				node.subdirs.push({ name: segment, node: child });
			}
			node = child;
		}
		if (!isDir) {
			addFile(node, segments[segments.length - 1]!, fileKey);
		}
	}
	return root;
}

export function* walkPathTree(node: PathTreeNode, depth = 0): Generator<GroupedTreeEvent> {
	for (const file of node.files) {
		yield { kind: "file", depth, name: file.name, key: file.key };
	}
	for (const subdir of node.subdirs) {
		let dirNode = subdir.node;
		const parts = [subdir.name];
		while (dirNode.files.length === 0 && dirNode.subdirs.length === 1) {
			const only = dirNode.subdirs[0]!;
			parts.push(only.name);
			dirNode = only.node;
		}
		yield { kind: "dir", depth, name: parts.join("/"), key: "" };
		yield* walkPathTree(dirNode, depth + 1);
	}
}

export function formatGroupedPaths(paths: readonly string[], annotate?: (path: string) => string): string {
	if (paths.length === 0) return "";
	const tree = buildPathTree(paths.map(entry => ({ path: entry, isDir: entry.endsWith("/") })));
	const lines: string[] = [];
	for (const event of walkPathTree(tree)) {
		if (event.kind === "dir") {
			lines.push(`${"#".repeat(event.depth + 1)} ${event.name}/`);
		} else {
			lines.push(annotate ? `${event.name}${annotate(event.key)}` : event.name);
		}
	}
	return lines.join("\n");
}
