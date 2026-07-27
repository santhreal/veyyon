/**
 * An update must not keep a binary that starts and cannot work.
 *
 * `--version` is answered by the JS entry point alone, so a release built for
 * the wrong architecture, or one whose native addon failed to stage, reports
 * the expected version and then fails on the user's first real command — with
 * the previous working binary already deleted. The installer's doctor gained
 * the same probe, but it can only report the failure after the fact. Here the
 * caller still holds the backup, so a failed probe rolls the old binary back.
 *
 * These drive real executables rather than mocking the spawn: the contract is
 * about what a child process prints and exits with, which a stub of the shell
 * layer would define away.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "../../src/modes/theme/theme";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

let verifyBinaryUsable: typeof import("../../src/cli/update-cli").verifyBinaryUsable;
let replaceBinaryForUpdate: typeof import("../../src/cli/update-cli").replaceBinaryForUpdate;

beforeAll(async () => {
	// `theme` is a mutable global assigned by initTheme(); importing update-cli
	// without it throws on the first themed string.
	await initTheme();
	({ verifyBinaryUsable, replaceBinaryForUpdate } = await import("../../src/cli/update-cli"));
});

let dir: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-usable-"));
});
afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a fake veyyon that answers `--version` and `grep` however the case
 * needs. Real file, real exec: the whole point is the child-process contract.
 */
function writeFakeBinary(name: string, body: { version: string; grep: string }): string {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		[
			"#!/bin/sh",
			'case "$1" in',
			"  grep)",
			"    shift",
			'    [ "$1" = "--help" ] && exit 0',
			`    ${body.grep}`,
			"    ;;",
			`  *) echo "veyyon/${body.version}" ;;`,
			"esac",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return file;
}

describe("verifyBinaryUsable", () => {
	it("accepts a binary that reports the version AND runs a search", () => {
		const bin = writeFakeBinary("good", {
			version: "2.0.0",
			grep: 'printf "%s/probe.txt:1: %s\\n" "$2" "$1"',
		});
		return verifyBinaryUsable(bin, "2.0.0").then(result => {
			expect(result.ok).toBe(true);
			expect(result.actual).toBe("2.0.0");
			expect(result.reason).toBeUndefined();
		});
	});

	it("rejects a binary whose search cannot run, and says the addon did not load", async () => {
		// The failure this exists to catch. Without it the update keeps this binary
		// and deletes the working one.
		const bin = writeFakeBinary("noaddon", {
			version: "2.0.0",
			grep: 'echo "dlopen: libc.musl-x86_64.so.1: not found" >&2; exit 127',
		});
		const result = await verifyBinaryUsable(bin, "2.0.0");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("native addon did not load");
		expect(result.reason).toContain("exited 127");
		expect(result.reason).toContain("dlopen");
	});

	it("rejects a search that exits 0 and finds nothing", async () => {
		// Trusting the exit code alone would report a healthy binary for a walker
		// that returns empty, which is the quieter half of the same breakage.
		const bin = writeFakeBinary("empty", { version: "2.0.0", grep: 'echo "Total matches: 0"' });
		const result = await verifyBinaryUsable(bin, "2.0.0");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("did not find a file it was pointed at");
	});

	it("reports the wrong version before it ever probes the addon", async () => {
		// A version mismatch has its own wording, and the addon probe would only
		// bury it.
		const bin = writeFakeBinary("oldver", {
			version: "1.0.0",
			grep: 'printf "%s/probe.txt:1: %s\\n" "$2" "$1"',
		});
		const result = await verifyBinaryUsable(bin, "2.0.0");
		expect(result.ok).toBe(false);
		expect(result.actual).toBe("1.0.0");
		expect(result.reason).toBeUndefined();
	});

	it("accepts a build with no grep subcommand rather than rolling back forever", async () => {
		// A downgrade to a release predating the subcommand is not a failed update.
		const file = path.join(dir, "nogrep");
		fs.writeFileSync(file, '#!/bin/sh\ncase "$1" in grep) exit 1 ;; *) echo veyyon/2.0.0 ;; esac\n', {
			mode: 0o755,
		});
		const result = await verifyBinaryUsable(file, "2.0.0");
		expect(result.ok).toBe(true);
	});

	it("leaves no temp directory behind, on success or on failure", async () => {
		const before = fs.readdirSync(os.tmpdir()).filter(e => e.startsWith("veyyon-update-check-"));
		const good = writeFakeBinary("clean-ok", {
			version: "2.0.0",
			grep: 'printf "%s/probe.txt:1: %s\\n" "$2" "$1"',
		});
		const bad = writeFakeBinary("clean-bad", { version: "2.0.0", grep: "exit 3" });
		await verifyBinaryUsable(good, "2.0.0");
		await verifyBinaryUsable(bad, "2.0.0");
		const after = fs.readdirSync(os.tmpdir()).filter(e => e.startsWith("veyyon-update-check-"));
		expect(after.length).toBe(before.length);
	});
});

/**
 * The reason this check belongs in the verifier and not in a later doctor: the
 * replacement still holds the previous binary and puts it back.
 */
describe("a binary that starts but cannot work is rolled back", () => {
	let swapDir: string;

	// `useTrackedTempDirs` rather than a bare `mkdtempSync`: this ran per case and
	// nothing ever deleted the result, so every full `test/cli` run left one directory
	// per case in `/tmp`. The factory registers its own `afterAll`, so a new case in
	// this describe cannot reintroduce the leak by forgetting a teardown.
	const makeSwapDir = useTrackedTempDirs("veyyon-usable-swap-");

	beforeEach(() => {
		swapDir = makeSwapDir();
	});

	it("restores the previous binary and names the addon as the cause", async () => {
		const target = path.join(swapDir, "veyyon");
		const temp = path.join(swapDir, "veyyon.new");
		const backup = path.join(swapDir, "veyyon.bak");
		fs.writeFileSync(target, "the previous working binary", { mode: 0o755 });
		fs.writeFileSync(temp, "the new broken binary", { mode: 0o755 });

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "2.0.0",
				verifyInstalledVersion: async () => ({
					ok: false,
					path: target,
					actual: "2.0.0",
					reason: "veyyon 2.0.0 installed but cannot run a search, so its native addon did not load.",
				}),
			}),
		).rejects.toThrow(/native addon did not load/);

		expect(fs.readFileSync(target, "utf8")).toBe("the previous working binary");
		expect(fs.existsSync(temp)).toBe(false);
	});

	it("reports the addon reason instead of the version wording", async () => {
		// The binary IS the expected version, so "still reports 1.9.0 (expected
		// 2.0.0)" would be a false explanation of a real failure.
		const target = path.join(swapDir, "veyyon");
		const temp = path.join(swapDir, "veyyon.new");
		fs.writeFileSync(target, "previous", { mode: 0o755 });
		fs.writeFileSync(temp, "new", { mode: 0o755 });

		let message = "";
		try {
			await replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: path.join(swapDir, "veyyon.bak"),
				expectedVersion: "2.0.0",
				verifyInstalledVersion: async () => ({
					ok: false,
					path: target,
					actual: "2.0.0",
					reason: "its native addon did not load",
				}),
			});
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("its native addon did not load");
		expect(message).not.toContain("still reports 2.0.0");
		expect(message).toContain("restored previous");
	});
});
