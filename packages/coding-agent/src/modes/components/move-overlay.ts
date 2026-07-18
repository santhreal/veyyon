/**
 * `/move` overlay: a path input with live directory autocomplete.
 *
 * Rendered as a floating ModalShell card, hosted fullscreen so the transcript
 * stays visible around it. The user types a path, Tab autocompletes the
 * highlighted directory, and Enter confirms — yielding the resolved directory
 * string (or `undefined` on cancel).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Key,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
} from "@veyyon/tui";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	withCompact,
} from "./modal-shell";

export interface MoveOverlayResult {
	directory: string;
}

interface DirEntry {
	/** Full absolute path. */
	value: string;
	/** Display label (basename + trailing slash). */
	label: string;
}

const MAX_RESULTS = 15;

const MOVE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "tab complete" },
	{ label: "enter confirm", clickable: true, id: "confirm" },
	{ label: "esc cancel", clickable: true, id: "close" },
];

/** TTL for the directory listing cache (ms). */
const DIR_CACHE_TTL = 500;
const dirCache = new Map<string, { time: number; entries: fs.Dirent[] }>();

function readDirCached(dir: string): fs.Dirent[] {
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

/**
 * `Dirent.isDirectory()` reports the entry type, not the link target, so a
 * `statSync` fallback is still needed for symlinks that point at a directory.
 * Some filesystems (NFS, FUSE, older SMB) report `UV_DIRENT_UNKNOWN` — every
 * `isX()` returns false — so those entries also fall back to `statSync` rather
 * than being silently dropped from the results.
 */
function entryIsDirectory(dir: string, entry: fs.Dirent): boolean {
	if (entry.isDirectory()) return true;
	// Fast reject only for entry types we can confidently identify as non-directory.
	if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
		return false;
	}
	// Symlink (need target type) or unknown (filesystem didn't provide a type) — stat to find out.
	try {
		return fs.statSync(path.join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

function printableInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	return Array.from(withoutPasteEnvelope)
		.filter(ch => {
			const code = ch.codePointAt(0);
			return code !== undefined && code >= 32 && code !== 0x7f;
		})
		.join("");
}

/** Resolve a user-typed path (`~`, absolute, or relative to `cwd`) to an absolute path. */
export function resolveMovePath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

/** If `input` resolves to an existing directory, return it; otherwise `null`. */
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

function searchDirectories(prefix: string, cwd: string, max: number): DirEntry[] {
	if (!prefix) return listChildDirectories(cwd, max);

	// Split into base dir + query so dot-prefixed segments can reveal hidden directories.
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

	// If the prefix already resolves to an existing directory, list its children.
	// A dot-prefixed query is treated as a filter so hidden directories become reachable.
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

/**
 * Overlay component for `/move`: a single-line path input with a live-filtered
 * list of matching directories. Tab accepts the highlighted suggestion; Enter
 * confirms the current input (or the highlighted suggestion if the input is
 * empty); Escape cancels.
 */
export class MoveOverlay implements Component, Focusable {
	#focused = false;
	#input = "";
	#cursor = 0;
	#selectedIndex = 0;
	#results: DirEntry[] = [];
	#cwd: string;
	#done: (result: MoveOverlayResult | undefined) => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;

	constructor(cwd: string, done: (result: MoveOverlayResult | undefined) => void) {
		this.#cwd = cwd;
		this.#done = done;
		// Warm the cache for the current directory so the first keystroke is instant.
		readDirCached(cwd);
		this.#updateResults();
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.#confirm();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, Key.up)) {
			if (this.#results.length > 0) this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, Key.down)) {
			if (this.#results.length > 0)
				this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#input = selected.value;
				this.#cursor = this.#input.length;
				this.#selectedIndex = 0;
				this.#updateResults();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.#cursor = Math.max(0, this.#cursor - 1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.#cursor = Math.min(this.#input.length, this.#cursor + 1);
			return;
		}
		if (matchesKey(data, Key.backspace) && this.#cursor > 0) {
			this.#input = this.#input.slice(0, this.#cursor - 1) + this.#input.slice(this.#cursor);
			this.#cursor--;
			this.#selectedIndex = 0;
			this.#updateResults();
			return;
		}
		const text = printableInput(data);
		if (text.length > 0) {
			this.#input = this.#input.slice(0, this.#cursor) + text + this.#input.slice(this.#cursor);
			this.#cursor += text.length;
			this.#selectedIndex = 0;
			this.#updateResults();
		}
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = withCompact(MODAL_SIZING_MEDIUM, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const body: string[] = [this.#renderInput(), ""];
		if (this.#results.length === 0 && this.#input.length > 0) {
			body.push(theme.fg("dim", "No matching directories"));
		} else {
			for (let i = 0; i < Math.min(this.#results.length, MAX_RESULTS); i++) {
				const item = this.#results[i]!;
				const selected = i === this.#selectedIndex;
				const marker = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				body.push(`${marker}${label}`);
			}
		}

		const shell = renderModalShell({
			title: "Move",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts: MOVE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}

	invalidate(): void {}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#onRequestRender?.();
			}
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.#done(undefined);
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#confirm();
			return true;
		}
		return true;
	}

	#renderInput(): string {
		const prompt = theme.fg("dim", "Path: ");
		if (this.#input.length === 0) {
			const placeholder = theme.fg("dim", "Type a directory path…");
			const marker = this.#focused ? CURSOR_MARKER : "";
			return `${prompt}${placeholder}${marker}\x1b[7m \x1b[27m`;
		}
		const before = this.#input.slice(0, this.#cursor);
		const cursorChar = this.#cursor < this.#input.length ? this.#input[this.#cursor] : " ";
		const after = this.#input.slice(this.#cursor + 1);
		const marker = this.#focused ? CURSOR_MARKER : "";
		return `${prompt}${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
	}

	#updateResults(): void {
		this.#results = searchDirectories(this.#input, this.#cwd, MAX_RESULTS + 5);
		if (this.#selectedIndex >= this.#results.length) {
			this.#selectedIndex = Math.max(0, this.#results.length - 1);
		}
	}

	#confirm(): void {
		const selected = this.#results[this.#selectedIndex];
		if (selected) {
			this.#done({ directory: selected.value });
			return;
		}
		if (this.#input.trim().length > 0) {
			this.#done({ directory: this.#input.trim() });
			return;
		}
		this.#done(undefined);
	}
}
