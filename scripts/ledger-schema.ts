/**
 * JSON shape validation and module resolution shared by the repository gates.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function assertObject(raw: unknown, message: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(message);
	return raw as Record<string, unknown>;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string") && new Set(value).size === value.length;
}

export function resolveModuleSpecifierOnDisk(
	fromFile: string,
	specifier: string,
	memberDirResolver?: (pkgName: string) => string | undefined,
): string | null {
	let base = dirname(fromFile);
	let body = specifier;
	if (!specifier.startsWith(".")) {
		if (!memberDirResolver) return null;
		const scoped = specifier.startsWith("@");
		const parts = specifier.split("/");
		const packageName = scoped ? parts.slice(0, 2).join("/") : parts[0];
		const rest = parts.slice(scoped ? 2 : 1).join("/");
		const memberDir = packageName === undefined ? undefined : memberDirResolver(packageName);
		if (memberDir === undefined) return null;
		base = existsSync(join(memberDir, "src")) ? join(memberDir, "src") : memberDir;
		body = (rest === "" ? "index" : rest).replace(/\.js$/, "");
	}
	const clean = body.replace(/\.js$/, "");
	const candidates = [
		resolve(base, body),
		resolve(base, clean),
		resolve(base, `${clean}.ts`),
		resolve(base, `${clean}.tsx`),
		resolve(base, `${clean}.d.ts`),
		resolve(base, `${clean}.js`),
		resolve(base, clean, "index.ts"),
		resolve(base, clean, "index.tsx"),
		resolve(base, clean, "index.d.ts"),
		resolve(base, clean, "index.js"),
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

export function sortRecordArrays<T extends Record<string, readonly string[]>>(record: T): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(record)
			.map(([k, v]) => [k, [...v].sort()] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}
