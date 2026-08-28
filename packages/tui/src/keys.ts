/** Keyboard input handling for legacy terminal sequences and Kitty keyboard protocol. */

import type { KeyEventType } from "@veyyon/natives";
import {
	matchesKey as matchesKeyNative,
	parseKey as parseKeyNative,
	parseKittySequence as parseKittySequenceNative,
} from "@veyyon/natives";

function isWindowsTerminalSession(): boolean {
	return (
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

/**
 * Raw 0x08 (BS) is ambiguous in legacy terminals.
 *
 * - Windows Terminal uses it for Ctrl+Backspace.
 * - Some legacy terminals and tmux setups send it for plain Backspace.
 *
 * Prefer explicit Kitty / CSI-u / modifyOtherKeys sequences whenever they are
 * available. Fall back to a Windows Terminal heuristic only for raw BS bytes.
 */
function matchesRawBackspace(data: string, expectedModifier: number): boolean {
	if (data === "\x7f") return expectedModifier === 0;
	if (data !== "\x08") return false;
	// On Windows Terminal, 0x08 = Ctrl+Backspace. On others, it's plain Backspace.
	return isWindowsTerminalSession() ? expectedModifier === 4 : expectedModifier === 0;
}

export { isWindowsTerminalSession, matchesRawBackspace };

let kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active: boolean): void {
	kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive(): boolean {
	return kittyProtocolActive;
}

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/** Typed helper for constructing key identifiers with autocomplete. */
export const Key = {
	escape: "escape",
	esc: "esc",
	enter: "enter",
	return: "return",
	tab: "tab",
	space: "space",
	backspace: "backspace",
	delete: "delete",
	insert: "insert",
	clear: "clear",
	home: "home",
	end: "end",
	pageUp: "pageUp",
	pageDown: "pageDown",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	f1: "f1",
	f2: "f2",
	f3: "f3",
	f4: "f4",
	f5: "f5",
	f6: "f6",
	f7: "f7",
	f8: "f8",
	f9: "f9",
	f10: "f10",
	f11: "f11",
	f12: "f12",
	backtick: "`",
	hyphen: "-",
	equals: "=",
	leftbracket: "[",
	rightbracket: "]",
	backslash: "\\",
	semicolon: ";",
	quote: "'",
	comma: ",",
	period: ".",
	slash: "/",
	exclamation: "!",
	at: "@",
	hash: "#",
	dollar: "$",
	percent: "%",
	caret: "^",
	ampersand: "&",
	asterisk: "*",
	leftparen: "(",
	rightparen: ")",
	underscore: "_",
	plus: "+",
	pipe: "|",
	tilde: "~",
	leftbrace: "{",
	rightbrace: "}",
	colon: ":",
	lessthan: "<",
	greaterthan: ">",
	question: "?",
	ctrl: <K extends BaseKey>(key: K) => `ctrl+${key}` as const,
	shift: <K extends BaseKey>(key: K) => `shift+${key}` as const,
	alt: <K extends BaseKey>(key: K) => `alt+${key}` as const,
	super: <K extends BaseKey>(key: K) => `super+${key}` as const,
	ctrlShift: <K extends BaseKey>(key: K) => `ctrl+shift+${key}` as const,
	shiftCtrl: <K extends BaseKey>(key: K) => `shift+ctrl+${key}` as const,
	ctrlAlt: <K extends BaseKey>(key: K) => `ctrl+alt+${key}` as const,
	altCtrl: <K extends BaseKey>(key: K) => `alt+ctrl+${key}` as const,
	shiftAlt: <K extends BaseKey>(key: K) => `shift+alt+${key}` as const,
	altShift: <K extends BaseKey>(key: K) => `alt+shift+${key}` as const,
	ctrlSuper: <K extends BaseKey>(key: K) => `ctrl+super+${key}` as const,
	superCtrl: <K extends BaseKey>(key: K) => `super+ctrl+${key}` as const,
	shiftSuper: <K extends BaseKey>(key: K) => `shift+super+${key}` as const,
	superShift: <K extends BaseKey>(key: K) => `super+shift+${key}` as const,
	altSuper: <K extends BaseKey>(key: K) => `alt+super+${key}` as const,
	superAlt: <K extends BaseKey>(key: K) => `super+alt+${key}` as const,
	ctrlShiftAlt: <K extends BaseKey>(key: K) => `ctrl+shift+alt+${key}` as const,
	ctrlShiftSuper: <K extends BaseKey>(key: K) => `ctrl+shift+super+${key}` as const,
} as const;

interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number; // Shifted version of the key (when shift is pressed)
	baseLayoutKey?: number; // Key in standard PC-101 layout (for non-Latin layouts)
	modifier: number;
	eventType?: KeyEventType;
}

// Regex for Kitty protocol event type detection
// Matches CSI sequences with :2 (repeat) or :3 (release) event type
// Format: \x1b[...;modifier:event_type<terminator> where terminator is u, ~, or A-F/H
const KITTY_RELEASE_PATTERN = /^\x1b\[[\d:;]*:3[u~ABCDHF]$/;
const KITTY_REPEAT_PATTERN = /^\x1b\[[\d:;]*:2[u~ABCDHF]$/;
const KITTY_CSI_U_PATTERN = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?(?:;([\d:]*))?u$/;
const KITTY_MOD_SHIFT = 1;
const KITTY_MOD_ALT = 2;
const KITTY_MOD_CTRL = 4;
const KITTY_MOD_SUPER = 8;
const KITTY_MOD_NUM_LOCK = 128;
const KITTY_LOCK_MASK = 64 + KITTY_MOD_NUM_LOCK; // Caps Lock + Num Lock
const MODIFY_OTHER_KEYS_PATTERN = /^\x1b\[27;(\d+);(\d+)~$/;
const KITTY_KEYPAD_OPERATOR_TEXT: Record<number, string> = {
	57410: "/",
	57411: "*",
	57412: "-",
	57413: "+",
	57415: "=",
};
const KITTY_NUMPAD_TEXT: Record<number, string> = {
	57399: "0",
	57400: "1",
	57401: "2",
	57402: "3",
	57403: "4",
	57404: "5",
	57405: "6",
	57406: "7",
	57407: "8",
	57408: "9",
	57409: ".",
};

/**
 * Check if the input is a key release event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRelease(data: string): boolean {
	// Only detect release events when Kitty protocol is active
	if (!kittyProtocolActive) {
		return false;
	}

	// Don't treat bracketed paste content as key release
	if (data.includes("\x1b[200~")) {
		return false;
	}

	// Match the full CSI sequence pattern for release events
	return KITTY_RELEASE_PATTERN.test(data);
}

/**
 * Check if the input is a key repeat event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRepeat(data: string): boolean {
	// Only detect repeat events when Kitty protocol is active
	if (!kittyProtocolActive) {
		return false;
	}

	// Don't treat bracketed paste content as key repeat
	if (data.includes("\x1b[200~")) {
		return false;
	}

	// Match the full CSI sequence pattern for repeat events
	return KITTY_REPEAT_PATTERN.test(data);
}

export function parseKittySequence(data: string): ParsedKittySequence | null {
	const result = parseKittySequenceNative(data);
	if (!result) return null;
	return {
		codepoint: result.codepoint,
		shiftedKey: result.shiftedKey ?? undefined,
		baseLayoutKey: result.baseLayoutKey ?? undefined,
		modifier: result.modifier,
		eventType: result.eventType,
	};
}

function hasControlChars(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
	}
	return false;
}

function decodeKittyPrintable(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_PATTERN);
	if (!match) return undefined;

	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(codepoint)) return undefined;

	if (match[5] === "3") return undefined;

	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
	const effectiveMod = modifier & ~KITTY_LOCK_MASK;
	const supportedModifierMask = KITTY_MOD_SHIFT | KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER;

	if (effectiveMod & ~supportedModifierMask) return undefined;
	if (effectiveMod & (KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER)) return undefined;

	const textField = match[6];
	if (textField && textField.length > 0) {
		const codepoints = textField
			.split(":")
			.filter(Boolean)
			.map(value => Number.parseInt(value, 10))
			.filter(value => Number.isFinite(value) && value >= 32 && value !== 127);
		if (codepoints.length > 0) {
			try {
				return String.fromCodePoint(...codepoints);
			} catch {
				// A codepoint outside Unicode's range is not text, so this key produces no text: undefined
				// means "not printable input", exactly as it does for the control keys filtered above, and the
				// key is then matched as a binding instead.
				return undefined;
			}
		}
	}
	const keypadOperatorText = KITTY_KEYPAD_OPERATOR_TEXT[codepoint];
	if (keypadOperatorText) return keypadOperatorText;

	if (effectiveMod === 0) {
		const numpadText = KITTY_NUMPAD_TEXT[codepoint];
		if (numpadText) return numpadText;
	}

	let effectiveCodepoint = codepoint;
	if (effectiveMod & KITTY_MOD_SHIFT && typeof shiftedKey === "number") {
		effectiveCodepoint = shiftedKey;
	}

	if (effectiveCodepoint >= 0xe000 && effectiveCodepoint <= 0xf8ff) {
		return undefined;
	}

	if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32 || effectiveCodepoint === 127) return undefined;

	try {
		return String.fromCodePoint(effectiveCodepoint);
	} catch {
		// Same as above: an out-of-range codepoint yields no text, and undefined is the "not printable"
		// answer the caller already handles for every non-text key.
		return undefined;
	}
}

/**
 * Extract printable text from raw terminal input.
 *
 * Handles Kitty CSI-u text-producing keys so text-entry components can treat
 * keypad digits, keypad operators, and shifted symbols the same as direct character input.
 */
export function extractPrintableText(data: string): string | undefined {
	const printable = decodePrintableKey(data);
	if (printable !== undefined) return printable;
	if (data.length === 0 || hasControlChars(data)) return undefined;
	return data;
}

interface ParsedModifyOtherKeysSequence {
	codepoint: number;
	modifier: number;
}

/**
 * Parse an xterm `modifyOtherKeys` format sequence: `CSI 27 ; modifiers ; keycode ~`.
 * Modifier values are 1-indexed in the wire format; we normalize to a 0-based bitmask.
 */
function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
	const match = data.match(MODIFY_OTHER_KEYS_PATTERN);
	if (!match) return null;
	const modValue = Number.parseInt(match[1] ?? "", 10);
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(modValue) || !Number.isFinite(codepoint)) return null;
	return { codepoint, modifier: modValue - 1 };
}

/**
 * Decode an xterm modifyOtherKeys sequence into the printable character it represents.
 *
 * Only sequences with no modifiers or Shift alone produce text; Ctrl/Alt/Super combos
 * are treated as bindings, not text input.
 */
function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return undefined;
	const modifier = parsed.modifier & ~KITTY_LOCK_MASK;
	if ((modifier & ~KITTY_MOD_SHIFT) !== 0) return undefined;
	if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32 || parsed.codepoint === 127) return undefined;
	try {
		return String.fromCodePoint(parsed.codepoint);
	} catch {
		// Same as the Kitty decoders: no text for an out-of-range codepoint, so the sequence is treated as a
		// binding rather than as input.
		return undefined;
	}
}

