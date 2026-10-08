/**
 * WHY THIS SUITE EXISTS:
 *
 * A session file stores a read card's text only as a tag naming how the result's numbered rows
 * rebuild it (`a-session-file-stores-a-read-card-once`). Loading the session rebuilt every tagged card
 * text at once, as a rope over one sliced string per row, and the transcript copied each into its read
 * row. With read previews off, which is the default, no card ever draws that text, so a resumed
 * session held a second copy of every file it had read, in several string cells per row, for as long
 * as it stayed open: 50 MiB and 1.67 million cells on a 2627-read session. A running session held the
 * same second copy of every read it recorded, as the card text the tool returned beside the rows: all
 * 180 reads of a 120-turn session held their file twice.
 *
 * CLASS: a `rows` card text is built on first read and never before it, however its result reached
 * the session. For every arrival `ARRIVALS` names (a load of a written session, a running session
 * recording what the tool returned) and every step `STEPS` names (nothing more, a rewrite of every
 * read), rebuilding the transcript with previews off keeps no copy of the rows, whatever form the copy
 * takes (a rope, a flat join, the card text the tool returned, a copy the read row takes), and a
 * rewrite writes an unchanged result's card as its tag; rebuilding with previews on draws the rows;
 * and a result whose content is replaced afterwards (a prune, a shake, a compaction elision) still
 * writes the card text it was built from. A new arrival or step is measured too.
 *
 * The string bytes are measured in a fresh process (`fixtures/read-string-growth.ts`): in the process
 * a suite shares, strings other files left behind die or stay alive in the window and moved the delta
 * by more than the body both ways.
 *
 * DOES NOT CATCH: a consumer outside the transcript rebuild and the session writer that reads
 * `displayContent.text` of every result, which builds every card text again; the bound here covers
 * only the arrival, the rebuild and a rewrite. A session that writes no file keeps a recorded read as
 * the tool returned it. A `prefix` card text is a slice of the result's text and is built eagerly, as
 * it costs one string cell.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import {
	ARRIVALS,
	type Arrival,
	fileRows,
	type Growth,
	readResult,
	rebuiltBuilder,
	rowsTags,
	STEPS,
	type Step,
	setUpReadSessions,
} from "../fixtures/read-string-growth";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "read-string-growth.ts");

/** A fresh process loads the modules and takes two heap snapshots of its own heap. */
const MEASURED_PROCESS_TIMEOUT_MS = 55_000;

/** At most two measuring processes run per row. */
const MEASURED_ROW_TIMEOUT_MS = 2 * MEASURED_PROCESS_TIMEOUT_MS + 10_000;

/**
 * Live string bytes above the session's one copy of each result, as a share of the read bodies. A
 * second copy of the rows, in any form, is another body's worth on top.
 */
const SECOND_COPY_BOUND = 1.5;

const ARRIVAL_NAMES: Record<Arrival, string> = {
	load: "a loaded read",
	record: "a recorded read",
};

const STEP_NAMES: Record<Step, string> = {
	open: "its transcript rebuilds with previews off",
	rewrite: "the session rewrites every entry after its first",
};

const ARRIVAL_KEYS = Object.keys(ARRIVALS) as Arrival[];

describe("a read holds no card text until it is drawn", () => {
	let root: TempDir;

	beforeAll(async () => {
		await setUpReadSessions();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		root = TempDir.createSync("@pi-read-card-text-");
	});

	afterEach(async () => {
		await root.remove();
	});

	async function measureInFreshProcess(arrival: Arrival, step: Step): Promise<Growth> {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const { stdout, stderr } = await run(process.execPath, [FIXTURE, root.path(), arrival, step], {
				env,
				timeout: MEASURED_PROCESS_TIMEOUT_MS,
				killSignal: "SIGKILL",
			});
			expect(stderr).toBe("");
			return JSON.parse(stdout) as Growth;
		} finally {
			cleanup();
		}
	}

	/**
	 * The reading of `arrival` then `step`: one fresh process, or the lesser of two when the first
	 * reads over the bound. A string the conservative stack scan keeps alive only ever adds bytes, and
	 * one CI run in many read 1.62 bodies where every other run reads 1.002, so a second process is
	 * the reading `liveStringBytes` takes the least of its samples for. A held second copy is held in
	 * every process and reads over the bound in both.
	 */
	async function leastGrowth(arrival: Arrival, step: Step): Promise<Growth> {
		const first = await measureInFreshProcess(arrival, step);
		if (first.grown < first.bodyBytes * SECOND_COPY_BOUND) return first;
		const second = await measureInFreshProcess(arrival, step);
		return second.grown < first.grown ? second : first;
	}

	/** The session `arrival` brings `results` into, under the suite's directory. */
	async function arrived(
		arrival: Arrival,
		results: () => ToolResultMessage<ReadToolDetails>[],
	): Promise<SessionManager> {
		return (await ARRIVALS[arrival](root.path(), results))();
	}

	for (const arrival of ARRIVAL_KEYS) {
		for (const step of Object.keys(STEPS) as Step[]) {
			it(
				`keeps no copy of the rows of ${ARRIVAL_NAMES[arrival]} after ${STEP_NAMES[step]}`,
				async () => {
					const growth = await leastGrowth(arrival, step);
					expect(growth.entries).toBe(growth.reads + 1);
					// The measurement sees the results, so a bound it passes is not a count that missed them.
					expect(growth.grown).toBeGreaterThan(growth.bodyBytes / 2);
					// The session holds each result's text once.
					expect(growth.grown).toBeLessThan(growth.bodyBytes * SECOND_COPY_BOUND);
					// Every card is written as its tag, so the rebuild from the tag is the path under test.
					expect(growth.tags).toBe(growth.reads);
				},
				MEASURED_ROW_TIMEOUT_MS,
			);
		}

		it(`draws the rows of ${ARRIVAL_NAMES[arrival]} when read previews are on`, async () => {
			const manager = await arrived(arrival, () => [readResult(0, 3).result]);
			expect(rowsTags(manager.getSessionFile() as string)).toBe(1);
			const builder = rebuiltBuilder(manager, true);
			const drawn = builder.container.render(160).map(line => stripVTControlCharacters(line));
			builder.reset();
			for (const row of fileRows(0, 3)) {
				expect(drawn.some(line => line.includes(row.trim()))).toBe(true);
			}
			// The rows drawn are the card's, not the numbered rows the model read.
			expect(drawn.some(line => /\d:\s*const value0_/.test(line))).toBe(false);
		});

		it(`writes the card text of ${ARRIVAL_NAMES[arrival]} once the result's content is replaced`, async () => {
			const cardText = readResult(0, 40).result.details?.displayContent?.text;
			const manager = await arrived(arrival, () => [readResult(0, 40).result]);
			const file = manager.getSessionFile() as string;
			expect(rowsTags(file)).toBe(1);
			const held = manager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "toolResult");
			if (held?.type !== "message" || held.message.role !== "toolResult") throw new Error("read result missing");
			// What a prune leaves in place of the rows.
			held.message.content = [{ type: "text", text: "[Output truncated - 900 tokens]" }];
			await manager.rewriteEntries();

			const written = fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(line => line.includes('"toolResult"'))
				.map(line => JSON.parse(line) as { message: ToolResultMessage<ReadToolDetails> });
			expect(written.map(entry => entry.message.details?.displayContent)).toEqual([
				{ text: cardText, startLine: 1 },
			]);
		});
	}
});
