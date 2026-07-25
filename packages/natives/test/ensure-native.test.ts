/**
 * Locks the source-install addon provisioning contract (ensure-native.ts).
 *
 * Why this suite exists: a fresh clone or a bare `git pull` has no built
 * native addon (it is gitignored), and veyyon died at boot with a raw
 * resolve-error dump (user-hit 2026-07-24) because nothing on the shipped
 * source path ever produced one. ensure-native.ts is the single owner of
 * provisioning; these tests prove its two load-bearing judgments:
 * which filenames satisfy this host, and when a present file counts as
 * CURRENT (version-sentinel match) versus stale-and-must-refresh.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { versionedNativeCacheDir, versionSentinelExportFor } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };
import { addonCopyPlan, addonIsCurrent, hostAddonFilenames } from "../scripts/ensure-native";

const version: string = packageJson.version;

function tmpFile(content: Buffer | string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-native-"));
	const file = path.join(dir, "veyyon_natives.test.node");
	fs.writeFileSync(file, content);
	return file;
}

describe("hostAddonFilenames", () => {
	test("covers this host's platform-arch tag, with the default filename as the last resort", () => {
		// The regression this locks out: a filename set that misses the addon
		// the build actually produced, so a present addon still "counts as
		// missing" and gets re-provisioned every launch.
		const names = hostAddonFilenames();
		const tag = `${process.platform}-${process.arch}`;
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name.startsWith(`veyyon_natives.${tag}`)).toBe(true);
			expect(name.endsWith(".node")).toBe(true);
		}
		expect(names).toContain(`veyyon_natives.${tag}.node`);
	});

	test("on x64 hosts both CPU variants are candidates (modern and baseline)", () => {
		if (process.arch !== "x64") return;
		const tag = `${process.platform}-x64`;
		const names = hostAddonFilenames();
		expect(names).toContain(`veyyon_natives.${tag}-modern.node`);
		expect(names).toContain(`veyyon_natives.${tag}-baseline.node`);
	});
});

describe("addonIsCurrent", () => {
	test("accepts a file embedding this checkout's version sentinel", () => {
		const file = tmpFile(
			Buffer.concat([
				Buffer.from("\x00binary\x00"),
				Buffer.from(versionSentinelExportFor(version)),
				Buffer.from("\x00tail"),
			]),
		);
		expect(addonIsCurrent(file)).toBe(true);
	});

	test("rejects a stale addon from the previous release (sentinel mismatch)", () => {
		// The regression this locks out: `veyyon update` advances the checkout
		// but keeps last release's addon on disk; the boot-time sentinel check
		// then kills the session. A stale file must read as NOT current so the
		// updater's ensure step refreshes it.
		const [major = "1", minor = "0", patch = "0"] = version.split(".");
		const previous = `${major}.${minor}.${Math.max(0, Number(patch) - 1)}`;
		const file = tmpFile(Buffer.from(versionSentinelExportFor(previous)));
		expect(addonIsCurrent(file)).toBe(false);
	});

	test("rejects a missing file instead of throwing", () => {
		expect(addonIsCurrent("/nonexistent/veyyon_natives.nope.node")).toBe(false);
	});

	test("rejects an empty or corrupt download remnant", () => {
		expect(addonIsCurrent(tmpFile(""))).toBe(false);
		expect(addonIsCurrent(tmpFile("veyyon_natives but no sentinel"))).toBe(false);
	});
});

describe("addonCopyPlan", () => {
	// Why this suite exists: after INSTALL-NATIVE-CACHE-NOT-CONSULTED the loader
	// reads the per-version cache as a source-path fallback. ensure keeps native/
	// and the cache in sync with ONE direction-agnostic planner: mirror
	// (native -> cache) populates the loader's fallback, and restore
	// (cache -> native) seeds a fresh/offline source tree. This plan is the
	// decision of exactly WHAT to copy in either direction.
	const nativeDir = "/repo/packages/natives/native";
	const cacheDir = "/home/u/.veyyon/natives/1.0.37";
	const names = ["veyyon_natives.linux-x64-modern.node", "veyyon_natives.linux-x64-baseline.node"];

	test("mirror direction: copies a current in-tree addon whose cache copy is missing", () => {
		const plan = addonCopyPlan({
			filenames: names,
			fromDir: nativeDir,
			toDir: cacheDir,
			fromIsCurrent: () => true,
			toIsCurrent: () => false,
		});
		expect(plan).toEqual([
			{ src: path.join(nativeDir, names[0]), dest: path.join(cacheDir, names[0]) },
			{ src: path.join(nativeDir, names[1]), dest: path.join(cacheDir, names[1]) },
		]);
	});

	test("restore direction: seeds native/ from a warm cache when native/ is empty (offline boot)", () => {
		// The launcher's self-heal must succeed with no network: a warm cache copy
		// is restored INTO native/. Same planner, from/to swapped.
		const plan = addonCopyPlan({
			filenames: names,
			fromDir: cacheDir,
			toDir: nativeDir,
			fromIsCurrent: () => true,
			toIsCurrent: () => false,
		});
		expect(plan).toEqual([
			{ src: path.join(cacheDir, names[0]), dest: path.join(nativeDir, names[0]) },
			{ src: path.join(cacheDir, names[1]), dest: path.join(nativeDir, names[1]) },
		]);
	});

	test("skips a filename whose destination copy is already current (no redundant 150MB copy)", () => {
		// The steady state on every launch: both sides populated, so the plan is
		// empty — ensure must not re-copy the binaries each boot.
		const plan = addonCopyPlan({
			filenames: names,
			fromDir: nativeDir,
			toDir: cacheDir,
			fromIsCurrent: () => true,
			toIsCurrent: () => true,
		});
		expect(plan).toEqual([]);
	});

	test("skips a filename whose source copy is missing or stale (nothing valid to copy)", () => {
		// Only the modern variant is present at the source; the baseline must not be
		// copied from a source that is not current, or the destination would gain a
		// stale/absent file the loader's sentinel check would later reject.
		const plan = addonCopyPlan({
			filenames: names,
			fromDir: nativeDir,
			toDir: cacheDir,
			fromIsCurrent: file => file.endsWith(names[0]),
			toIsCurrent: () => false,
		});
		expect(plan).toEqual([{ src: path.join(nativeDir, names[0]), dest: path.join(cacheDir, names[0]) }]);
	});

	test("preserves the filename as the destination basename so the loader finds it by the same name", () => {
		const plan = addonCopyPlan({
			filenames: [names[0]],
			fromDir: nativeDir,
			toDir: cacheDir,
			fromIsCurrent: () => true,
			toIsCurrent: () => false,
		});
		expect(path.basename(plan[0]?.dest ?? "")).toBe(names[0]);
		expect(path.dirname(plan[0]?.dest ?? "")).toBe(cacheDir);
	});
});

describe("versionedNativeCacheDir", () => {
	test("is the natives root joined with the exact version, so writer and reader agree on one path", () => {
		// The loader probes this dir and ensure mirrors into it; if the two derived
		// the path differently the mirror would land where the loader never looks.
		const dir = versionedNativeCacheDir(version);
		expect(path.basename(dir)).toBe(version);
		expect(path.basename(path.dirname(dir))).toBe("natives");
	});
});
