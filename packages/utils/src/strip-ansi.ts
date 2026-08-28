const HAS_ESCAPE_OR_C1 = /[\x1b\x90\x98\x9b-\x9f]/;
const C1_INTRODUCERS = /[\x90\x98\x9b-\x9f]/g;
const C1_MAP: Record<string, string> = {
	"\x90": "\x1bP",
	"\x98": "\x1bX",
	"\x9b": "\x1b[",
	"\x9c": "\x1b\\",
	"\x9d": "\x1b]",
	"\x9e": "\x1b^",
	"\x9f": "\x1b_",
};

const ESCAPE_SEQUENCE =
	/\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]+[\x30-\x7e]|[\x30-\x4f\x51-\x57\x59-\x5a\x5c\x60-\x7e])/g;

const SEQUENCE_AT = new RegExp(ESCAPE_SEQUENCE.source, "y");

const OPEN_FRAGMENT_LIMIT = 64 * 1024;

export function stripAnsi(s: string): string {
	if (!HAS_ESCAPE_OR_C1.test(s)) return s;
	const normalized = s.replace(C1_INTRODUCERS, ch => C1_MAP[ch] ?? ch);
	return normalized.replace(ESCAPE_SEQUENCE, "").replaceAll("\x1b", "");
}

export class AnsiStripper {
	#open = "";

	push(chunk: string): string {
		const buffer = this.#open + chunk.replace(C1_INTRODUCERS, ch => C1_MAP[ch] ?? ch);
		this.#open = "";
		let settled = "";
		let cursor = 0;
		while (cursor < buffer.length) {
			const introducer = buffer.indexOf("\x1b", cursor);
			if (introducer === -1) {
				settled += buffer.slice(cursor);
				break;
			}
			settled += buffer.slice(cursor, introducer);
			SEQUENCE_AT.lastIndex = introducer;
			if (SEQUENCE_AT.test(buffer)) {
				cursor = SEQUENCE_AT.lastIndex;
				continue;
			}
			if (buffer.length - introducer > OPEN_FRAGMENT_LIMIT) {
				cursor = introducer + 1;
				continue;
			}
			this.#open = buffer.slice(introducer);
			break;
		}
		return settled;
	}

	get pending(): string {
		return stripAnsi(this.#open);
	}

	get held(): number {
		return this.#open.length;
	}
}
