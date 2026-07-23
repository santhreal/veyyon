import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	detectBuiltNativeVersion,
	findStaleAddon,
	nativeSentinelsInBuffer,
	staleAddonMessage,
	versionSentinelExportFor,
} from "../native/loader-state.js";

/**
 * The ship-path freshness guard: `embed-native.ts` refuses to publish a compiled
 * binary whose embedded `.node` was built for a DIFFERENT version than the
 * package. This is the exact crash a user hit — veyyon installed at version X
 * but carrying a `.node` built for version Y, so the very first native call (or,
 * with the version-sentinel loader, the load itself) threw and the tool "broke
 * immediately on launch." The guard's logic used to live inlined in
 * `embed-native.ts` with no test, and the surrounding sentinel tests only
 * exercised fake in-memory buffers; nothing proved the guard works on a real
 * built binary, and nothing would notice if a refactor inverted the check.
 *
 * These tests pin the extracted single-owner contract (`findStaleAddon` +
 * `staleAddonMessage`) two ways:
 *  1. Against REAL built `.node` files on disk — deriving each binary's actual
 *     version from its own sentinel, then proving the guard calls it fresh for
 *     that version and stale for any other. This is the coverage that was
 *     missing: a check exercised on genuine ELF/Mach-O/PE bytes, not a fixture.
 *  2. Against adversarial fakes — the multi-variant "one variant left behind"
 *     brick, a sentinel-free binary, and the exact wording (with both versions)
 *     of the refusal a maintainer sees at build time.
 */

const nativeDir = path.join(import.meta.dir, "..", "native");

/** Every real, built `veyyon_natives.*.node` present in the package's native/ dir. */
function realBuiltAddons(): Array<{ filename: string; bytes: Buffer; builtVersion: string }> {
	let entries: string[];
	try {
		entries = fs.readdirSync(nativeDir);
	} catch {
		return [];
	}
	const addons: Array<{ filename: string; bytes: Buffer; builtVersion: string }> = [];
	for (const filename of entries) {
		if (!filename.startsWith("veyyon_natives.") || !filename.endsWith(".node")) continue;
		const bytes = fs.readFileSync(path.join(nativeDir, filename));
		const sentinels = nativeSentinelsInBuffer(bytes);
		// A correctly built variant carries exactly its own version sentinel; read
		// it back so the test tracks the actual build (fresh in CI, whatever the dev
		// last built locally) instead of hardcoding a version that would rot.
		const builtVersion = detectBuiltNativeVersion(Object.fromEntries(sentinels.map(s => [s, () => 0])));
		addons.push({ filename, bytes, builtVersion });
	}
	return addons;
}

function bumpPatch(version: string): string {
	const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) throw new Error(`not a clean semver: ${version}`);
	return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

describe("findStaleAddon on real built .node binaries", () => {
	const addons = realBuiltAddons();

	it("finds at least one real built native to exercise (the suite needs natives built)", () => {
		// If this fails, the native addon was not built before the suite ran. The
		// guard cannot be proven on a fixture alone — the whole point is real bytes.
		expect(addons.length).toBeGreaterThan(0);
	});

	it("reads a concrete version sentinel back from every real binary", () => {
		// Not `unknown`: a real built `.node` must expose exactly one
		// `__veyyonNativesV<x_y_z>` symbol, which is what the loader keys on.
		for (const addon of addons) {
			expect(addon.builtVersion).toMatch(/^\d+\.\d+\.\d+$/);
			expect(nativeSentinelsInBuffer(addon.bytes)).toContain(versionSentinelExportFor(addon.builtVersion));
		}
	});

	it("calls each real binary FRESH for the exact version it was built for", () => {
		for (const addon of addons) {
			expect(findStaleAddon([addon], addon.builtVersion)).toBeNull();
		}
	});

	it("calls each real binary STALE for any other version, naming its real built version", () => {
		// The crash class: the package moved on but the binary did not. The guard
		// must flag the genuine bytes and report the true built version, not guess.
		for (const addon of addons) {
			const other = bumpPatch(addon.builtVersion);
			const stale = findStaleAddon([addon], other);
			expect(stale).not.toBeNull();
			expect(stale?.filename).toBe(addon.filename);
			expect(stale?.expected).toBe(versionSentinelExportFor(other));
			expect(stale?.builtFor).toContain(versionSentinelExportFor(addon.builtVersion));
		}
	});

	it("would REFUSE the whole set if a real binary is stale, and would accept a fresh set", () => {
		// The set-level decision embed-native.ts makes: one stale variant fails the
		// entire publish; an all-fresh set passes.
		const anyVersion = addons[0].builtVersion;
		const mixed = addons.map(a => a); // all built for their own versions
		// All fresh when each is asked for its own version cannot be expressed as a
		// single call, so assert the set is fresh for a shared version only when all
		// share it (true for a normal build); otherwise assert the stale path.
		const shareOneVersion = addons.every(a => a.builtVersion === anyVersion);
		if (shareOneVersion) {
			expect(findStaleAddon(mixed, anyVersion)).toBeNull();
			expect(findStaleAddon(mixed, bumpPatch(anyVersion))).not.toBeNull();
		} else {
			// A locally half-rebuilt tree (variants at different versions) is exactly
			// the "one variant left behind" brick the guard exists to catch.
			expect(findStaleAddon(mixed, anyVersion)).not.toBeNull();
		}
	});
});

