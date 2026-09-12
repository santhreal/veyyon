/**
 * Keyboard input handling for terminal applications (frozen baseline).
 */

let kittyProtocolActive = false;

export function setKittyProtocolActive(active: boolean): void {
	kittyProtocolActive = active;
}

export function isKittyProtocolActive(): boolean {
	return kittyProtocolActive;
}

export type KeyEventType = "press" | "repeat" | "release";
export type KeyId = string;

const MODIFIERS = { shift: 1, alt: 2, ctrl: 4 } as const;
const LOCK_MASK = 64 + 128;

const CODEPOINTS: Record<string, number> = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	kpEnter: 57414,
};

const FUNCTIONAL_CODEPOINTS: Record<string, number> = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
};

const ARROW_CODEPOINTS: Record<string, number> = { up: -1, down: -2, right: -3, left: -4 };

const CODEPOINT_TO_NAME: Record<number, string> = {
	27: "escape",
	9: "tab",
	13: "enter",
	57414: "enter",
	32: "space",
	127: "backspace",
	"-10": "delete",
	"-11": "insert",
	"-12": "pageUp",
	"-13": "pageDown",
	"-14": "home",
	"-15": "end",
	"-1": "up",
	"-2": "down",
	"-3": "right",
	"-4": "left",
};

const LEGACY_KEY_SEQUENCES: Record<string, readonly string[]> = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	insert: ["\x1b[2~"],
	delete: ["\x1b[3~"],
	pageUp: ["\x1b[5~", "\x1b[[5~"],
	pageDown: ["\x1b[6~", "\x1b[[6~"],
	clear: ["\x1b[E", "\x1bOE"],
	f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
	f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
	f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
	f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
	f5: ["\x1b[15~", "\x1b[[E"],
	f6: ["\x1b[17~"],
	f7: ["\x1b[18~"],
	f8: ["\x1b[19~"],
	f9: ["\x1b[20~"],
	f10: ["\x1b[21~"],
	f11: ["\x1b[23~"],
	f12: ["\x1b[24~"],
};

const LEGACY_SHIFT_SEQUENCES: Record<string, readonly string[]> = {
	up: ["\x1b[a"],
	down: ["\x1b[b"],
	right: ["\x1b[c"],
	left: ["\x1b[d"],
	clear: ["\x1b[e"],
	insert: ["\x1b[2$"],
	delete: ["\x1b[3$"],
	pageUp: ["\x1b[5$"],
	pageDown: ["\x1b[6$"],
	home: ["\x1b[7$"],
	end: ["\x1b[8$"],
};

const LEGACY_CTRL_SEQUENCES: Record<string, readonly string[]> = {
	up: ["\x1bOa"],
	down: ["\x1bOb"],
	right: ["\x1bOc"],
	left: ["\x1bOd"],
	clear: ["\x1bOe"],
	insert: ["\x1b[2^"],
	delete: ["\x1b[3^"],
	pageUp: ["\x1b[5^"],
	pageDown: ["\x1b[6^"],
	home: ["\x1b[7^"],
	end: ["\x1b[8^"],
};

