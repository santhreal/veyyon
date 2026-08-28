import { basename, dirname } from "node:path";
import { emptyDict, makeDict, unionVocabularies } from "./codec.js";
import { DICT_FILENAME } from "./constants.js";
import { parseDict } from "./parse.js";
import { ARGOT_PREAMBLE } from "./preamble.js";
import { StreamDecoder } from "./stream.js";
import type { AgentDict, Vocabulary } from "./types.js";

interface Entry {
	vocab: Vocabulary;
	teach: boolean;
}

export class ArgotSession {
	readonly preamble = ARGOT_PREAMBLE;

	readonly #entries = new Map<string, Entry>();
	#decoder: AgentDict = emptyDict();
	#teacher: AgentDict = emptyDict();

	load(key: string, vocab: Vocabulary, opts?: { teach?: boolean }): void {
		const others = Array.from(this.#entries.entries())
			.filter(([existing]) => existing !== key)
			.map(([, entry]) => entry.vocab);
		unionVocabularies(others.concat([vocab]));

		this.#entries.set(key, { vocab, teach: opts?.teach ?? true });
		this.#rebuild();
	}

	unload(key: string): boolean {
		const entry = this.#entries.get(key);
		if (entry === undefined || !entry.teach) {
			return false;
		}
		entry.teach = false;
		this.#rebuild();
		return true;
	}

	observe(path: string, content: string): boolean {
		if (basename(path) !== DICT_FILENAME) {
			return false;
		}
		this.load(dirname(path), parseDict(content, path));
		return true;
	}

	loadVocab(vocab: Vocabulary): void {
		this.#entries.clear();
		if (vocab.handles.size > 0) {
			this.#entries.set("", { vocab, teach: true });
		}
		this.#rebuild();
	}

	promptFragment(): string {
		return this.#teacher.promptFragment();
	}

	expand(text: string): string {
		return this.#decoder.expand(text);
	}

	streamDecoder(): StreamDecoder {
		return new StreamDecoder(this.vocabulary());
	}

	get loaded(): boolean {
		return this.#entries.size > 0;
	}

	vocabulary(): Vocabulary {
		return unionVocabularies(Array.from(this.#entries.values()).map(entry => entry.vocab));
	}

	fork(): ArgotSession {
		const copy = new ArgotSession();
		for (const [key, entry] of this.#entries) {
			copy.#entries.set(key, { vocab: entry.vocab, teach: entry.teach });
		}
		copy.#rebuild();
		return copy;
	}

	#rebuild(): void {
		const all = Array.from(this.#entries.values()).map(entry => entry.vocab);
		const taught = Array.from(this.#entries.values())
			.filter(entry => entry.teach)
			.map(entry => entry.vocab);
		this.#decoder = makeDict(unionVocabularies(all));
		this.#teacher = makeDict(unionVocabularies(taught));
	}
}
