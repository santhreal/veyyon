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
import { versionSentinelExportFor } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };
import { addonIsCurrent, hostAddonFilenames } from "../scripts/ensure-native";

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
		const file = tmpFile(Buffer.concat([Buffer.from("\x00binary\x00"), Buffer.from(versionSentinelExportFor(version)), Buffer.from("\x00tail")]));
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
