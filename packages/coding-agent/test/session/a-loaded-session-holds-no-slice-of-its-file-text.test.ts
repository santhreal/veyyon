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
 * The string bytes are measured in a fresh process (`fixtures/loaded-session-string-growth.ts`): in the
 * process a suite shares, strings other files left behind die or stay alive in the window and move the
 * delta by megabytes both ways.
 *
 * DOES NOT CATCH: a slice of a text smaller than the room the bound leaves, which keeps its text
 * alive but costs less than the bound can see; and a retained copy that is not a string, such as a
 * buffer of the file's bytes, which the string count does not read.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import type { OpenGrowth } from "../fixtures/loaded-session-string-growth";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "loaded-session-string-growth.ts");

/** A fresh process loads the modules and takes two heap snapshots of its own heap. */
const MEASURED_ROW_TIMEOUT_MS = 60_000;

/** The file size at and above which the loader reads a session file in chunks rather than whole. */
const STREAM_LOAD_BYTES = 8 * 1024 * 1024;

/** One row per load path, with a file of `texts` texts of `chars` characters sized to take it. */
const ROWS = [
	{ path: "the whole-file read", streaming: false, texts: 24, chars: 150_000 },
	{ path: "the streaming read", streaming: true, texts: 48, chars: 200_000 },
];

describe("a loaded session holds no slice of its file text", () => {
	let root: TempDir;

	beforeEach(() => {
		root = TempDir.createSync("@pi-loaded-session-slice-");
	});

	afterEach(async () => {
		await root.remove();
	});

	async function openInFreshProcess(texts: number, chars: number): Promise<OpenGrowth> {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const { stdout, stderr } = await run(process.execPath, [FIXTURE, root.path(), String(texts), String(chars)], {
				env,
				timeout: MEASURED_ROW_TIMEOUT_MS - 5_000,
				killSignal: "SIGKILL",
			});
			expect(stderr).toBe("");
			return JSON.parse(stdout) as OpenGrowth;
		} finally {
			cleanup();
		}
	}

	for (const row of ROWS) {
		it(
			`on ${row.path}`,
			async () => {
				const growth = await openInFreshProcess(row.texts, row.chars);
				expect(growth.size >= STREAM_LOAD_BYTES).toBe(row.streaming);
				expect(growth.entries).toBe(row.texts);
				// The measurement sees the loaded texts, so a bound it passes is not a count that missed them.
				expect(growth.grown).toBeGreaterThan(growth.textBytes / 2);
				// The texts once, and less than another copy of the file on top.
				expect(growth.grown).toBeLessThan(growth.textBytes + growth.size / 2);
			},
			MEASURED_ROW_TIMEOUT_MS,
		);
	}
});