describe("findStaleAddon on adversarial fakes", () => {
	// A fake `.node`: binary noise with the sentinel symbol embedded, like the real
	// symbol-table entry. Mirrors the fixture the sentinel-scanner tests use.
	function fakeAddon(...sentinels: string[]): Buffer {
		const noise = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x0a, 0xff, 0x00, 0x0a]);
		return Buffer.concat([noise, ...sentinels.flatMap(s => [Buffer.from(`\x00${s}\x00`, "latin1"), noise])]);
	}

	it("returns null when every variant carries the expected version", () => {
		const addons = [
			{ filename: "veyyon_natives.linux-x64-modern.node", bytes: fakeAddon(versionSentinelExportFor("1.0.18")) },
			{ filename: "veyyon_natives.linux-x64-baseline.node", bytes: fakeAddon(versionSentinelExportFor("1.0.18")) },
		];
		expect(findStaleAddon(addons, "1.0.18")).toBeNull();
	});

	it("catches the one-variant-left-behind brick (modern fresh, baseline stale)", () => {
		// The precise multi-variant failure: modern rebuilt at 1.0.18 but baseline
		// still 1.0.17. The x64 CPUs that select baseline would load a wrong-version
		// addon; the guard must flag the baseline variant specifically.
		const addons = [
			{ filename: "veyyon_natives.linux-x64-modern.node", bytes: fakeAddon(versionSentinelExportFor("1.0.18")) },
			{ filename: "veyyon_natives.linux-x64-baseline.node", bytes: fakeAddon(versionSentinelExportFor("1.0.17")) },
		];
		const stale = findStaleAddon(addons, "1.0.18");
		expect(stale?.filename).toBe("veyyon_natives.linux-x64-baseline.node");
		expect(stale?.expected).toBe("__veyyonNativesV1_0_18");
		expect(stale?.builtFor).toEqual(["__veyyonNativesV1_0_17"]);
	});

	it("flags a binary with no version sentinel at all", () => {
		const addons = [{ filename: "veyyon_natives.darwin-arm64.node", bytes: fakeAddon() }];
		const stale = findStaleAddon(addons, "1.0.18");
		expect(stale?.filename).toBe("veyyon_natives.darwin-arm64.node");
		expect(stale?.builtFor).toEqual([]);
	});
});

describe("staleAddonMessage", () => {
	it("names the stale file, the version it was built for, and the version expected", () => {
		const stale = {
			filename: "veyyon_natives.linux-x64-baseline.node",
			expected: "__veyyonNativesV1_0_18",
			builtFor: ["__veyyonNativesV1_0_17"],
		};
		const message = staleAddonMessage(stale, "1.0.18");
		expect(message).toContain("Refusing to embed a stale native addon");
		expect(message).toContain("veyyon_natives.linux-x64-baseline.node");
		expect(message).toContain("__veyyonNativesV1_0_17");
		expect(message).toContain("1.0.18");
		expect(message).toContain("__veyyonNativesV1_0_18");
		expect(message).toContain("bun --cwd=packages/natives run build");
	});

	it("says 'no version sentinel' when the binary carried none", () => {
		const stale = { filename: "veyyon_natives.darwin-arm64.node", expected: "__veyyonNativesV1_0_18", builtFor: [] };
		expect(staleAddonMessage(stale, "1.0.18")).toContain("no version sentinel");
	});
});
