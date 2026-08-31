import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyDict, makeDict } from "./codec.js";
import { DICT_FILENAME } from "./constants.js";
import { isNotFound } from "./fs-util.js";
import { parseDict } from "./parse.js";
import type { AgentDict } from "./types.js";

/**
 * Load the project vocabulary from `<projectRoot>/AGENTS.dict`.
 *
 * - No file: returns the inert codec. A project that has not adopted Argot
 *   behaves exactly as before.
 * - A present but malformed file: throws `ArgotParseError`. Argot never
 *   degrades a broken dict to an empty one; silent failure would hand the model
 *   handles the harness cannot expand.
 * - A present, valid file: returns the live codec.
 *
 * Any read error other than "file not found" is rethrown. A dict that exists but
 * cannot be read (permissions, a directory in its place) is an operator problem,
 * not a reason to silently run without expansion.
 */
export async function load(projectRoot: string): Promise<AgentDict> {
	const path = join(projectRoot, DICT_FILENAME);

	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (err) {
		if (isNotFound(err)) {
			return emptyDict();
		}
		throw err;
	}

	return makeDict(parseDict(content, path));
}
