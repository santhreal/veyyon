import { describe, expect, test } from "bun:test";
import { Settings } from "../../config/settings";
import type { ToolSession } from "..";
import { executeFileSearch } from "../file-search";
import { ToolError } from "../tool-errors";

const ROOT_SEARCH_ERROR = "Searching from root directory '/' is not allowed";

async function expectRootSearchRejected(searchPath: string): Promise<void> {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
	let thrown: unknown;
	try {
		await executeFileSearch(session, { path: searchPath });
	} catch (error) {
		thrown = error;
	}

	if (!(thrown instanceof Error)) {
		throw new Error(`Expected file search path ${JSON.stringify(searchPath)} to reject`);
	}

	expect(thrown).toBeInstanceOf(ToolError);
	expect(thrown.message).toBe(ROOT_SEARCH_ERROR);
}

describe("executeFileSearch", () => {
	test.each(["/", "//"])("rejects bare root search path %s", async searchPath => {
		await expectRootSearchRejected(searchPath);
	});
});
