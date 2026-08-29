import type { BlockMode } from "./speakable-helpers";
import {
	classifyPrefix,
	FIRST_CLAUSE_MIN,
	FIRST_FORCED_MAX,
	FIRST_SEGMENT_MIN,
	findClauseCut,
	findForcedCut,
	findLastClauseCut,
	findSentenceCut,
	HR_LINE_RE,
	MAX_SEGMENT,
	MIN_SEGMENT,
	normalizeSpeakable,
	SOFT_CLAUSE_LEN,
} from "./speakable-helpers";

export class SpeakableStream {
	#mode: BlockMode = "linestart";
	#prefix = "";
	#fence = "";
	#codeLine = "";
	#afterSwallow: BlockMode = "linestart";
	#buf = "";
	#spoke = false;

	push(delta: string): string[] {
		const out: string[] = [];
		for (const ch of delta) this.#consume(ch, out);
		this.#extract(out);
		return out;
	}

	flush(): string[] {
		const out: string[] = [];
		if (this.#mode === "linestart" && this.#prefix.length > 0 && !HR_LINE_RE.test(this.#prefix)) {
			this.#buf += this.#prefix;
		}
		this.#prefix = "";
		this.#mode = "linestart";
		this.#drain(out);
		return out;
	}

	flushIdle(): string[] {
		const out: string[] = [];
		const pending = this.#buf.trimEnd();
		const completeThought = /[.!?…][)\]"'»”’]*$/.test(pending);
		if (!completeThought && pending.length < MIN_SEGMENT) return out;
		this.#drain(out);
		return out;
	}

	#consume(ch: string, out: string[]): void {
		switch (this.#mode) {
			case "linestart":
				this.#consumeLineStart(ch, out);
				return;
			case "prose":
				if (ch === "\n") this.#hardBreak(out);
				else this.#buf += ch;
				return;
			case "swallow":
				if (ch === "\n") this.#mode = this.#afterSwallow;
				return;
			case "code":
				this.#consumeCode(ch);
				return;
		}
	}

	#consumeLineStart(ch: string, out: string[]): void {
		if (ch === "\n") {
			const line = this.#prefix;
			this.#prefix = "";
			if (line.length > 0 && !HR_LINE_RE.test(line)) this.#buf += line;
			this.#hardBreak(out);
			return;
		}
		this.#prefix += ch;
		const decision = classifyPrefix(this.#prefix);
		if (decision.kind === "undecided") {
			if (this.#prefix.length > 8) {
				this.#buf += this.#prefix;
				this.#prefix = "";
				this.#mode = "prose";
			}
			return;
		}
		this.#prefix = "";
		switch (decision.kind) {
			case "prose":
				this.#buf += decision.text;
				this.#mode = "prose";
				return;
			case "marker":
				this.#buf += decision.spoken;
				this.#mode = "prose";
				return;
			case "swallow":
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
				return;
			case "fence":
				this.#fence = decision.fence;
				this.#codeLine = "";
				this.#mode = "swallow";
				this.#afterSwallow = "code";
				return;
		}
	}

	#consumeCode(ch: string): void {
		if (ch === "\n") {
			this.#codeLine = "";
			return;
		}
		if (this.#codeLine.length < 3) {
			this.#codeLine += ch;
			if (this.#codeLine === this.#fence) {
				this.#mode = "swallow";
				this.#afterSwallow = "linestart";
			}
		}
	}

	#hardBreak(out: string[]): void {
		this.#mode = "linestart";
		this.#drain(out);
	}

	#drain(out: string[]): void {
		this.#extract(out);
		const text = this.#buf;
		this.#buf = "";
		this.#emit(text, out);
	}

	#extract(out: string[]): void {
		for (;;) {
			const buf = this.#buf;
			const min = this.#spoke ? MIN_SEGMENT : FIRST_SEGMENT_MIN;
			const sentence = findSentenceCut(buf, min);
			if (sentence !== -1 && sentence <= MAX_SEGMENT) {
				this.#cut(sentence, out);
				continue;
			}
			if (!this.#spoke && buf.length >= FIRST_CLAUSE_MIN) {
				const clause = findClauseCut(buf, FIRST_SEGMENT_MIN);
				if (clause !== -1 && clause <= FIRST_FORCED_MAX) {
					this.#cut(clause, out);
					continue;
				}
				if (buf.length >= FIRST_FORCED_MAX) {
					this.#cut(findForcedCut(buf, FIRST_FORCED_MAX), out);
					continue;
				}
			}
			if (this.#spoke && buf.length >= SOFT_CLAUSE_LEN) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, SOFT_CLAUSE_LEN);
				if (clause !== -1) {
					this.#cut(clause, out);
					continue;
				}
			}
			if (buf.length > MAX_SEGMENT) {
				const clause = findLastClauseCut(buf, MIN_SEGMENT, MAX_SEGMENT);
				this.#cut(clause !== -1 ? clause : findForcedCut(buf, MAX_SEGMENT), out);
				continue;
			}
			return;
		}
	}

	#cut(at: number, out: string[]): void {
		const head = this.#buf.slice(0, at);
		this.#buf = this.#buf.slice(at);
		this.#emit(head, out);
	}

	#emit(raw: string, out: string[]): void {
		const spoken = normalizeSpeakable(raw);
		if (!spoken) return;
		out.push(spoken);
		this.#spoke = true;
	}
}
