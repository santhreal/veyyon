import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, DICT_FILENAME } from "./constants.js";

/**
 * Options that decide the wording of the notation block.
 *
 * The block is model-facing text, so it must describe only the affordances the
 * model actually has this turn. There is exactly one such switch: whether the
 * harness exposes the load and unload tools. Everything else about the block is
 * fixed. The sigil is deliberately not an option here; it belongs to a
 * vocabulary, and the block only shows `§` as an illustration.
 */
export interface PreambleOptions {
	/**
	 * Whether {@link ARGOT_LOAD_TOOL} and {@link ARGOT_UNLOAD_TOOL} are available to
	 * the model. When `true`, the block tells the model it can activate a folder's
	 * shorthand itself by calling them. When `false` (the default), it describes
	 * only the passive paths, because you must never instruct a model to call a
	 * tool that is not in its tool list.
	 */
	tools?: boolean;
}

/**
 * Build the fixed, model-facing notation block. A harness injects this once into
 * the system prompt, always, whether or not a project has an `AGENTS.dict`. It
 * teaches the model how the shorthand works and how it comes to know a project's
 * handles; the per-project handle table itself rides in separately (through a
 * tool result, a file read, or {@link ArgotSession.promptFragment}) so this block
 * stays constant and cacheable.
 *
 * This is the one home for the notation. Keep the wording here in sync with the
 * SPEC and the handbook.
 */
export function renderPreamble(options: PreambleOptions = {}): string {
	const learn = options.tools
		? `You learn a project's handles one of two ways: the harness lists them for you,
or you activate them yourself by calling \`${ARGOT_LOAD_TOOL}(folder_path)\` on the
folder you are working in, which turns that project's handles on for you (the harness
builds or reads the dictionary; nothing is written to the repository). When you finish
with a project, call \`${ARGOT_UNLOAD_TOOL}(folder_path)\` to stop writing its handles;
anything you already wrote still reads back correctly.`
		: `You learn a project's handles one of two ways: the harness lists them for you, or the
project keeps them in a file named ${DICT_FILENAME} that you read from the folder you are
working in.`;

	return `## Project shorthand (Argot)

A project may define shorthand handles: each maps a short name to a longer string
the project repeats a lot, such as a full path or a canonical command. A handle
is a marker (\`§\` by default) followed by the name, for example \`§dbconn\`. ${learn}

Shorthand is scoped to a single project. When your work sits inside a larger tree
(a crate inside a monorepo, a package inside a workspace), the handles that apply
are the ones for the narrowest project you are actually working in, not a parent
that contains many projects.

Once you know a project's handles, write a handle wherever you would have written
its exact expansion, and write everything else normally. The harness restores
every handle to its full text before anything runs or is shown, so handles are
lossless and cost you nothing in accuracy. Only use a handle for the exact string
it stands for; never invent one that has not been defined for you.`;
}

/**
 * The notation block for a harness with no load/unload tools: the passive default.
 * Equivalent to `renderPreamble({ tools: false })`. Kept as a named constant
 * because it is a stable, cacheable string many callers inject verbatim.
 */
export const ARGOT_PREAMBLE = renderPreamble();
