import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function listFiles(rootDir: string, subPath = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = path.join(subPath, entry.name);
		if (entry.isDirectory()) {
			const sf = await listFiles(rootDir, relativePath);
			for (let fi = 0; fi < sf.length; fi++) files.push(sf[fi]!);
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}

	return files.sort();
}
