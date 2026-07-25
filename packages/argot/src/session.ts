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

/**
 * The whole harness integration in one object. A session starts inert and holds
 * a keyed set of loaded vocabularies; expansion is identity until at least one is
 * loaded.
 *
 * A key names the project a vocabulary belongs to (a folder path, a cache id).
 * Loading several keys is how one session works across several projects at once,
 * for example an agent in a monorepo that touches two crates. The keys keep the
 * vocabularies separate so one can be dropped without disturbing the others.
 *
 * The two directions follow opposite rules, so the session keeps two views:
 *
 * - **Decode** ({@link expand}) unions *every* loaded vocabulary, taught or not.
 *   Decoding is unconditional: a handle the model wrote must always expand, even
 *   for a project whose teaching was turned off, or the handle reaches a tool
 *   raw.
 * - **Teach** ({@link promptFragment}) unions only the vocabularies still marked
 *   to teach. {@link unload} stops teaching one without dropping it from decode.
 *
 * Combining vocabularies is collision-safe because cache-flow handle names are
 * content-addressed (the same string gets the same name everywhere). Two projects
 * that genuinely disagree on a handle throw {@link ArgotConflictError} at load,
 * so a wrong expansion can never slip in silently.
 *
 * Two arming flows feed it:
 *
 * Cache flow (recommended): the harness generates or loads a dictionary that
 * lives outside the repository and arms the session from it directly, teaching
 * the handles in the system prompt.
 *
 *   const argot = new ArgotSession();
 *   argot.load(cacheId, vocab);                // once per project the agent works
 *   systemPrompt += argot.preamble;            // fixed notation block
 *   systemPrompt += argot.promptFragment();    // the active handle table
 *   const clean = argot.expand(modelOutput);   // on every model output
 *
 * Load-on-read flow: the dictionary is a file the agent reads (an `AGENTS.dict`
 * in the tree), and the same read that shows the model the table arms the codec:
 *
 *   const argot = new ArgotSession();
 *   systemPrompt += argot.preamble;            // once, at session start
 *   argot.observe(path, content);              // on every file the agent reads
 *   const clean = argot.expand(modelOutput);   // on every model output
 */
export class ArgotSession {
	/** The fixed notation block. Inject once, whether or not a dictionary exists. */
	readonly preamble = ARGOT_PREAMBLE;

	private readonly entries = new Map<string, Entry>();
	private decoder: AgentDict = emptyDict();
	private teacher: AgentDict = emptyDict();

	/**
	 * Load a project's vocabulary under `key`, replacing any vocabulary already at
	 * that key. `teach` (default `true`) controls whether the model is taught to
	 * write these handles; decoding is on regardless.
	 *
	 * Throws `ArgotConflictError` when the new vocabulary disagrees with an already
	 * loaded one (a shared handle name bound to a different expansion, or a
	 * different sigil). The session is left untouched when it throws, so a bad load
	 * never corrupts a good state.
	 */
	load(key: string, vocab: Vocabulary, opts?: { teach?: boolean }): void {
		// Validate against every other key before mutating, so a conflict throws
		// without half-applying. Rebuilding after the set cannot then throw.
		const others = [...this.entries.entries()]
			.filter(([existing]) => existing !== key)
			.map(([, entry]) => entry.vocab);
		unionVocabularies([...others, vocab]);

		this.entries.set(key, { vocab, teach: opts?.teach ?? true });
		this.rebuild();
	}

	/**
	 * Stop teaching the vocabulary at `key`: the model is no longer shown these
	 * handles, but they still decode, so any the model already wrote keep
	 * expanding. Returns whether anything changed (a no-op when the key is absent
	 * or already not taught).
	 */
	unload(key: string): boolean {
		const entry = this.entries.get(key);
		if (entry === undefined || !entry.teach) {
			return false;
		}
		entry.teach = false;
		this.rebuild();
		return true;
	}

	/**
	 * Feed a file the agent read. If its name is `AGENTS.dict`, its vocabulary is
	 * loaded under the file's directory as the key and this returns `true`; the
	 * read that shows the model the dictionary is the same read that arms the
	 * codec. Reading dictionaries from two directories loads both. Any other file
	 * is ignored and returns `false`.
	 *
	 * Throws `ArgotParseError` on a malformed dictionary and `ArgotConflictError`
	 * on one that clashes with an already loaded vocabulary. Either way the session
	 * is unchanged: Argot fails loud rather than arming a broken or half state.
	 */
	observe(path: string, content: string): boolean {
		if (basename(path) !== DICT_FILENAME) {
			return false;
		}
		this.load(dirname(path), parseDict(content, path));
		return true;
	}