/**
 * Decode terminal input into the printable character it represents.
 *
 * Tries Kitty CSI-u first, then falls back to xterm modifyOtherKeys. Returns
 * undefined for control sequences and modifier-only events.
 */
export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}

/** Decode a Kitty CSI-u keypad sequence into the text it produces. */
function decodeKittyKeypadText(data: string): string | undefined {
	// Necessary condition for KITTY_CSI_U_PATTERN, which is anchored `^\x1b\[ ... u$`. This runs
	// ahead of the native parser on EVERY keypress, and the regex has six capture groups, so
	// without the guard a plain `a` pays for a full match that cannot succeed. Three charCodeAt
	// calls reject every printable character and every legacy sequence. This is not a second
	// answer to the same question: the pattern already requires exactly these three characters, so
	// anything the guard rejects the regex would have rejected too.
	if (data.charCodeAt(0) !== 0x1b || data.charCodeAt(1) !== 0x5b || data.charCodeAt(data.length - 1) !== 0x75) {
		return undefined;
	}
	const match = data.match(KITTY_CSI_U_PATTERN);
	if (!match) return undefined;
	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!(codepoint in KITTY_NUMPAD_TEXT) && !(codepoint in KITTY_KEYPAD_OPERATOR_TEXT)) return undefined;
	return decodeKittyPrintable(data);
}

