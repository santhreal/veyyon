/**
 * WHY THIS SUITE EXISTS:
 *
 * A rebuilt transcript builds one component per assistant turn and one card per tool call, and each
 * constructed its keyed collections up front: an assistant turn two Maps and a Set for tool result
 * images, a card a WeakMap of rail frames, a Map of converted images and a Set of failed conversions,
 * and its block producer a Set of listeners. Almost no turn shows an image, so a rebuilt 26,806-entry
 * session held 37,211 Maps, 29,120 Sets and 7,858 WeakMaps; with the collections made on first use it
 * holds 2,547, 1 and 0, and the rebuild retains 64.1 MiB instead of 68.3 MiB.
 *
 * CLASS: a turn that has nothing to put in a keyed collection leaves none live once its transcript is
 * rebuilt and drawn. Every tool the build ships is swept from `BUILTIN_TOOL_NAMES` and
 * `HIDDEN_TOOL_NAMES`, with a plain conversation turn beside them, so a tool added later is measured
 * too. A read whose result carries an image is the control: its assistant turn fills an image table,
 * which the measurement has to see as one collection per turn.
 *
 * Counts are taken in a fresh process (`fixtures/transcript-collection-growth.ts`), since a suite that
 * shares a process sees collections other files left behind.
 *
 * DOES NOT CATCH: an eager plain object or array a component allocates per turn (only Map, Set,
 * WeakMap and WeakSet are counted); a collection a tool card allocates only for arguments or results
 * of a shape the sweep does not draw; a collection allocated per turn and released before the frame
 * ends, which costs time and never stays live.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { IMAGE_READ, SUBJECTS } from "../../../fixtures/transcript-collection-growth";
import { hermeticSpawnEnv } from "../../../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "..", "..", "fixtures", "transcript-collection-growth.ts");

/** A fresh process loads every tool's card and rebuilds three transcripts per subject. */
const MEASURED_TIMEOUT_MS = 90_000;

describe("a transcript turn allocates no collection it leaves empty", () => {
	it(
		"leaves no Map, Set, WeakMap or WeakSet live for a turn without an image, and one for a turn with one",
		async () => {
			const { env, cleanup } = hermeticSpawnEnv();
			let perTurn: Record<string, number>;
			try {
				const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
					env,
					timeout: MEASURED_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				perTurn = JSON.parse(stdout) as Record<string, number>;
			} finally {
				cleanup();
			}
			// Every subject was measured, the swept tools included.
			expect(Object.keys(perTurn)).toEqual([...SUBJECTS]);
			// The control: a turn that has an image keeps it in one table, so the count sees a table a turn fills.
			expect(perTurn[IMAGE_READ]).toBe(1);
			const holding = SUBJECTS.filter(subject => subject !== IMAGE_READ && perTurn[subject] !== 0).map(
				subject => `${subject}: ${perTurn[subject]}`,
			);
			expect(holding).toEqual([]);
		},
		MEASURED_TIMEOUT_MS,
	);
});