	/**
	 * Arm the session from a single vocabulary, discarding anything already loaded.
	 * This is the simple cache flow: one project, one dictionary, generated outside
	 * the repository so the model never reads an `AGENTS.dict` and {@link observe}
	 * never fires. Pair it with {@link promptFragment} to teach the handles.
	 *
	 * Passing a vocabulary with no handles clears the session back to inert. For a
	 * session that loads more than one project, use {@link load} with distinct keys
	 * instead.
	 */
	loadVocab(vocab: Vocabulary): void {
		this.entries.clear();
		if (vocab.handles.size > 0) {
			this.entries.set("", { vocab, teach: true });
		}
		this.rebuild();
	}

	/**
	 * The system-prompt block listing every handle the session currently teaches,
	 * or `""` when it teaches none. In the load-on-read flow the model learns the
	 * handles from the `AGENTS.dict` it read, so this stays unused; in the cache
	 * flow the file is off in a state directory, so inject this once at session
	 * start (after the {@link preamble}).
	 */
	promptFragment(): string {
		return this.teacher.promptFragment();
	}

	/** Restore every loaded handle to its expansion. Identity until one loads. */
	expand(text: string): string {
		return this.decoder.expand(text);
	}

	/**
	 * A decoder for text that arrives in pieces, bound to a snapshot of the
	 * session's current decode vocabulary. Use it for a live token stream, where a
	 * handle can be split across chunk boundaries and {@link expand} on each chunk
	 * would leak or mis-decode it. Feed every chunk to `push`, render only what it
	 * returns, and call `flush` once at end of stream. Build a fresh one per message
	 * (or per subagent stream). Identity pass-through until a dictionary loads.
	 */
	streamDecoder(): StreamDecoder {
		return new StreamDecoder(this.vocabulary());
	}

	/** Whether any vocabulary is loaded this session (taught or decode-only). */
	get loaded(): boolean {
		return this.entries.size > 0;
	}

	/**
	 * The session's combined decode vocabulary: the union of every loaded entry
	 * (taught or decode-only), which is exactly what {@link expand} decodes with. An
	 * empty vocabulary (no handles) when nothing is loaded. Use it to measure what a
	 * model could have adopted this session, with the same sigil and handle set the
	 * decoder uses.
	 */
	vocabulary(): Vocabulary {
		return unionVocabularies([...this.entries.values()].map(entry => entry.vocab));
	}

	/**
	 * A detached copy of this session, for handing a subagent the parent's
	 * shorthand at spawn (the `inherit` mode).
	 *
	 * Correctness never rests on this. Every agent expands its own output at every
	 * boundary it emits across: a tool call, the persisted transcript, the prompt
	 * it hands a spawned child, and the result it returns to a parent. Because each
	 * side only ever emits fully expanded text to the other, a handle never crosses
	 * the parent-child wire, and no child ever needs the parent's vocabulary to be
	 * correct. A subagent that starts empty ({@link ArgotSession} with no load) is
	 * already correct.
	 *
	 * Forking is purely a token optimization: the child begins already knowing the
	 * parent's handles, so it writes the same shorthand from its first turn instead
	 * of re-arming from the cache, and a harness that also chooses not to expand the
	 * spawn prompt can rely on the child decoding what the parent wrote. Even then
	 * the return boundary stays safe: the child expands its own result, which covers
	 * any handle it added by loading a project the parent never had.
	 *
	 * The copy is independent in the one way that matters: the child gets its own
	 * entry set, so the child loading, unloading, or replacing a project never
	 * reaches back into the parent, and the parent's later changes never reach the
	 * child. The vocabularies themselves are shared by reference because a loaded
	 * vocabulary is immutable.
	 */
	fork(): ArgotSession {
		const copy = new ArgotSession();
		for (const [key, entry] of this.entries) {
			copy.entries.set(key, { vocab: entry.vocab, teach: entry.teach });
		}
		copy.rebuild();
		return copy;
	}

	/** Rebuild the decode and teach views from the current entries. */
	private rebuild(): void {
		const all = [...this.entries.values()].map(entry => entry.vocab);
		const taught = [...this.entries.values()].filter(entry => entry.teach).map(entry => entry.vocab);
		this.decoder = makeDict(unionVocabularies(all));
		this.teacher = makeDict(unionVocabularies(taught));
	}
}
