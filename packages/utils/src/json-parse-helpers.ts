export const QUOTE = 0x22;
export const BACKSLASH = 0x5c;
export const U = 0x75;
export const SQUOTE = 0x27;

export const VALID_ESCAPE_CHAR = new Uint8Array(128);
for (const ch of '"\\/bfnrtu') VALID_ESCAPE_CHAR[ch.charCodeAt(0)] = 1;

export const CONTROL_ESCAPES: readonly string[] = (() => {
	const escapes = new Array<string>(32);
	for (let i = 0; i < 32; i++) {
		escapes[i] =
			i === 0x08
				? "\\b"
				: i === 0x09
					? "\\t"
					: i === 0x0a
						? "\\n"
						: i === 0x0c
							? "\\f"
							: i === 0x0d
								? "\\r"
								: `\\u00${i.toString(16).padStart(2, "0")}`;
	}
	return escapes;
})();

export const HEX4_RE = /^[0-9a-fA-F]{4}$/;

export function isHexDigit(cp: number): boolean {
	return (cp >= 0x30 && cp <= 0x39) || ((cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x66);
}

export function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

export function isIdentChar(cp: number): boolean {
	return (
		(cp >= 0x61 && cp <= 0x7a) ||
		(cp >= 0x41 && cp <= 0x5a) ||
		(cp >= 0x30 && cp <= 0x39) ||
		cp === 0x5f ||
		cp === 0x24
	);
}

export const KEYWORDS: readonly (readonly [string, unknown])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];

export const NON_RECOVERABLE_BAREWORDS: Record<string, true> = {
	NaN: true,
	nan: true,
	Infinity: true,
	infinity: true,
	undefined: true,
};

export const INCOMPLETE = Symbol("incomplete");

/** Lightweight string-level repair for escape/control-char hazards in JSON. */
export function repairJson(json: string): string {
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let inString = false;
	let i = 0;

	while (i < len) {
		if (!inString) {
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			if (i >= len) break;
			inString = true;
			i++;
			continue;
		}

		while (i < len) {
			const cp = json.charCodeAt(i);
			if (cp < 0x20 || cp === QUOTE || cp === BACKSLASH) break;
			i++;
		}
		if (i >= len) break;

		const cp = json.charCodeAt(i);

		if (cp === QUOTE) {
			inString = false;
			i++;
			continue;
		}

		if (cp === BACKSLASH) {
			if (i + 1 >= len) {
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			const nextCp = json.charCodeAt(i + 1);

			if (nextCp === U) {
				if (
					i + 5 < len &&
					isHexDigit(json.charCodeAt(i + 2)) &&
					isHexDigit(json.charCodeAt(i + 3)) &&
					isHexDigit(json.charCodeAt(i + 4)) &&
					isHexDigit(json.charCodeAt(i + 5))
				) {
					i += 6;
					continue;
				}
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			if (nextCp < 128 && VALID_ESCAPE_CHAR[nextCp] === 1) {
				i += 2;
				continue;
			}

			parts.push(json.slice(lastEmit, i), "\\\\");
			lastEmit = i + 1;
			i++;
			continue;
		}

		parts.push(json.slice(lastEmit, i), CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i++;
	}

	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/** Recursive-descent parser for relaxed JSON with streaming recovery. */
