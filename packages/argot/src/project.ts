import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROJECT_MARKERS: readonly string[] = [".git", ".argot"];

export interface ResolveProjectOptions {
	markers?: readonly string[];
	exists?: (path: string) => boolean;
}

export function resolveProjectRoot(startDir: string, options: ResolveProjectOptions = {}): string | undefined {
	const markers = options.markers ?? PROJECT_MARKERS;
	const exists = options.exists ?? existsSync;

	let dir = resolve(startDir);
	while (true) {
		for (const marker of markers) {
			if (exists(join(dir, marker))) {
				return dir;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

export function projectCacheId(rootPath: string): string {
	const normalized = resolve(rootPath);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
