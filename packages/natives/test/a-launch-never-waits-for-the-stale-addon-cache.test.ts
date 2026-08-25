/**
 * WHY: the prune of dead per-version addon caches used to run synchronously inside
 * `loadNative()`, between `dlopen` returning and the caller receiving its bindings —
 * which is before the first frame. Measured on the development host, deleting one
 * 150MiB cache costs 7ms, three cost 24ms, three that also hold 5000 small files cost
 * 105ms, and every millisecond of it was charged to the launch. The class is wider than
 * "cleanup is slow": ANY housekeeping placed after a successful load and before the
 * return is on the critical path, and the cost is set by whatever is on the user's disk
 * rather than by anything the product controls.
 *
 * Closed here: the loader hands the prune to the event loop, so the first native call
 * costs the same whatever the stale bytes are; the stale caches are still reclaimed;
 * the current version and any directory that is not a version cache are never touched;
 * a removal that fails is still reported with its path and its reason; and the timer
 * does not keep a finishing process alive.
 *
 * NOT closed here: whether the process lives long enough for an unref'd timer to fire.
 * A launch that exits within a tick reclaims nothing and prunes on the next run instead,
 * and `scripts/ensure-native.ts` still prunes synchronously at install time, which is
 * when a stale cache is created in the first place.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
	reclaimStaleNativeVersions,
	scheduleStaleNativeCleanup,
	staleNativeVersionDirs,
} from "../native/loader-state.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const INDEX_URL = `file://${path.resolve(import.meta.dir, "..", "native", "index.js")}`;

/** A natives root holding one cache per named version, each with an addon-shaped file. */
function seedRoot(versions: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-natives-defer-"));
	for (const version of versions) {
		const dir = path.join(root, version);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "veyyon_natives.linux-x64-modern.node"), "addon bytes");
	}
	return root;
}

/** The scheduler's callback, captured instead of run, with the handle it was given. */
function captureSchedule(): {
	schedule: (callback: () => void, delayMs: number) => { unref: () => void };
	fire: () => void;
	calls: number;
	unrefs: number;
	delays: number[];
} {
	const captured: (() => void)[] = [];
	const state = {
		schedule: (callback: () => void, delayMs: number) => {
			captured.push(callback);
			state.calls += 1;
			state.delays.push(delayMs);
			return {
				unref: () => {
					state.unrefs += 1;
				},
			};
		},
		fire: () => {
			for (const callback of captured.splice(0)) callback();
		},
		calls: 0,
		unrefs: 0,
		delays: [] as number[],
	};
	return state;
}

