import type { NoticeSeverity, NoticeSink, OperatorNotice } from "./operator-notices-helpers";

export { formatNotice, stderrNoticeSink } from "./operator-notices-helpers";
export type { NoticeSeverity, OperatorNotice };

export class OperatorNotices {
	#sink: NoticeSink | undefined;
	readonly #pending: OperatorNotice[] = [];
	readonly #all: OperatorNotice[] = [];
	readonly #seen = new Set<string>();

	constructor(sink?: NoticeSink) {
		this.#sink = sink;
	}

	add(notice: Omit<OperatorNotice, "at"> & { at?: number }): void {
		const key = `${notice.severity}\0${notice.source}\0${notice.text}`;
		if (this.#seen.has(key)) return;
		this.#seen.add(key);

		const full: OperatorNotice = {
			severity: notice.severity,
			source: notice.source,
			text: notice.text,
			at: notice.at ?? Date.now(),
		};
		this.#all.push(full);
		if (this.#sink === undefined) {
			this.#pending.push(full);
			return;
		}
		this.#sink(full);
	}

	warn(source: string, text: string): void {
		this.add({ severity: "warning", source, text });
	}

	error(source: string, text: string): void {
		this.add({ severity: "error", source, text });
	}

	setSink(sink: NoticeSink): void {
		this.#sink = sink;
		const buffered = this.#pending.splice(0, this.#pending.length);
		for (const notice of buffered) sink(notice);
	}

	pending(): readonly OperatorNotice[] {
		return this.#pending;
	}

	all(): readonly OperatorNotice[] {
		return this.#all;
	}

	get isEmpty(): boolean {
		return this.#all.length === 0;
	}
}