const LEGACY_SEQUENCE_KEY_IDS: Record<string, string> = {
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1bOH": "home",
	"\x1bOF": "end",
	"\x1b[E": "clear",
	"\x1bOE": "clear",
	"\x1bOe": "ctrl+clear",
	"\x1b[e": "shift+clear",
	"\x1b[2~": "insert",
	"\x1b[2$": "shift+insert",
	"\x1b[2^": "ctrl+insert",
	"\x1b[3$": "shift+delete",
	"\x1b[3^": "ctrl+delete",
	"\x1b[[5~": "pageUp",
	"\x1b[[6~": "pageDown",
	"\x1b[a": "shift+up",
	"\x1b[b": "shift+down",
	"\x1b[c": "shift+right",
	"\x1b[d": "shift+left",
	"\x1bOa": "ctrl+up",
	"\x1bOb": "ctrl+down",
	"\x1bOc": "ctrl+right",
	"\x1bOd": "ctrl+left",
	"\x1b[5$": "shift+pageUp",
	"\x1b[6$": "shift+pageDown",
	"\x1b[7$": "shift+home",
	"\x1b[8$": "shift+end",
	"\x1b[5^": "ctrl+pageUp",
	"\x1b[6^": "ctrl+pageDown",
	"\x1b[7^": "ctrl+home",
	"\x1b[8^": "ctrl+end",
	"\x1bOP": "f1",
	"\x1bOQ": "f2",
	"\x1bOR": "f3",
	"\x1bOS": "f4",
	"\x1b[11~": "f1",
	"\x1b[12~": "f2",
	"\x1b[13~": "f3",
	"\x1b[14~": "f4",
	"\x1b[[A": "f1",
	"\x1b[[B": "f2",
	"\x1b[[C": "f3",
	"\x1b[[D": "f4",
	"\x1b[[E": "f5",
	"\x1b[15~": "f5",
	"\x1b[17~": "f6",
	"\x1b[18~": "f7",
	"\x1b[19~": "f8",
	"\x1b[20~": "f9",
	"\x1b[21~": "f10",
	"\x1b[23~": "f11",
	"\x1b[24~": "f12",
	"\x1bb": "alt+left",
	"\x1bf": "alt+right",
	"\x1bp": "alt+up",
	"\x1bn": "alt+down",
};

const CTRL_SYMBOL_MAP: Record<string, string> = {
	"@": "\x00",
	"[": "\x1b",
	"\\": "\x1c",
	"]": "\x1d",
	"^": "\x1e",
	_: "\x1f",
	"-": "\x1f",
};

const CTRL_SYMBOL_CODES: Record<number, string> = {
	28: "ctrl+\\",
	29: "ctrl+]",
	30: "ctrl+^",
	31: "ctrl+_",
};

const SYMBOL_KEYS: Record<string, true> = Object.fromEntries(
	"`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split("").map(c => [c, true]),
);

interface ParsedKittySequence {
	codepoint: number;
	baseLayoutKey?: number;
	modifier: number;
	eventType: KeyEventType;
}

function parseKittySequence(data: string): ParsedKittySequence | null {
	const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
	if (csiUMatch) {
		const codepoint = Number.parseInt(csiUMatch[1]!, 10);
		const baseLayoutKey = csiUMatch[3] ? Number.parseInt(csiUMatch[3], 10) : undefined;
		const modValue = csiUMatch[4] ? Number.parseInt(csiUMatch[4], 10) : 1;
		const eventType: KeyEventType =
			csiUMatch[5] === "2" ? "repeat" : csiUMatch[5] === "3" ? "release" : "press";
		return { codepoint, baseLayoutKey, modifier: modValue - 1, eventType };
	}
	const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	if (arrowMatch) {
		const modValue = Number.parseInt(arrowMatch[1]!, 10);
		const eventType: KeyEventType =
			arrowMatch[2] === "2" ? "repeat" : arrowMatch[2] === "3" ? "release" : "press";
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		return { codepoint: arrowCodes[arrowMatch[3]!]!, modifier: modValue - 1, eventType };
	}
	const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	if (funcMatch) {
		const keyNum = Number.parseInt(funcMatch[1]!, 10);
		const modValue = funcMatch[2] ? Number.parseInt(funcMatch[2], 10) : 1;
		const eventType: KeyEventType =
			funcMatch[3] === "2" ? "repeat" : funcMatch[3] === "3" ? "release" : "press";
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert!,
			3: FUNCTIONAL_CODEPOINTS.delete!,
			5: FUNCTIONAL_CODEPOINTS.pageUp!,
			6: FUNCTIONAL_CODEPOINTS.pageDown!,
			7: FUNCTIONAL_CODEPOINTS.home!,
			8: FUNCTIONAL_CODEPOINTS.end!,
		};
		const codepoint = funcCodes[keyNum];
		if (codepoint !== undefined) return { codepoint, modifier: modValue - 1, eventType };
	}
	const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	if (homeEndMatch) {
		const modValue = Number.parseInt(homeEndMatch[1]!, 10);
		const eventType: KeyEventType =
			homeEndMatch[2] === "2" ? "repeat" : homeEndMatch[2] === "3" ? "release" : "press";
		const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home! : FUNCTIONAL_CODEPOINTS.end!;
		return { codepoint, modifier: modValue - 1, eventType };
	}
	return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;
	if (actualMod !== expectedMod) return false;
	return parsed.codepoint === expectedCodepoint || parsed.baseLayoutKey === expectedCodepoint;
}

