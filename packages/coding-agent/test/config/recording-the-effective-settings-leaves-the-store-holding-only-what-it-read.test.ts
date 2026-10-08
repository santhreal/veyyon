/**
 * Recording a session's effective settings leaves its settings store holding only the paths the
 * session reads.
 *
 * WHY: every new session, spawned agents included, records `getEffectiveSnapshot()` at start, and
 * the snapshot read each of the 472 declared paths through `get`, which memoizes the value it
 * resolves. Each spawned agent's forked store therefore held a 41 KiB resolution cache for paths it
 * never read again: 12% of the heap a live spawned session retained.
 *
 * THE CLASS THIS CLOSES. A whole-schema read through the store that memoizes what it visits. The
 * snapshot is measured against an idle store in a fresh process, beside a store that reads every
 * declared path through `get`, the memoizing shape the snapshot had; that control proves the
 * measurement sees the cache, so a snapshot that memoizes again fails the bound rather than passing
 * under it. The declared path count is read from the snapshot at run time, so a setting added to
 * the schema widens the control with it.
 *
 * NOT COVERED: a new whole-schema reader outside `getEffectiveSnapshot` that calls `get` per path;
 * it has to be added to the fixture's arms. The snapshot's values against `get` are pinned by
 * `gran-3-settings-snapshot.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { SnapshotRetention } from "../fixtures/settings-snapshot-retention";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "settings-snapshot-retention.ts");

/** Bytes per store a snapshot may leave beyond an idle store: allocator noise, not a cache. */
const SNAPSHOT_SLACK = 4 * 1024;
/** Bytes per store the memoizing control must leave beyond an idle one for the bound to mean anything. */
const CONTROL_FLOOR = 20 * 1024;

function measure(): SnapshotRetention {
	const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8", timeout: 120_000 });
	if (run.status !== 0) throw new Error(`fixture failed (${run.status}): ${run.stderr}`);
	return JSON.parse(run.stdout) as SnapshotRetention;
}

describe("recording the effective settings", () => {
	it("leaves a store no larger than an idle one, while reading every path through get does not", () => {
		const retention = measure();
		expect(retention.everyPath - retention.idle).toBeGreaterThan(CONTROL_FLOOR);
		expect(retention.snapshot - retention.idle).toBeLessThan(SNAPSHOT_SLACK);
	});
});
