import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChangelogEntry,
	compareVersions,
	decideUpdateNotice,
	parseChangelog,
	parseChangelogVersion,
} from "@veyyon/coding-agent/utils/changelog";

/**
 * The version helpers behind the startup update notice had no direct test. decideUpdateNotice is
 * the sole gate on whether a launch announces an upgrade, and its "exactly once per upgrade, silent
 * on fresh install / downgrade / dev build" contract is easy to break subtly. These pin the parse,
 * compare, and decide logic against the exact matrix, plus parseChangelog's heading scan. Empirically
 * verified against the source, including two behaviors that surprise a casual reader and are locked
 * here on purpose: compareVersions returns the signed *difference* (not clamped to +/-1), and the
 * fast-path equality check is a raw string compare that runs before any parse.
 */

const entry = (major: number, minor: number, patch: number): ChangelogEntry => ({ major, minor, patch, content: "" });

describe("compareVersions", () => {
	it("orders by major, then minor, then patch and returns the signed difference", () => {
		expect(compareVersions(entry(1, 2, 3), entry(1, 2, 3))).toBe(0);
		expect(compareVersions(entry(2, 0, 0), entry(1, 9, 9))).toBeGreaterThan(0);
		expect(compareVersions(entry(1, 2, 3), entry(1, 3, 0))).toBeLessThan(0);
		// Not clamped to +/-1: the patch delta passes through directly.
		expect(compareVersions(entry(1, 2, 5), entry(1, 2, 3))).toBe(2);
	});
});

describe("parseChangelogVersion", () => {
	it("parses a plain x.y.z marker into numeric parts with empty content", () => {
		expect(parseChangelogVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, content: "" });
	});

	it("returns undefined for anything that is not exactly x.y.z", () => {
		expect(parseChangelogVersion("v1.2.3")).toBeUndefined();
		expect(parseChangelogVersion("1.2")).toBeUndefined();
		expect(parseChangelogVersion("1.2.3-beta")).toBeUndefined();
		expect(parseChangelogVersion(undefined)).toBeUndefined();
	});
});

describe("decideUpdateNotice", () => {
	it("stays silent but records the version on a fresh install (no readable marker)", () => {
		expect(decideUpdateNotice(undefined, "1.2.3")).toEqual({
			installedVersion: undefined,
			persistCurrentVersion: true,
		});
		expect(decideUpdateNotice("dev", "1.2.3")).toEqual({ installedVersion: undefined, persistCurrentVersion: true });
	});

	it("stays silent and does not re-persist on an ordinary restart (marker equals running version)", () => {
		expect(decideUpdateNotice("1.2.3", "1.2.3")).toEqual({
			installedVersion: undefined,
			persistCurrentVersion: false,
		});
	});

	it("announces exactly the running version on an upgrade", () => {
		expect(decideUpdateNotice("1.2.3", "1.3.0")).toEqual({ installedVersion: "1.3.0", persistCurrentVersion: true });
	});

	it("stays silent but advances the marker on a downgrade", () => {
		expect(decideUpdateNotice("1.3.0", "1.2.3")).toEqual({
			installedVersion: undefined,
			persistCurrentVersion: true,
		});
	});

	it("stays silent and does NOT advance the marker when the running version is a dev/prerelease build", () => {
		// Advancing to a non-x.y.z build would swallow the notice for the next real release.
		expect(decideUpdateNotice("1.2.3", "1.3.0-rc")).toEqual({
			installedVersion: undefined,
			persistCurrentVersion: false,
		});
	});

	it("treats a re-formatted but numerically equal version as a no-announce upgrade path", () => {
		// The string fast-path misses (01.2.3 !== 1.2.3), but the numeric compare is 0, so <= 0 wins:
		// silent, marker advanced.
		expect(decideUpdateNotice("1.2.3", "01.2.3")).toEqual({
			installedVersion: undefined,
			persistCurrentVersion: true,
		});
	});
});

describe("parseChangelog heading scan", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "veyyon-changelog-"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("collects each ## [x.y.z] block until the next heading, keeping the header line and trimming", async () => {
		const path = join(dir, "CHANGELOG.md");
		await Bun.write(
			path,
			"# Changelog\n\n## [1.3.0] - 2026\n- feature A\n- feature B\n\n## 1.2.0\n- old\n\n## [unreleased]\n- ignored\n",
		);
		expect(await parseChangelog(path)).toEqual([
			{ major: 1, minor: 3, patch: 0, content: "## [1.3.0] - 2026\n- feature A\n- feature B" },
			{ major: 1, minor: 2, patch: 0, content: "## 1.2.0\n- old" },
		]);
	});

	it("returns [] for an undefined path and for a missing file rather than throwing", async () => {
		expect(await parseChangelog(undefined)).toEqual([]);
		expect(await parseChangelog(join(dir, "does-not-exist.md"))).toEqual([]);
	});
});