function matchesKeypadKey(data: string, keyId: KeyId): boolean | undefined {
	const printable = decodeKittyKeypadText(data);
	if (printable === undefined) return undefined;
	return printable === keyId;
}

/** Whether input is a bare line feed (0x0A). */
export function isLoneLineFeed(data: string): boolean {
	return data === "\n";
}

/** Translate ambiguous bare line feed (0x0A) based on active protocol state. */
const KITTY_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";

function canonicalizeAmbiguousLineFeed(data: string): string | undefined {
	return kittyProtocolActive && data === "\n" ? KITTY_SHIFT_ENTER_SEQUENCE : undefined;
}

/** Memoization cache for key parsing results to avoid FFI overhead on hot paths. */
const MEMO_MAX_INPUT_LENGTH = 24;
/**
 * Entry ceiling per memo. The live working set is tiny (the keys someone actually presses), so this is
 * a runaway guard rather than a tuning knob, and it is enforced by clearing the whole map instead of
 * evicting one entry: there is no LRU bookkeeping to get wrong, and re-warming costs one native call
 * per key that comes back.
 */
const MEMO_MAX_ENTRIES = 4096;
const parseCache = new Map<string, string | undefined>();
const matchCache = new Map<string, boolean>();

/**
 * Drop every memoized answer.
 *
 * Exported for tests that need to observe the native parser directly (see `test/key-memo.test.ts`).
 * Production code never needs it: the protocol mode is part of every cache key, so
 * `setKittyProtocolActive` does not invalidate anything.
 */
