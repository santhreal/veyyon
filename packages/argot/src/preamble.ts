import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, DICT_FILENAME } from "./constants.js";

export interface PreambleOptions {
	tools?: boolean;
}

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
is a marker (\`§\` by default) followed by the name, for example \`§dbconn\`. Prefer
a handle over the string it stands for: it makes your output shorter at no cost to
meaning, because the harness expands every handle back to its full text. ${learn}

Shorthand is scoped to a single project. When your work sits inside a larger tree
(a crate inside a monorepo, a package inside a workspace), the handles that apply
are the ones for the narrowest project you are actually working in, not a parent
that contains many projects.

Once you know a project's handles, write a handle wherever you would have written
its exact expansion, and write everything else normally. For example, if \`§dbconn\`
stands for \`packages/server/src/database/connection.ts\`, then anywhere you would
type that path, whether in prose, a command, or a diff, write \`§dbconn\` instead.
The harness restores every handle to its full text before anything runs or is
shown, so handles are lossless and cost you nothing in accuracy. Only use a handle
for the exact string it stands for; never invent one that has not been defined for
you.`;
}

export const ARGOT_PREAMBLE = renderPreamble();
