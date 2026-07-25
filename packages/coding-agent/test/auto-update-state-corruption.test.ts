import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	normalizeAutoUpdateState,
	readAutoUpdateState,
	shouldAttemptAutoUpdate,
} from "../src/cli/auto-update-state";

/**
 * UPD-6: a corrupt `auto-update-state.json` must never crash a launch, and must
 * never quietly stop the machine from updating.
 *
 * The sibling suite `auto-update-state.test.ts` covers the happy path: record a
 * failure, back off for the cooldown, clear on success. This suite covers what
 * happens when the file on disk is not what the code assumes, which is the case
 * that actually reaches users. The file is written by a background task that can
 * be killed mid-write, it sits in a directory a user may edit by hand, and it
 * records a timestamp taken from a clock that is sometimes wrong.
 *
 * Two failure directions matter, and they are not symmetric:
 *
 *  - Attempting when we should have waited costs one wasted install attempt.
 *  - Waiting when we should have attempted costs EVERY future update, silently,
 *    with nothing in the UI to explain it.
 *
 * So every uncertain input must resolve to "attempt". The specific bug this
 * suite locks out is the second kind: `failedAtMs` holding a non-number or a
 * future timestamp made `nowMs - failedAtMs >= COOLDOWN` false forever, so a
 * single corrupt field disabled auto-updates permanently and invisibly.
 */
