/**
 * WHY:
 * `useMnemopiTestEnv()`'s `afterAll` lists the home before and after a suite and
 * fails when the set changed, which is how a leaked config root gets caught.
 * Every test process resolves the same `os.homedir()`, so under `--parallel`
 * that snapshot observes directories other processes create.
 *
 * One suite creates a home directory on purpose:
 * `the-config-root-never-lands-in-the-home.test.ts` makes
 * `DELIBERATE_HOME_CONTROL_ROOT`, asserts the detector reports it, and removes
 * it inside a single test body. A second process whose `beforeAll` sampled the
 * home during that window recorded the marker as pre-existing, and its
 * `afterAll` then failed because a root it had never created disappeared:
 *
 *     expect(homeRootsAMnemopiRunCouldCreate()).toEqual(rootsBefore)
 *     -   ".veyyon-mnemopi-config-root-control",
 *
 * The witness was an innocent suite, and which suite it was moved between runs.
 * It went red on CI for `Test TS workspace fast` while the two commits either
 * side of it were green, which is the signature of a scheduling race rather
 * than a defect in any suite.
 *
 * The contract pinned here: the cross-file snapshot ignores that one marker and
 * nothing else. Every other `.veyyon*`, `.hermes` and `.mnemopi` entry is still
 * reported, because those are the leaks the guard exists to catch.
 *
 * These cases run against a temp directory rather than the real home. Creating
 * a probe root in the shared home to test the guard would reproduce the very
 * race being fixed, in every other process running at the time.
 *
 * What this does NOT catch:
 * - A second deliberate marker added later under a different name. There is one
 *   creator today and the constant has one owner; a new one reintroduces the
 *   race and has to join the exemption.
 * - Entries created and removed between the two reads of a single snapshot.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIBERATE_HOME_CONTROL_ROOT } from "./helpers/home-isolation";
import { homeRootsAMnemopiRunCouldCreate } from "./setup";

function homeContaining(...entries: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-home-guard-"));
	for (const entry of entries) mkdirSync(join(dir, entry));
	return dir;
}

describe("the home-leak snapshot", () => {
	it("ignores the one marker a suite creates on purpose", () => {
		const dir = homeContaining(".veyyon", DELIBERATE_HOME_CONTROL_ROOT);
		try {
			expect(homeRootsAMnemopiRunCouldCreate(dir)).toEqual([".veyyon"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives the same answer whether or not that marker is present", () => {
		const withMarker = homeContaining(".veyyon", ".hermes", DELIBERATE_HOME_CONTROL_ROOT);
		const without = homeContaining(".veyyon", ".hermes");
		try {
			// This equality is the property the race violated: a suite that samples
			// the home while another process holds the marker must reach the same
			// verdict as one that samples it a moment later.
			expect(homeRootsAMnemopiRunCouldCreate(withMarker)).toEqual(homeRootsAMnemopiRunCouldCreate(without));
		} finally {
			rmSync(withMarker, { recursive: true, force: true });
			rmSync(without, { recursive: true, force: true });
		}
	});

	it("still reports every root a leak would produce", () => {
		const dir = homeContaining(
			".veyyon",
			".veyyon-mnemopi-profile-iso-123",
			".hermes",
			".mnemopi",
			DELIBERATE_HOME_CONTROL_ROOT,
			".config",
			"Documents",
		);
		try {
			// The exemption is one exact name, not a prefix: a stray root that merely
			// looks similar is still a leak.
			expect(homeRootsAMnemopiRunCouldCreate(dir)).toEqual([
				".hermes",
				".mnemopi",
				".veyyon",
				".veyyon-mnemopi-profile-iso-123",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not exempt a name that merely starts with the marker", () => {
		const dir = homeContaining(`${DELIBERATE_HOME_CONTROL_ROOT}-2`);
		try {
			expect(homeRootsAMnemopiRunCouldCreate(dir)).toEqual([`${DELIBERATE_HOME_CONTROL_ROOT}-2`]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
