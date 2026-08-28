import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleReachResolution } from "./module-reach";

const SOURCE_CONDITIONS = ["import", "types", "default", "bun", "node"] as const;

function exportTarget(value: unknown, depth = 0): string | undefined {
	if (typeof value === "string") return value.startsWith("./") ? value : undefined;
	if (value === null || typeof value !== "object" || depth > 4) return undefined;
	const conditions = value as Record<string, unknown>;
	for (const condition of SOURCE_CONDITIONS) {
		if (condition in conditions) {
			const resolved = exportTarget(conditions[condition], depth + 1);
			if (resolved !== undefined) return resolved;
		}
	}
	return undefined;
}

function packageDirs(repoRoot: string): string[] {
	const root = path.join(repoRoot, "packages");
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	return names
		.map(name => path.join(root, name))
		.filter(dir => fs.existsSync(path.join(dir, "package.json")))
		.sort();
}

export interface WorkspacePackage {
	readonly name: string;
	readonly dir: string;
	readonly exports: ReadonlyArray<readonly [string, string]>;
}

export function workspacePackages(repoRoot: string): WorkspacePackage[] {
	const found: WorkspacePackage[] = [];
	for (const dir of packageDirs(repoRoot)) {
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		const name = manifest.name;
		if (typeof name !== "string" || name.length === 0) continue;

		const declared = manifest.exports;
		const entries: Array<readonly [string, string]> = [];
		if (declared !== null && typeof declared === "object") {
			for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
				const target = exportTarget(value);
				if (target !== undefined) entries.push([key, target]);
			}
		} else if (typeof manifest.main === "string" && manifest.main.startsWith("./")) {
			entries.push([".", manifest.main]);
		}
		found.push({ name, dir, exports: entries });
	}
	return found;
}

export function workspaceModuleReachResolution(repoRoot: string): ModuleReachResolution {
	const packages: Array<readonly [string, string]> = [];
	const aliases: Array<readonly [string, string]> = [];
	const seenNames = new Set<string>();
	const seenPrefixes = new Set<string>();

	for (const pkg of workspacePackages(repoRoot)) {
		for (const [key, target] of pkg.exports) {
			if (key === ".") {
				if (seenNames.has(pkg.name)) continue;
				seenNames.add(pkg.name);
				packages.push([pkg.name, path.join(pkg.dir, target)]);
				continue;
			}
			if (!key.startsWith("./")) continue;

			const star = key.indexOf("*");
			if (star === -1) {
				const specifier = pkg.name + key.slice(1);
				if (seenNames.has(specifier)) continue;
				seenNames.add(specifier);
				packages.push([specifier, path.join(pkg.dir, target)]);
				continue;
			}

			if (star !== key.length - 1) continue;
			const targetStar = target.indexOf("*");
			if (targetStar === -1) continue;
			const prefix = pkg.name + key.slice(1, star);
			if (seenPrefixes.has(prefix)) continue;
			seenPrefixes.add(prefix);
			aliases.push([prefix, path.join(pkg.dir, target.slice(0, targetStar))]);
		}
	}

	return { packages, aliases };
}