function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	if (!data.startsWith("\x1b[27;") || !data.endsWith("~")) return false;
	const parts = data.slice(5, -1).split(";");
	if (parts.length !== 2) return false;
	const modifier = Number.parseInt(parts[0] ?? "", 10) - 1;
	const keycode = Number.parseInt(parts[1] ?? "", 10);
	return modifier === expectedModifier && keycode === expectedKeycode;
}

const PARSED_KEY_ID_CACHE = new Map<string, { key: string; ctrl: boolean; shift: boolean; alt: boolean }>();

function parseKeyId(keyId: string) {
	const cached = PARSED_KEY_ID_CACHE.get(keyId);
	if (cached) return cached;
	const parts = keyId.toLowerCase().split("+");
	const key = parts[parts.length - 1];
	if (!key) return null;
	const modifiers = new Set(parts.slice(0, -1));
	const parsed = {
		key,
		ctrl: modifiers.has("ctrl"),
		shift: modifiers.has("shift"),
		alt: modifiers.has("alt"),
	};
	PARSED_KEY_ID_CACHE.set(keyId, parsed);
	return parsed;
}

function matchesLegacyModifierSequence(data: string, key: string, modifier: number): boolean {
	if (modifier === MODIFIERS.shift) return LEGACY_SHIFT_SEQUENCES[key]?.includes(data) ?? false;
	if (modifier === MODIFIERS.ctrl) return LEGACY_CTRL_SEQUENCES[key]?.includes(data) ?? false;
	return false;
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	const parsed = parseKeyId(keyId);
	if (!parsed) return false;
	const { key, ctrl, shift, alt } = parsed;
	let modifier = (shift ? MODIFIERS.shift : 0) | (alt ? MODIFIERS.alt : 0) | (ctrl ? MODIFIERS.ctrl : 0);

	switch (key) {
		case "escape":
		case "esc":
			return modifier === 0 && (data === "\x1b" || matchesKittySequence(data, CODEPOINTS.escape!, 0));
		case "space":
			if (!kittyProtocolActive) {
				if (ctrl && !alt && !shift && data === "\x00") return true;
				if (alt && !ctrl && !shift && data === "\x1b ") return true;
			}
			return modifier === 0
				? data === " " || matchesKittySequence(data, CODEPOINTS.space!, 0)
				: matchesKittySequence(data, CODEPOINTS.space!, modifier);
		case "tab":
			if (shift && !ctrl && !alt) {
				return data === "\x1b[Z" || matchesKittySequence(data, CODEPOINTS.tab!, MODIFIERS.shift);
			}
			return modifier === 0
				? data === "\t" || matchesKittySequence(data, CODEPOINTS.tab!, 0)
				: matchesKittySequence(data, CODEPOINTS.tab!, modifier);
		case "enter":
		case "return":
			if (shift && !ctrl && !alt) {
				if (
					matchesKittySequence(data, CODEPOINTS.enter!, MODIFIERS.shift) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter!, MODIFIERS.shift)
				) {
					return true;
				}
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter!, MODIFIERS.shift)) return true;
				if (kittyProtocolActive) return data === "\x1b\r" || data === "\n";
				return false;
			}
			if (alt && !ctrl && !shift) {
				if (
					matchesKittySequence(data, CODEPOINTS.enter!, MODIFIERS.alt) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter!, MODIFIERS.alt)
				) {
					return true;
				}
				if (matchesModifyOtherKeys(data, CODEPOINTS.enter!, MODIFIERS.alt)) return true;
				if (!kittyProtocolActive) return data === "\x1b\r";
				return false;
			}
			if (modifier === 0) {
				return (
					data === "\r" ||
					(!kittyProtocolActive && data === "\n") ||
					data === "\x1bOM" ||
					matchesKittySequence(data, CODEPOINTS.enter!, 0) ||
					matchesKittySequence(data, CODEPOINTS.kpEnter!, 0)
				);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.enter!, modifier) ||
				matchesKittySequence(data, CODEPOINTS.kpEnter!, modifier)
			);
		case "backspace":
			if (alt && !ctrl && !shift) {
				if (data === "\x1b\x7f" || data === "\x1b\b") return true;
				return matchesKittySequence(data, CODEPOINTS.backspace!, MODIFIERS.alt);
			}
			if (modifier === 0) {
				return data === "\x7f" || data === "\x08" || matchesKittySequence(data, CODEPOINTS.backspace!, 0);
			}
			return (
				matchesKittySequence(data, CODEPOINTS.backspace!, modifier) ||
				matchesModifyOtherKeys(data, CODEPOINTS.backspace!, modifier)
			);
		case "up":
		case "down":
		case "left":
		case "right": {
			const cp = ARROW_CODEPOINTS[key]!;
			if (key === "up") {
				if (alt && !ctrl && !shift && (data === "\x1b[1;3A" || (!kittyProtocolActive && data === "\x1bp") || matchesKittySequence(data, cp, MODIFIERS.alt))) return true;
				if (ctrl && !alt && !shift && (data === "\x1b[1;5A" || matchesLegacyModifierSequence(data, "up", MODIFIERS.ctrl) || matchesKittySequence(data, cp, MODIFIERS.ctrl))) return true;
			} else if (key === "down") {
				if (alt && !ctrl && !shift && (data === "\x1b[1;3B" || (!kittyProtocolActive && data === "\x1bn") || matchesKittySequence(data, cp, MODIFIERS.alt))) return true;
				if (ctrl && !alt && !shift && (data === "\x1b[1;5B" || matchesLegacyModifierSequence(data, "down", MODIFIERS.ctrl) || matchesKittySequence(data, cp, MODIFIERS.ctrl))) return true;
			} else if (key === "left") {
				if (alt && !ctrl && !shift && (data === "\x1b[1;3D" || (!kittyProtocolActive && (data === "\x1bB" || data === "\x1bb")) || matchesKittySequence(data, cp, MODIFIERS.alt))) return true;
				if (ctrl && !alt && !shift && (data === "\x1b[1;5D" || matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) || matchesKittySequence(data, cp, MODIFIERS.ctrl))) return true;
			} else if (key === "right") {
				if (alt && !ctrl && !shift && (data === "\x1b[1;3C" || (!kittyProtocolActive && (data === "\x1bF" || data === "\x1bf")) || matchesKittySequence(data, cp, MODIFIERS.alt))) return true;
				if (ctrl && !alt && !shift && (data === "\x1b[1;5C" || matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) || matchesKittySequence(data, cp, MODIFIERS.ctrl))) return true;
			}
			if (modifier === 0) {
				return (LEGACY_KEY_SEQUENCES[key]?.includes(data) ?? false) || matchesKittySequence(data, cp, 0);
			}
			if (matchesLegacyModifierSequence(data, key, modifier)) return true;
			return matchesKittySequence(data, cp, modifier);
		}
		case "insert":
		case "delete":
		case "clear":
		case "home":
		case "end":
		case "pageup":
		case "pagedown": {
			const normKey = key === "pageup" ? "pageUp" : key === "pagedown" ? "pageDown" : key;
			const cp = FUNCTIONAL_CODEPOINTS[normKey];
			if (modifier === 0) {
				return (
					(LEGACY_KEY_SEQUENCES[normKey]?.includes(data) ?? false) ||
					(cp !== undefined && matchesKittySequence(data, cp, 0))
				);
			}
			if (matchesLegacyModifierSequence(data, normKey, modifier)) return true;
			return cp !== undefined && matchesKittySequence(data, cp, modifier);
		}
	}

	if (key.startsWith("f") && key.length >= 2 && key.length <= 3) {
		if (modifier !== 0) return false;
		return LEGACY_KEY_SEQUENCES[key]?.includes(data) ?? false;
	}

	if (key.length === 1 && ((key >= "a" && key <= "z") || SYMBOL_KEYS[key])) {
		const codepoint = key.charCodeAt(0);
		const isLetterKey = key >= "a" && key <= "z";
		const raw = isLetterKey ? String.fromCharCode(key.charCodeAt(0) - 96) : "";
		if (ctrl && alt && !shift && !kittyProtocolActive && isLetterKey) return data === `\x1b${raw}`;
		if (alt && !ctrl && !shift && !kittyProtocolActive && isLetterKey && data === `\x1b${key}`) return true;
		if (ctrl && !shift && !alt) {
			if (!isLetterKey) {
				const legacyCtrl = CTRL_SYMBOL_MAP[key];
				if (legacyCtrl && data === legacyCtrl) return true;
				if (matchesModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)) return true;
				return matchesKittySequence(data, codepoint, MODIFIERS.ctrl);
			}
			if (data === raw || (data.length > 0 && data.charCodeAt(0) === raw.charCodeAt(0))) return true;
			if (matchesModifyOtherKeys(data, codepoint, MODIFIERS.ctrl)) return true;
			return matchesKittySequence(data, codepoint, MODIFIERS.ctrl);
		}
		if (ctrl && shift && !alt) return matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl);
		if (shift && !ctrl && !alt) {
			if (data === key.toUpperCase()) return true;
			return matchesKittySequence(data, codepoint, MODIFIERS.shift);
		}
		if (modifier !== 0) return matchesKittySequence(data, codepoint, modifier);
		return data === key || matchesKittySequence(data, codepoint, 0);
	}
	return false;
}

