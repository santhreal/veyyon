/**
 * WHY THIS SUITE EXISTS:
 *
 * A session file under the streaming threshold is read whole into one string and split into lines.
 * Each line is a slice of that string, and a slice keeps the whole string alive. The loaded layout a
 * resumed session adopts for its first partial rewrite held the header line that way, so the open
 * session kept every byte of the file it was loaded from, on top of the entries parsed from it, for
 * as long as it stayed open.
 *
 * CLASS: whatever a loaded session keeps (its entries, its layout, its title, anything added later)
 * holds no slice of the text it was read from, on either load path: the whole-file read and the
 * streaming read a file of 8 MiB or more takes. Each row opens a session of distinct large texts and
 * bounds the string bytes the open leaves live by the texts it holds, with room for the entries' own
 * small strings and none for a second copy of the file.
 *
 * DOES NOT CATCH: a slice of a text smaller than the room the bound leaves, which keeps its text
 * alive but costs less than the bound can see; and a retained copy that is not a string, such as a
 * buffer of the file's bytes, which the string count does not read.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { liveStringBytes } from "../helpers/live-string-bytes";

/** A heap snapshot walks the whole process heap; in a shared suite process that takes seconds. */
const SNAPSHOT_ROW_TIMEOUT_MS = 60_000;

/** The file size at and above which the loader reads a session file in chunks rather than whole. */
const STREAM_LOAD_BYTES = 8 * 1024 * 1024;

/** One row per load path, with a file of `texts` texts of `chars` characters sized to take it. */
const ROWS = [
	{ path: "the whole-file read", streaming: false, texts: 24, chars: 150_000 },
	{ path: "the streaming read", streaming: true, texts: 48, chars: 200_000 },
];

/** `chars` characters distinct per `seed`, so the loader's string pool shares none of them. */
function text(seed: number, chars: number): string {
	return `text ${seed}: `.padEnd(chars, `abcdefghij${seed}`);
}

describe("a loaded session holds no slice of its file text", () => {
	let root: TempDir;

	beforeEach(() => {
		root = TempDir.createSync("@pi-loaded-session-slice-");
	});

	afterEach(async () => {
		await root.remove();
	});

	/** A session file of one assistant message per text: a file is written once it holds a reply. */
	async function record(texts: readonly string[]): Promise<string> {
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		for (const content of texts) manager.appendMessage(createAssistantMessage(content));
		await manager.flush();
		return manager.getSessionFile() as string;
	}

	for (const row of ROWS) {
		it(
			`on ${row.path}`,
			async () => {
				const texts = Array.from({ length: row.texts }, (_, seed) => text(seed, row.chars));
				const textBytes = texts.length * row.chars;
				const file = await record(texts);
				const size = fs.statSync(file).size;
				expect(size >= STREAM_LOAD_BYTES).toBe(row.streaming);
				// A throwaway open of a small session loads every module the measured open reaches.
				await SessionManager.open(await record([text(-1, 100)]));

				const before = liveStringBytes();
				const manager = await SessionManager.open(file);
				const grown = liveStringBytes() - before;

				expect(manager.getEntries().length).toBe(texts.length);
				// The measurement sees the loaded texts, so a bound it passes is not a count that missed them.
				// Half, since strings an earlier file in the same process left behind can die in the window.
				expect(grown).toBeGreaterThan(textBytes / 2);
				// The texts once, and less than another copy of the file on top.
				expect(grown).toBeLessThan(textBytes + size / 2);
			},
			SNAPSHOT_ROW_TIMEOUT_MS,
		);
	}
});
