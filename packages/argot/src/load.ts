import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyDict, makeDict } from "./codec.js";
import { DICT_FILENAME } from "./constants.js";
import { isNotFound } from "./fs-util.js";
import { parseDict } from "./parse.js";
import type { AgentDict } from "./types.js";

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
