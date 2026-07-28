/**
 * Render untrusted text as inert terminal text.
 *
 * C0/C1 controls, DEL, every Unicode format character, the JavaScript line/paragraph separators,
 * and malformed UTF-16 code units are written as visible escapes. Valid non-control Unicode is
 * preserved. Astral format characters use a code-point escape so a surrogate half can never be
 * mistaken for an independently safe character.
 */
export function escapeTerminalText(value: string): string {
	let escaped = "";
	for (let index = 0; index < value.length; index++) {
		const first = value.charCodeAt(index);
		if (first >= 0xd800 && first <= 0xdbff) {
			const second = value.charCodeAt(index + 1);
			if (second >= 0xdc00 && second <= 0xdfff) {
				const pair = value.slice(index, index + 2);
				const codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
				escaped += /\p{Cf}/u.test(pair) ? `\\u{${hex(codePoint, 5)}}` : pair;
				index++;
				continue;
			}
			escaped += `\\u${hex(first, 4)}`;
			continue;
		}
		if (first >= 0xdc00 && first <= 0xdfff) {
			escaped += `\\u${hex(first, 4)}`;
			continue;
		}

		const character = value[index];
		if (
			first <= 0x1f ||
			(first >= 0x7f && first <= 0x9f) ||
			first === 0x2028 ||
			first === 0x2029 ||
			/\p{Cf}/u.test(character)
		) {
			escaped += `\\u${hex(first, 4)}`;
		} else {
			escaped += character;
		}
	}
	return escaped;
}

function hex(value: number, width: number): string {
	return value.toString(16).toUpperCase().padStart(width, "0");
}
