/**
 * WHY THIS SUITE EXISTS:
 *
 * A result codec drops from a session file's line the details text the result's content text repeats,
 * and a load restores it as a slice of that text, so a loaded entry holds the text once. A running
 * session held what the tool returned instead: the content text and, in a string of its own, the
 * same text again in the details, for every result it recorded, for as long as it stayed open. Every
 * file a session read, every eval cell output and every job result was held twice.
 *
 * CLASS: for every codec the package ships that defines `settle` (enumerated from
 * `BUILTIN_RESULT_CODECS`), a persisting session recording that tool's results holds the repeated
 * text once, writes it once, and holds and loads details that read as the tool returned them. A
 * codec without `settle` is pinned by name with the reason it holds nothing twice, so a new codec
 * fails here until it settles or records why it does not; a new settling codec fails until it has a
 * sample result.
 *
 * The string bytes are measured in a fresh process (`fixtures/recorded-result-string-growth.ts`): in
 * the process a suite shares, strings other files left behind move the delta by more than the body.
 *
 * DOES NOT CATCH: a copy of the text a holder outside the session keeps (a tool's own state, a
 * transcript row). One result shape per tool is measured; the per-codec suites cover the shapes, and
 * their recordings check that settling leaves each value as the tool returned it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { BUILTIN_RESULT_CODECS } from "@veyyon/coding-agent/tools/index";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { setUpReadSessions } from "../fixtures/read-string-growth";
import { type RecordedGrowth, recordResults, SETTLED_RESULTS } from "../fixtures/recorded-result-string-growth";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "recorded-result-string-growth.ts");

/** A fresh process loads the modules and takes two heap snapshots of its own heap. */
const MEASURED_ROW_TIMEOUT_MS = 60_000;

/** The details of the one tool result `manager` holds, as JSON reads them. */
function heldDetails(manager: SessionManager): unknown {
	const held = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult");
	if (held?.type !== "message" || held.message.role !== "toolResult") throw new Error("tool result missing");
	return JSON.parse(JSON.stringify(held.message.details));
}

describe("a recorded result holds its text once", () => {
	let root: TempDir;

	beforeAll(async () => {
		await setUpReadSessions();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		root = TempDir.createSync("@pi-recorded-result-");
	});

	afterEach(async () => {
		await root.remove();
	});

	it("is settled by every codec but the two whose details repeat no content text a slice can share", () => {
		const settling = BUILTIN_RESULT_CODECS.filter(codec => codec.settle !== undefined).map(codec => codec.toolName);
		expect(settling.toSorted()).toEqual(Object.keys(SETTLED_RESULTS).toSorted());
		// `edit` rebuilds `newText` from `oldText` and the diff, a new string as large as the tool's own.
		// `search` returns a paths-only card as its content's own string, and a load builds a `rows` card
		// whole, as the tool returned it.
		expect(BUILTIN_RESULT_CODECS.filter(codec => codec.settle === undefined).map(codec => codec.toolName)).toEqual([
			"search",
			"edit",
		]);
	});

	for (const [tool, sample] of Object.entries(SETTLED_RESULTS)) {
		it(
			`holds the text a recorded ${tool} result repeats once`,
			async () => {
				const { env, cleanup } = hermeticSpawnEnv();
				let growth: RecordedGrowth;
				try {
					const { stdout, stderr } = await run(process.execPath, [FIXTURE, root.path(), tool], {
						env,
						timeout: MEASURED_ROW_TIMEOUT_MS - 5_000,
						killSignal: "SIGKILL",
					});
					expect(stderr).toBe("");
					growth = JSON.parse(stdout) as RecordedGrowth;
				} finally {
					cleanup();
				}
				expect(growth.entries).toBe(growth.results + 1);
				// The measurement sees the results, so a bound it passes is not a count that missed them.
				expect(growth.grown).toBeGreaterThan(growth.bodyBytes / 2);
				// A second copy of the text, in the details or anywhere else, is the repeated bytes on top.
				expect(growth.grown).toBeLessThan(growth.bodyBytes + growth.repeatedBytes / 2);
			},
			MEASURED_ROW_TIMEOUT_MS,
		);

		it(`holds, writes once and loads a recorded ${tool} result as the tool returned it`, async () => {
			const returned: ToolResultMessage = sample(0, 40);
			const manager = await recordResults(root.path(), [sample(0, 40)]);
			const expected = JSON.parse(JSON.stringify(returned.details));
			expect(heldDetails(manager)).toEqual(expected);

			const file = manager.getSessionFile() as string;
			// Row 7 is in the content text; a details copy written beside it is a second occurrence.
			expect(fs.readFileSync(file, "utf8").split("const value0_7 =").length - 1).toBe(1);
			expect(heldDetails(await SessionManager.open(file))).toEqual(expected);
		});
	}
});
