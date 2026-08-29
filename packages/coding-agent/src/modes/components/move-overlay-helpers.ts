import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModalShortcut } from "./modal-shell";

export interface MoveOverlayResult {
	directory: string;
}

export interface DirEntry {
	value: string;
	label: string;
}

export const MAX_RESULTS = 15;

export const MOVE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "tab complete" },
	{ label: "enter confirm", clickable: true, id: "confirm" },
	{ label: "esc cancel", clickable: true, id: "close" },
];

export const DIR_CACHE_TTL = 500;
export const dirCache = new Map<string, { time: number; entries: fs.Dirent[] }>();

export function readDirCached(dir: string): fs.Dirent[] {
	const now = Date.now();
	const cached = dirCache.get(dir);
	if (cached && now - cached.time < DIR_CACHE_TTL) return cached.entries;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		dirCache.set(dir, { time: now, entries });
		return entries;
	} catch {
		return [];
	}
}

function entryIsDirectory(dir: string, entry: fs.Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
		return false;
	}
	try {
		return fs.statSync(path.join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

export function printableInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	let result = "";
	for (let i = 0; i < withoutPasteEnvelope.length; i++) {
		const c = withoutPasteEnvelope.charCodeAt(i);
		if (c >= 32 && c !== 0x7f) result += withoutPasteEnvelope[i];
	}
	return result;
}

export function resolveMovePath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

export function resolveExistingDirectory(input: string, cwd: string): string | null {
	const resolved = resolveMovePath(input, cwd);
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

function listChildDirectories(dirPath: string, max: number, includeHidden = false): DirEntry[] {
	const results: DirEntry[] = [];
	const entries = readDirCached(dirPath);
	for (const entry of entries) {
		if (results.length >= max) break;
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (!entryIsDirectory(dirPath, entry)) continue;
		results.push({ value: path.join(dirPath, name), label: `${name}/` });
	}
	results.sort((a, b) => a.label.localeCompare(b.label));
	return results;
}

export function searchDirectories(prefix: string, cwd: string, max: number): DirEntry[] {
	if (!prefix) return listChildDirectories(cwd, max);

	const norm = prefix.replace(/\\/g, "/");
	const slashIdx = norm.lastIndexOf("/");
	let baseDir: string;
	let query: string;
	if (slashIdx === -1) {
		baseDir = cwd;
		query = prefix;
	} else {
		const base = norm.slice(0, slashIdx + 1);
		query = norm.slice(slashIdx + 1);
		baseDir = resolveMovePath(base, cwd);
	}

	const includeHidden = query.startsWith(".");

	const resolved = includeHidden ? null : resolveExistingDirectory(prefix, cwd);
	if (resolved) return listChildDirectories(resolved, max);

	const lower = query.toLowerCase();
	const results: DirEntry[] = [];
	const entries = readDirCached(baseDir);
	for (const entry of entries) {
		if (results.length >= max) break;
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (query && !name.toLowerCase().includes(lower)) continue;
		if (!entryIsDirectory(baseDir, entry)) continue;
		results.push({ value: path.join(baseDir, name), label: `${name}/` });
	}
	return results;
}
