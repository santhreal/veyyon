import { C1_INTRODUCERS, C1_MAP, OPEN_FRAGMENT_LIMIT, SEQUENCE_AT, stripAnsi } from "./strip-ansi-helpers";

export { stripAnsi };

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
