// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.

import { basename } from "node:path";
import { emptyDict, makeDict } from "./codec";
import { DICT_FILENAME } from "./constants";
import { parseDict } from "./parse";
import { ARGOT_PREAMBLE } from "./preamble";
import type { AgentDict, Vocabulary } from "./types";

/**
 * The whole harness integration in one object. A session starts inert and is
 * armed once, by one of two flows; expansion is identity until then.
 *
 * Cache flow (recommended): the harness generates or loads a dictionary that
 * lives outside the repository, arms the session from it directly, and teaches
 * the handles in the system prompt:
 *
 *   const argot = new ArgotSession();
 *   argot.loadVocab(vocab);                    // once, from the generated cache
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
 *
 * Either way the session owns the "inert until armed" state, so the harness
 * never juggles a mutable codec or checks filenames itself.
 */
export class ArgotSession {
	/** The fixed notation block. Inject once, whether or not a dictionary exists. */
	readonly preamble = ARGOT_PREAMBLE;

	private dict: AgentDict = emptyDict();
	private isLoaded = false;

	/**
	 * Feed a file the agent read. If its name is `AGENTS.dict`, its vocabulary
	 * becomes active for the rest of the session and this returns `true`; the read
	 * that shows the model the dictionary is the same read that arms the codec.
	 * Any other file is ignored and returns `false`.
	 *
	 * Throws `ArgotParseError` on a malformed dictionary. Argot fails loud rather
	 * than arming an empty codec while the model has been told to use handles.
	 */
	observe(path: string, content: string): boolean {
		if (basename(path) !== DICT_FILENAME) {
			return false;
		}
		this.dict = makeDict(parseDict(content, path));
		this.isLoaded = true;
		return true;
	}

	/**
	 * Arm the session from a vocabulary directly, without a file read. This is the
	 * cache flow: the harness generates or loads a dictionary that lives outside
	 * the repository (a local per-project cache), so the model never reads an
	 * `AGENTS.dict` and {@link observe} never fires. Since the dictionary is not
	 * on disk where the model can see it, pair this with {@link promptFragment} to
	 * teach the handles at session start.
	 *
	 * Passing a vocabulary with no handles re-arms the inert codec.
	 */
	loadVocab(vocab: Vocabulary): void {
		this.dict = makeDict(vocab);
		this.isLoaded = true;
	}

	/**
	 * The system-prompt block listing the active handles, or `""` when none are
	 * loaded. In the load-on-read flow the model learns the handles by reading the
	 * `AGENTS.dict` file, so this stays unused; in the cache flow the file is off
	 * in a state directory, so inject this once at session start (after the
	 * {@link preamble}) to advertise the handles the model may write.
	 */
	promptFragment(): string {
		return this.dict.promptFragment();
	}

	/** Restore every known handle to its expansion. Identity until a dict loads. */
	expand(text: string): string {
		return this.dict.expand(text);
	}

	/** Whether a dictionary has been loaded this session. */
	get loaded(): boolean {
		return this.isLoaded;
	}
}