export function parseKey(data: string): string | undefined {
	const kitty = parseKittySequence(data);
	if (kitty) {
		const { codepoint, baseLayoutKey, modifier } = kitty;
		const mods: string[] = [];
		const effectiveMod = modifier & ~LOCK_MASK;
		if (effectiveMod & MODIFIERS.shift) mods.push("shift");
		if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
		if (effectiveMod & MODIFIERS.alt) mods.push("alt");
		const effectiveCodepoint = baseLayoutKey ?? codepoint;
		let keyName = CODEPOINT_TO_NAME[effectiveCodepoint];
		if (!keyName) {
			if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
			else if (SYMBOL_KEYS[String.fromCharCode(effectiveCodepoint)]) {
				keyName = String.fromCharCode(effectiveCodepoint);
			}
		}
		if (keyName) return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
	}

	if (kittyProtocolActive && (data === "\x1b\r" || data === "\n")) return "shift+enter";
	const legacySeq = LEGACY_SEQUENCE_KEY_IDS[data];
	if (legacySeq) return legacySeq;

	if (data === "\x1b") return "escape";
	if (data === "\t") return "tab";
	if (data === "\r" || (!kittyProtocolActive && data === "\n") || data === "\x1bOM") return "enter";
	if (data === "\x00") return "ctrl+space";
	if (data === " ") return "space";
	if (data === "\x7f" || data === "\x08") return "backspace";
	if (data === "\x1b[Z") return "shift+tab";
	if (!kittyProtocolActive && data === "\x1b\r") return "alt+enter";
	if (!kittyProtocolActive && data === "\x1b ") return "alt+space";
	if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace";
	if (!kittyProtocolActive && data === "\x1bB") return "alt+left";
	if (!kittyProtocolActive && data === "\x1bF") return "alt+right";
	if (!kittyProtocolActive && data.length === 2 && data[0] === "\x1b") {
		const code = data.charCodeAt(1);
		if (code >= 1 && code <= 26) return `ctrl+alt+${String.fromCharCode(code + 96)}`;
		if (code >= 97 && code <= 122) return `alt+${String.fromCharCode(code)}`;
	}
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b[D") return "left";
	if (data === "\x1b[H" || data === "\x1bOH") return "home";
	if (data === "\x1b[F" || data === "\x1bOF") return "end";
	if (data === "\x1b[3~") return "delete";
	if (data === "\x1b[5~") return "pageUp";
	if (data === "\x1b[6~") return "pageDown";

	if (data.length === 1) {
		const code = data.charCodeAt(0);
		const ctrlSymbol = CTRL_SYMBOL_CODES[code];
		if (ctrlSymbol) return ctrlSymbol;
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
		if (code >= 32 && code <= 126) return data;
	}
	return undefined;
}
