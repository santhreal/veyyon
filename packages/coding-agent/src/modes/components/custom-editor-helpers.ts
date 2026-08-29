import { fileURLToPath } from "node:url";
import { addKeyAliases, type KeyId } from "@veyyon/tui";
import { PASTE_END, PASTE_START } from "@veyyon/tui/bracketed-paste";
import { hasUriScheme } from "@veyyon/utils";
import { KEYBINDINGS } from "../../config/keybinding-defs";
import type { AppKeybinding } from "../../config/keybindings";

export const CONFIGURABLE_EDITOR_ACTIONS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.display.reset",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.model.selectTemporary",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.history.search",
	"app.message.dequeue",
	"app.retry",
	"app.clipboard.pasteImage",
	"app.clipboard.pasteTextRaw",
	"app.clipboard.copyPrompt",
	"app.bash.background",
] as const satisfies readonly AppKeybinding[];

export type ConfigurableEditorAction = (typeof CONFIGURABLE_EDITOR_ACTIONS)[number];

export const DEFAULT_ACTION_KEYS = Object.fromEntries(
	CONFIGURABLE_EDITOR_ACTIONS.map(action => [action, [...[KEYBINDINGS[action].defaultKeys].flat()] as KeyId[]]),
) as Record<ConfigurableEditorAction, KeyId[]>;

export function buildMatchKeys(keys: readonly KeyId[]): Set<string> {
	const matchKeys = new Set<string>();
	for (const key of keys) {
		addKeyAliases(matchKeys, key);
	}
	return matchKeys;
}

export const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
export const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;
export const FILE_URI_REGEX = /^file:\/\//i;
export const WINDOWS_DRIVE_PATH_REGEX = /^[a-z]:[\\/]/i;
export const ABSOLUTE_PATH_PREFIX_REGEX = /^(?:\/|~\/|file:\/\/|\\\\|[A-Za-z]:[\\/])/;

export const SPACE_REPEAT_MAX_GAP_MS = 120;
export const SPACE_REPEAT_JITTER_MS = 18;
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
export const SPACE_HOLD_MECHANICAL_RUN = 2;
export const SPACE_HOLD_RELEASE_MS = 250;

export function gapsAreMechanical(gap: number, prevGap: number): boolean {
	if (gap > SPACE_REPEAT_MAX_GAP_MS || prevGap > SPACE_REPEAT_MAX_GAP_MS) return false;
	const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
	return Math.abs(gap - prevGap) <= tolerance;
}

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function normalizePastedPath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
	if (FILE_URI_REGEX.test(unquoted)) {
		try {
			return fileURLToPath(unquoted);
		} catch {}
	}
	return unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1");
}

function isExplicitPastedPath(path: string): boolean {
	if (WINDOWS_DRIVE_PATH_REGEX.test(path) || FILE_URI_REGEX.test(path)) return true;
	if (hasUriScheme(path)) return false;
	return path.includes("/") || path.includes("\\");
}

function isImagePath(path: string): boolean {
	return BRACKETED_IMAGE_PATH_REGEX.test(path);
}

function splitPastedPathSegments(payload: string): string[] | undefined {
	const segments: string[] = [];
	let segment = "";
	let quote: string | undefined;
	let escaped = false;

	for (let i = 0; i < payload.length; i++) {
		const char = payload[i];
		if (escaped) {
			segment += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			segment += char;
			quote = char;
			continue;
		}
		if (isPastedPathSeparator(char)) {
			if (segment) {
				segments.push(segment);
				segment = "";
			}
			continue;
		}
		segment += char;
	}

	if (escaped || quote) return undefined;
	if (segment) segments.push(segment);
	return segments.length > 0 ? segments : undefined;
}

function extractExplicitPathSegments(payload: string): string[] | undefined {
	const pasted = payload.trim();
	if (!pasted) return undefined;

	const segments = splitPastedPathSegments(pasted);
	if (!segments) return undefined;

	const paths: string[] = [];
	for (const segment of segments) {
		const path = normalizePastedPath(segment);
		if (!path || !isExplicitPastedPath(path)) return undefined;
		paths.push(path);
	}
	return paths;
}

export function extractPastePathsFromText(text: string): string[] | undefined {
	return extractExplicitPathSegments(text);
}

export function extractBracketedPastePaths(data: string): string[] | undefined {
	if (!data.startsWith(PASTE_START)) return undefined;
	const endIndex = data.indexOf(PASTE_END, PASTE_START.length);
	if (endIndex === -1 || endIndex + PASTE_END.length !== data.length) return undefined;
	return extractExplicitPathSegments(data.slice(PASTE_START.length, endIndex));
}

export function extractBracketedImagePastePaths(data: string): string[] | undefined {
	const paths = extractBracketedPastePaths(data);
	return paths?.every(isImagePath) ? paths : undefined;
}

export function extractImagePastePathsFromText(text: string): string[] | undefined {
	const paths = extractPastePathsFromText(text);
	return paths?.every(isImagePath) ? paths : undefined;
}

export function extractImagePathFromText(text: string): string | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths?.length === 1 && isImagePath(paths[0])) return paths[0];
	if (paths !== undefined) return undefined;
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed) || !ABSOLUTE_PATH_PREFIX_REGEX.test(trimmed)) return undefined;
	const wholePath = normalizePastedPath(trimmed);
	if (wholePath && isExplicitPastedPath(wholePath) && isImagePath(wholePath)) {
		return wholePath;
	}
	return undefined;
}
