import { basename, dirname } from "node:path";
import { emptyDict, makeDict, unionVocabularies } from "./codec.js";
import { DICT_FILENAME } from "./constants.js";
import { parseDict } from "./parse.js";
import { ARGOT_PREAMBLE } from "./preamble.js";
import { StreamDecoder } from "./stream.js";
import type { AgentDict, Vocabulary } from "./types.js";

/** One loaded vocabulary and whether the model is currently taught to write it. */
interface Entry {
	vocab: Vocabulary;
	teach: boolean;
}

/** Session integration object for managing loaded project vocabularies and expansion. */
export class ArgotSession {
	/** The fixed notation block. Inject once, whether or not a dictionary exists. */
	readonly preamble = ARGOT_PREAMBLE;

	readonly #entries = new Map<string, Entry>();
	#decoder: AgentDict = emptyDict();
	#teacher: AgentDict = emptyDict();

	/** Load project vocabulary under key. */
	load(key: string, vocab: Vocabulary, opts?: { teach?: boolean }): void {
		// Validate against every other key before mutating, so a conflict throws
		// without half-applying. Rebuilding after the set cannot then throw.
		const others = Array.from(this.#entries.entries())
			.filter(([existing]) => existing !== key)
			.map(([, entry]) => entry.vocab);
		unionVocabularies(others.concat([vocab]));

		this.#entries.set(key, { vocab, teach: opts?.teach ?? true });
		this.#rebuild();
	}

	/** Stop teaching the vocabulary at key while preserving decoding. */
	unload(key: string): boolean {
		const entry = this.#entries.get(key);
		if (entry === undefined || !entry.teach) {
			return false;
		}
		entry.teach = false;
		this.#rebuild();
		return true;
	}

	/** Process file content and load dictionary if path is AGENTS.dict. */
	observe(path: string, content: string): boolean {
		if (basename(path) !== DICT_FILENAME) {
			return false;
		}
		this.load(dirname(path), parseDict(content, path));
		return true;
	}

	/** Arm session from single vocabulary, clearing previous entries. */
	loadVocab(vocab: Vocabulary): void {
		this.#entries.clear();
		if (vocab.handles.size > 0) {
			this.#entries.set("", { vocab, teach: true });
		}
		this.#rebuild();
	}

	/** Prompt fragment teaching active handles. */
	promptFragment(): string {
		return this.#teacher.promptFragment();
	}

	/** Restore every loaded handle to its expansion. Identity until one loads. */
	expand(text: string): string {
		return this.#decoder.expand(text);
	}

	/** Create a streaming decoder bound to current decode vocabulary. */
	streamDecoder(): StreamDecoder {
		return new StreamDecoder(this.vocabulary());
	}

	/** Whether any vocabulary is loaded this session (taught or decode-only). */
	get loaded(): boolean {
		return this.#entries.size > 0;
	}

	/** Combined decode vocabulary across all loaded entries. */
	vocabulary(): Vocabulary {
		return unionVocabularies(Array.from(this.#entries.values()).map(entry => entry.vocab));
	}

	/** Create a detached copy of this session with independent entry sets. */
	fork(): ArgotSession {
		const copy = new ArgotSession();
		for (const [key, entry] of this.#entries) {
			copy.#entries.set(key, { vocab: entry.vocab, teach: entry.teach });
		}
		copy.#rebuild();
		return copy;
	}

	/** Rebuild the decode and teach views from the current entries. */
	#rebuild(): void {
		const all = Array.from(this.#entries.values()).map(entry => entry.vocab);
		const taught = Array.from(this.#entries.values())
			.filter(entry => entry.teach)
			.map(entry => entry.vocab);
		this.#decoder = makeDict(unionVocabularies(all));
		this.#teacher = makeDict(unionVocabularies(taught));
	}
}