describe("a corrupt auto-update state never crashes a launch nor stops updates", () => {
	const ROOTS: string[] = [];
	const NOW = 1_700_000_000_000;

	async function stateFileContaining(contents: string): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-update-corrupt-"));
		ROOTS.push(root);
		const statePath = path.join(root, "auto-update-state.json");
		await fs.writeFile(statePath, contents);
		return statePath;
	}

	afterAll(async () => {
		for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	});

	describe("shape validation", () => {
		test("keeps every well-typed field exactly as written", () => {
			// The baseline the rejections below are meaningful against: normalization
			// must not be quietly dropping good data.
			expect(normalizeAutoUpdateState({ failedVersion: "1.2.3", failedAtMs: NOW, failedError: "EACCES" })).toEqual({
				failedVersion: "1.2.3",
				failedAtMs: NOW,
				failedError: "EACCES",
			});
		});

		test("rejects valid JSON that is not a record, which a bare parse would have typed away", () => {
			// `42`, `"hello"` and `[1, 2]` all parse successfully. A cast to the state
			// type made them look like state and let them reach the backoff arithmetic.
			expect(normalizeAutoUpdateState(42)).toBeUndefined();
			expect(normalizeAutoUpdateState("hello")).toBeUndefined();
			expect(normalizeAutoUpdateState([1, 2])).toBeUndefined();
			expect(normalizeAutoUpdateState(null)).toBeUndefined();
			expect(normalizeAutoUpdateState(true)).toBeUndefined();
		});

		test("drops individual fields of the wrong type rather than carrying them", () => {
			// A partially hand-edited file is more likely than a wholly corrupt one, and
			// carrying one bad field is exactly how NaN got into the comparison.
			expect(
				normalizeAutoUpdateState({ failedVersion: 123, failedAtMs: "yesterday", failedError: { msg: "x" } }),
			).toEqual({});
		});

		test("drops a non-finite failedAtMs, which survives a typeof number check", () => {
			// `NaN` and the infinities are numbers. They compare false against every
			// threshold, so keeping one is indistinguishable from a permanent backoff.
			expect(normalizeAutoUpdateState({ failedVersion: "1.2.3", failedAtMs: Number.NaN })).toEqual({
				failedVersion: "1.2.3",
			});
			expect(normalizeAutoUpdateState({ failedVersion: "1.2.3", failedAtMs: Number.POSITIVE_INFINITY })).toEqual({
				failedVersion: "1.2.3",
			});
			// The version surviving in both cases is the point: one bad field must not
			// discard the whole record.
			expect(normalizeAutoUpdateState({ failedVersion: "1.2.3", failedAtMs: Number.NEGATIVE_INFINITY })).toEqual({
				failedVersion: "1.2.3",
			});
		});
	});

	describe("reading a damaged file", () => {
		test("truncated JSON reads as empty state instead of throwing", async () => {
			// The realistic corruption: the process was killed partway through the write.
			const statePath = await stateFileContaining('{"failedVersion":"1.2.3","failedAt');
			expect(await readAutoUpdateState(statePath)).toEqual({});
		});

		test("a corrupt file is RESET on disk, not merely ignored", async () => {
			// Left in place it would be re-read, re-warned and re-discarded on every
			// launch: a permanent warning nobody can act on. One rewrite returns the
			// machine to the ordinary first-run state.
			const statePath = await stateFileContaining("not json at all");
			await readAutoUpdateState(statePath);
			expect(await fs.readFile(statePath, "utf8")).toBe("{}");
			// And the reset file reads back cleanly, so the heal is complete rather than
			// leaving a second unreadable shape behind.
			expect(await readAutoUpdateState(statePath)).toEqual({});
		});

		test("a JSON array resets too, since it is parseable but not state", async () => {
			const statePath = await stateFileContaining('["failedVersion","1.2.3"]');
			expect(await readAutoUpdateState(statePath)).toEqual({});
			expect(await fs.readFile(statePath, "utf8")).toBe("{}");
		});

		test("a missing file is the normal first-run case and is left absent", async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-update-corrupt-"));
			ROOTS.push(root);
			const statePath = path.join(root, "auto-update-state.json");
			expect(await readAutoUpdateState(statePath)).toEqual({});
			// Nothing is created: a first launch must not write a file it has no
			// information for, which would make "never attempted" indistinguishable from
			// "attempted and succeeded".
			expect(await fs.exists(statePath)).toBe(false);
		});

		test("a well-formed file with an extra unknown key still reads its known fields", async () => {
			// Forward compatibility: a newer version's file must not reset an older
			// version's backoff, which would turn every downgrade into an update storm.
			const statePath = await stateFileContaining(
				JSON.stringify({ failedVersion: "9.9.9", failedAtMs: NOW, failedError: "boom", futureField: 1 }),
			);
			expect(await readAutoUpdateState(statePath)).toEqual({
				failedVersion: "9.9.9",
				failedAtMs: NOW,
				failedError: "boom",
			});
		});
	});

	describe("the backoff decision fails toward attempting", () => {
		test("a future failedAtMs attempts rather than suppressing until real time catches up", () => {
			// The permanent-silent-disable bug, stated directly. A clock that was wrong
			// when the failure was recorded and has since been corrected leaves a
			// timestamp in the future; the subtraction goes negative and the comparison
			// never becomes true again.
			const state = { failedVersion: "1.2.3", failedAtMs: NOW + AUTO_UPDATE_FAILURE_COOLDOWN_MS * 1000 };
			expect(shouldAttemptAutoUpdate(state, "1.2.3", NOW)).toBe(true);
		});

		test("a failedAtMs one millisecond in the future already attempts", () => {
			// The boundary, so the guard cannot be written as a loose "far future" check
			// that still suppresses ordinary small skew.
			expect(shouldAttemptAutoUpdate({ failedVersion: "1.2.3", failedAtMs: NOW + 1 }, "1.2.3", NOW)).toBe(true);
		});

		test("a NaN failedAtMs attempts, since it compares false against every threshold", () => {
			expect(shouldAttemptAutoUpdate({ failedVersion: "1.2.3", failedAtMs: Number.NaN }, "1.2.3", NOW)).toBe(true);
		});

		test("the ordinary in-window backoff is unaffected by any of the above", () => {
			// The guard must not have widened into "always attempt", which would restore
			// the every-launch red error the cooldown exists to prevent.
			expect(shouldAttemptAutoUpdate({ failedVersion: "1.2.3", failedAtMs: NOW - 60_000 }, "1.2.3", NOW)).toBe(
				false,
			);
			expect(
				shouldAttemptAutoUpdate(
					{ failedVersion: "1.2.3", failedAtMs: NOW - AUTO_UPDATE_FAILURE_COOLDOWN_MS },
					"1.2.3",
					NOW,
				),
			).toBe(true);
		});
	});
});
