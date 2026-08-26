import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Recursively list all files in a directory relative to the root directory.
 */
export async function listFiles(rootDir: string, subPath = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = path.join(subPath, entry.name);
		const absolutePath = path.join(rootDir, relativePath);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(rootDir, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		} else if (entry.isSymbolicLink()) {
			const stats = await fs.stat(absolutePath).catch(() => null);
			if (stats?.isFile()) {
				files.push(relativePath);
			}
		}
	}

	return files.sort();
}