describe("the stale addon cache is reclaimed off the launch path", () => {
	it("removes nothing while the caller is still waiting, and everything once the event loop is free", async () => {
		const root = seedRoot(["1.2.0", "1.1.0", "1.0.35"]);
		try {
			const scheduler = captureSchedule();
			const scheduled = scheduleStaleNativeCleanup({
				nativesDir: root,
				currentVersion: "1.2.0",
				schedule: scheduler.schedule,
			});

			expect(scheduler.calls).toBe(1);
			expect(fs.existsSync(path.join(root, "1.1.0"))).toBe(true);
			expect(fs.existsSync(path.join(root, "1.0.35"))).toBe(true);

			scheduler.fire();
			const pruned = await scheduled.settled;

			expect(pruned.removed.map(dir => path.basename(dir)).sort()).toEqual(["1.0.35", "1.1.0"]);
			expect(pruned.failed).toEqual([]);
			expect(fs.existsSync(path.join(root, "1.1.0"))).toBe(false);
			expect(fs.existsSync(path.join(root, "1.0.35"))).toBe(false);
			expect(fs.existsSync(path.join(root, "1.2.0"))).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not keep a finishing process alive to reclaim disk", () => {
		const root = seedRoot(["1.2.0", "1.1.0"]);
		try {
			const scheduler = captureSchedule();
			scheduleStaleNativeCleanup({ nativesDir: root, currentVersion: "1.2.0", schedule: scheduler.schedule });
			expect(scheduler.unrefs).toBe(1);
			// Handed over at once rather than parked on a delay somebody has to justify.
			expect(scheduler.delays).toEqual([0]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a cache it could not remove, with the path and the reason", async () => {
		const root = seedRoot(["1.2.0", "1.1.0"]);
		const stuck = path.join(root, "1.1.0");
		try {
			const scheduler = captureSchedule();
			const reported: string[] = [];
			const scheduled = scheduleStaleNativeCleanup({
				nativesDir: root,
				currentVersion: "1.2.0",
				schedule: scheduler.schedule,
				reclaim: async () => ({ removed: [], failed: [{ dir: stuck, reason: "EPERM: operation not permitted" }] }),
				report: message => reported.push(message),
			});
			scheduler.fire();
			await scheduled.settled;

			expect(reported).toHaveLength(1);
			expect(reported[0]).toContain(stuck);
			expect(reported[0]).toContain("EPERM: operation not permitted");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("selects the same directories for the deferred prune as for the install-time one", async () => {
		// One owner for "which directory is dead": the two prunes differ in WHEN they run and
		// in which thread does the unlink, never in what they are allowed to delete. A drift
		// here is how an install-time rule (leave `tmp-download`, leave `1.2.0`) stops holding
		// at runtime, on a root the user can relocate with $XDG_DATA_HOME.
		const layout = ["1.2.0", "1.1.0", "0.9.13", "1.1.0-rc.2"];
		const extras = ["tmp-download", "backup", "node_modules"];

		const forSelection = seedRoot(layout);
		for (const extra of extras) fs.mkdirSync(path.join(forSelection, extra), { recursive: true });
		const selected = staleNativeVersionDirs({ nativesDir: forSelection, currentVersion: "1.2.0" }).sort();
		fs.rmSync(forSelection, { recursive: true, force: true });

		const forSync = seedRoot(layout);
		for (const extra of extras) fs.mkdirSync(path.join(forSync, extra), { recursive: true });
		const sync = cleanupStaleNativeVersions({ nativesDir: forSync, currentVersion: "1.2.0" });
		const syncSurvivors = fs.readdirSync(forSync).sort();
		fs.rmSync(forSync, { recursive: true, force: true });

		const forAsync = seedRoot(layout);
		for (const extra of extras) fs.mkdirSync(path.join(forAsync, extra), { recursive: true });
		const deferred = await reclaimStaleNativeVersions({ nativesDir: forAsync, currentVersion: "1.2.0" });
		const asyncSurvivors = fs.readdirSync(forAsync).sort();
		fs.rmSync(forAsync, { recursive: true, force: true });

		expect(selected.map(dir => path.basename(dir))).toEqual(["0.9.13", "1.1.0", "1.1.0-rc.2"]);
		expect(sync.removed.map(dir => path.basename(dir)).sort()).toEqual(selected.map(dir => path.basename(dir)));
		expect(deferred.removed.map(dir => path.basename(dir)).sort()).toEqual(selected.map(dir => path.basename(dir)));
		expect(sync.failed).toEqual([]);
		expect(deferred.failed).toEqual([]);
		expect(asyncSurvivors).toEqual(syncSurvivors);
		expect(asyncSurvivors).toEqual(["1.2.0", "backup", "node_modules", "tmp-download"]);
	});

	it("a missing natives root is nothing to prune, on either path", async () => {
		const absent = path.join(os.tmpdir(), `veyyon-natives-absent-${process.pid}`);
		expect(staleNativeVersionDirs({ nativesDir: absent, currentVersion: "1.2.0" })).toEqual([]);
		expect(cleanupStaleNativeVersions({ nativesDir: absent, currentVersion: "1.2.0" })).toEqual({
			removed: [],
			failed: [],
		});
		expect(await reclaimStaleNativeVersions({ nativesDir: absent, currentVersion: "1.2.0" })).toEqual({
			removed: [],
			failed: [],
		});
	});

	it("a real addon load returns with the stale caches still on disk", async () => {
		// The production path, driven the way anything reaching a native call drives it: a
		// child process with its data home pointed at a seeded root, loading the built addon
		// through the shipped lazy accessor. If the prune is synchronous again, the directories
		// are gone by the time the call returns and this goes red.
		const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-natives-e2e-"));
		const root = path.join(dataHome, "veyyon", "natives");
		for (const version of ["1.1.0", "1.0.35"]) {
			fs.mkdirSync(path.join(root, version), { recursive: true });
			fs.writeFileSync(path.join(root, version, "veyyon_natives.linux-x64-modern.node"), "addon bytes");
		}
		try {
			const probe = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { getSupportedLanguages } from ${JSON.stringify(INDEX_URL)};` +
						`import * as fs from "node:fs";` +
						`const languages = getSupportedLanguages();` +
						`if (!Array.isArray(languages) || languages.length === 0) throw new Error("addon did not load");` +
						// Directories only: the loader also persists its AVX2 verdict as a
						// sibling file in this root, and the caches are what must survive.
						`process.stdout.write(JSON.stringify(fs.readdirSync(${JSON.stringify(root)}, { withFileTypes: true })` +
						`.filter(e => e.isDirectory()).map(e => e.name).sort()));`,
				],
				{
					cwd: REPO_ROOT,
					env: { ...process.env, XDG_DATA_HOME: dataHome },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(probe.stdout).text(),
				new Response(probe.stderr).text(),
				probe.exited,
			]);
			// A nonzero exit carries the probe's own stderr, so a load failure reads as itself.
			expect(code === 0 ? "loaded" : stderr).toBe("loaded");
			expect(JSON.parse(stdout)).toEqual(["1.0.35", "1.1.0"]);
		} finally {
			fs.rmSync(dataHome, { recursive: true, force: true });
		}
	});
});
