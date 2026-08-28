/**
 * WHY: the loader reports a load failure only as prose. Callers that wrap a
 * native call in a `catch` therefore could not tell "the addon is unavailable"
 * from "the call ran and found nothing", and three directory-scan callers chose
 * the second reading: they returned an empty tree, so a full checkout inside a
 * container whose glibc was older than the shipped addon was rendered as an
 * empty workspace.
 *
 * This suite pins the discriminator those callers read: `native()` stamps
 * `NATIVE_ADDON_UNAVAILABLE_CODE` on whatever it throws, and the predicate
 * matches that and nothing else.
 *
 * The load failure is exercised through the real loader in a subprocess: a copy
 * of the package's loader modules with no `.node` beside them and an empty HOME,
 * so every candidate path resolves to a file that does not exist. No global
 * mutation, and the message the user sees is asserted alongside the code.
 *
 * NOT covered here: which hosts can load the shipped addon. That is the build's
 * portability surface, not the loader's error contract.
 */

import { describe, expect, it } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isNativeAddonUnavailable,
	markNativeAddonUnavailable,
	NATIVE_ADDON_UNAVAILABLE_CODE,
} from "@veyyon/natives/loader-state";

const PACKAGE_ROOT = path.join(import.meta.dirname, "..");

/** `native()` in a tree where no candidate addon exists, reported as JSON. */
const PROBE_SCRIPT = [
	// The specifier is a temp-directory copy this test just created, so a static
	// import cannot name it.
	"const loader = await import(process.argv[2]);",
	"try {",
	"	loader.native();",
	"	console.log(JSON.stringify({ threw: false }));",
	"} catch (error) {",
	'	const code = error && typeof error === "object" && "code" in error ? error.code : null;',
	"	const message = error instanceof Error ? error.message : String(error);",
	"	console.log(JSON.stringify({ threw: true, code, message }));",
	"}",
].join("\n");

interface ProbeResult {
	threw: boolean;
	code?: unknown;
	message?: string;
}

async function loadWithNoAddonPresent(): Promise<ProbeResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "natives-no-addon-"));
	try {
		const pkgDir = path.join(root, "pkg");
		const home = path.join(root, "home");
		await fs.mkdir(path.join(pkgDir, "native"), { recursive: true });
		await fs.mkdir(home, { recursive: true });
		await fs.copyFile(path.join(PACKAGE_ROOT, "package.json"), path.join(pkgDir, "package.json"));
		for (const file of ["loader-state.js", "embedded-addon.js"]) {
			await fs.copyFile(path.join(PACKAGE_ROOT, "native", file), path.join(pkgDir, "native", file));
		}
		await fs.writeFile(path.join(root, "probe.mjs"), PROBE_SCRIPT);

		const run = childProcess.spawnSync(
			process.execPath,
			[path.join(root, "probe.mjs"), path.join(pkgDir, "native", "loader-state.js")],
			{
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, "empty-data"), USERPROFILE: home },
			},
		);
		expect(run.status).toBe(0);
		return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("an addon that cannot load reports a code callers can read", () => {
	it("stamps the unavailable code on the real loader's failure", async () => {
		const result = await loadWithNoAddonPresent();

		expect(result.threw).toBe(true);
		expect(result.code).toBe(NATIVE_ADDON_UNAVAILABLE_CODE);
	});

	it("still names every candidate it tried, so the code replaces no diagnostics", async () => {
		const result = await loadWithNoAddonPresent();

		expect(result.message).toContain("Failed to load veyyon_natives native addon");
		expect(result.message).toContain("Tried:");
		expect(result.message).toContain("veyyon_natives.");
	});

	it("matches a stamped error and leaves the error usable", () => {
		const error = new Error("Failed to load veyyon_natives native addon for linux-x64 (modern).");
		markNativeAddonUnavailable(error);

		expect(isNativeAddonUnavailable(error)).toBe(true);
		expect(error.message).toContain("Failed to load");
	});

	it("does not match a scan failure that is not an addon failure", () => {
		expect(isNativeAddonUnavailable(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(false);
		expect(isNativeAddonUnavailable(new Error("no such file"))).toBe(false);
		expect(isNativeAddonUnavailable("Failed to load veyyon_natives native addon")).toBe(false);
		expect(isNativeAddonUnavailable(null)).toBe(false);
		expect(isNativeAddonUnavailable(undefined)).toBe(false);
	});

	it("leaves a non-object failure unstamped rather than throwing on it", () => {
		expect(markNativeAddonUnavailable("string failure")).toBe("string failure");
		expect(isNativeAddonUnavailable(markNativeAddonUnavailable(null))).toBe(false);
	});
});
