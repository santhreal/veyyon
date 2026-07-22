import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
	shouldAttemptAutoUpdate,
} from "../src/cli/auto-update-state";

const ROOTS: string[] = [];

async function mkStatePath(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-update-state-"));
	ROOTS.push(root);
	return path.join(root, "auto-update-state.json");
}

afterAll(async () => {
	for (const root of ROOTS) {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

describe("shouldAttemptAutoUpdate", () => {
	const NOW = 1_700_000_000_000;

	test("attempts when nothing has ever failed", () => {
		expect(shouldAttemptAutoUpdate({}, "1.2.3", NOW)).toBe(true);
	});

	test("does not retry the same version inside the cooldown window", () => {
		// The behavior this exists for: a machine that cannot install (binary owned
		// by root, read-only image) must not show the same red failure on every
		// single launch. Reporting it once and backing off keeps errors meaningful.
		const state = { failedVersion: "1.2.3", failedAtMs: NOW - 60_000, failedError: "EACCES" };

		expect(shouldAttemptAutoUpdate(state, "1.2.3", NOW)).toBe(false);
	});

	test("retries the same version once the cooldown has elapsed", () => {
		// The other half of the contract: a fixed permission problem must be picked
		// up without the user knowing that a backoff file exists.
		const state = { failedVersion: "1.2.3", failedAtMs: NOW - AUTO_UPDATE_FAILURE_COOLDOWN_MS, failedError: "x" };

		expect(shouldAttemptAutoUpdate(state, "1.2.3", NOW)).toBe(true);
	});

	test("retries immediately when a different version is available", () => {
		// A failed build is not proof that the next one fails, so a new release is
		// never held back by the previous one's cooldown.
		const state = { failedVersion: "1.2.3", failedAtMs: NOW - 1_000, failedError: "bad tarball" };

		expect(shouldAttemptAutoUpdate(state, "1.2.4", NOW)).toBe(true);
	});

	test("attempts when a recorded failure has no timestamp", () => {
		// A truncated or hand-edited state file must not wedge updates forever.
		expect(shouldAttemptAutoUpdate({ failedVersion: "1.2.3" }, "1.2.3", NOW)).toBe(true);
	});

	test("is exactly at the boundary inclusive, so the window cannot be off by one launch", () => {
		const state = { failedVersion: "1.2.3", failedAtMs: NOW - AUTO_UPDATE_FAILURE_COOLDOWN_MS + 1 };

		expect(shouldAttemptAutoUpdate(state, "1.2.3", NOW)).toBe(false);
	});
});

describe("auto-update state persistence", () => {
	test("a missing state file reads as no record rather than throwing", async () => {
		const statePath = await mkStatePath();

		expect(await readAutoUpdateState(statePath)).toEqual({});
	});

	test("a recorded failure round-trips with its version, time, and message", async () => {
		const statePath = await mkStatePath();

		await recordAutoUpdateFailure("1.2.3", "EACCES: permission denied", statePath, 1_700_000_000_000);

		expect(await readAutoUpdateState(statePath)).toEqual({
			failedVersion: "1.2.3",
			failedAtMs: 1_700_000_000_000,
			failedError: "EACCES: permission denied",
		});
	});

	test("clearing after a success removes the record so it cannot suppress a later attempt", async () => {
		// Without this, a machine that recovered would keep a failure on disk that
		// nothing ever removes, and the next failure would be compared against it.
		const statePath = await mkStatePath();
		await recordAutoUpdateFailure("1.2.3", "boom", statePath, 1_700_000_000_000);

		await clearAutoUpdateFailure(statePath);

		expect(await readAutoUpdateState(statePath)).toEqual({});
		expect(shouldAttemptAutoUpdate(await readAutoUpdateState(statePath), "1.2.3", 1_700_000_000_001)).toBe(true);
	});

	test("a corrupt state file reads as no record, so updates are never wedged by bad JSON", async () => {
		const statePath = await mkStatePath();
		await Bun.write(statePath, "{not json");

		expect(await readAutoUpdateState(statePath)).toEqual({});
	});

	test("recording twice replaces the window instead of accumulating", async () => {
		const statePath = await mkStatePath();

		await recordAutoUpdateFailure("1.2.3", "first", statePath, 1_000);
		await recordAutoUpdateFailure("1.2.4", "second", statePath, 2_000);

		expect(await readAutoUpdateState(statePath)).toEqual({
			failedVersion: "1.2.4",
			failedAtMs: 2_000,
			failedError: "second",
		});
	});
});