export function clearKeyAnswerMemo(): void {
	parseCache.clear();
	matchCache.clear();
}

/** Match input data against a key identifier string. */
export function matchesKey(data: string, keyId: KeyId): boolean {
	if (data.length > MEMO_MAX_INPUT_LENGTH) {
		return (
			matchesKeypadKey(data, keyId) ??
			matchesKeyNative(canonicalizeAmbiguousLineFeed(data) ?? data, keyId, kittyProtocolActive)
		);
	}
	// NUL separator written as an escape, not a raw byte: key ids never contain NUL, while a space would
	// let `data: "a b"` with `keyId: "c"` and `data: "a"` with `keyId: "b c"` build one cache key.
	const cacheKey = `${kittyProtocolActive ? "1" : "0"}${data}\u0000${keyId}`;
	const cached = matchCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const answer =
		matchesKeypadKey(data, keyId) ??
		matchesKeyNative(canonicalizeAmbiguousLineFeed(data) ?? data, keyId, kittyProtocolActive);
	if (matchCache.size >= MEMO_MAX_ENTRIES) matchCache.clear();
	matchCache.set(cacheKey, answer);
	return answer;
}

/** Parse terminal input and return a normalized key identifier. */
export function parseKey(data: string): string | undefined {
	if (data.length > MEMO_MAX_INPUT_LENGTH) {
		return (
			decodeKittyKeypadText(data) ??
			parseKeyNative(canonicalizeAmbiguousLineFeed(data) ?? data, kittyProtocolActive) ??
			undefined
		);
	}
	const cacheKey = `${kittyProtocolActive ? "1" : "0"}${data}`;
	// `has` before `get`, because `undefined` -- "this input is not a key" -- is a real answer worth
	// caching, and a `get`-only check would re-cross FFI for every unrecognized input.
	if (parseCache.has(cacheKey)) return parseCache.get(cacheKey);
	const answer =
		decodeKittyKeypadText(data) ??
		parseKeyNative(canonicalizeAmbiguousLineFeed(data) ?? data, kittyProtocolActive) ??
		undefined;
	if (parseCache.size >= MEMO_MAX_ENTRIES) parseCache.clear();
	parseCache.set(cacheKey, answer);
	return answer;
}
