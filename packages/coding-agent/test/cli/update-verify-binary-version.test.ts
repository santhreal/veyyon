/**
 * An update must verify the file it just wrote, not whatever PATH resolves.
 *
 * The post-swap check ran `$which("veyyon")` and executed that. On a machine
 * where the installed veyyon is not first on PATH, that asks a different
 * question than the one the updater needs answered, and both wrong answers are
 * silent:
 *
 * - an OLDER copy earlier on PATH reports the old version, the check "fails",
 *   and a perfectly good new binary is rolled back on every attempt;
 * - a copy earlier on PATH that is ALREADY the new version reports the new
 *   version, so a swap that never landed is reported as verified.
 *
 * These run real executables from a temp directory with PATH deliberately
 * pointed elsewhere, so the assertions are about behavior, not about which
 * function name appears in the source.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyBinaryVersion } from "@veyyon/coding-agent/cli/update-cli";

const isWindows = process.platform === "win32";

let root: string;
/** The binary an update just wrote: reports 15.1.8. */
let target: string;
/** A different copy, first on PATH under the same command name: reports 1.0.0. */
let decoyDir: string;

/** Write an executable stub that prints `veyyon/<version>` for `--version`. */
function writeFakeBinary(file: string, version: string): void {
	fs.writeFileSync(file, `#!/bin/sh\necho "veyyon/${version}"\n`);
	fs.chmodSync(file, 0o755);
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-verify-version-"));
	target = path.join(root, "installed", "veyyon");
	decoyDir = path.join(root, "decoy");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.mkdirSync(decoyDir, { recursive: true });
	writeFakeBinary(target, "15.1.8");
	writeFakeBinary(path.join(decoyDir, "veyyon"), "1.0.0");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(isWindows)("verifyBinaryVersion runs the path it is given", () => {
	it("accepts the binary that reports the expected version", async () => {
		const result = await verifyBinaryVersion(target, "15.1.8");
		expect(result.ok).toBe(true);
		expect(result.actual).toBe("15.1.8");
		// The reported path is what the caller can act on, so it must be the file
		// that was actually run.
		expect(result.path).toBe(target);
	});

	it("ignores an older copy of the same command name first on PATH", async () => {
		// This is the rollback-a-good-update failure. With PATH resolution the
		// check would run the decoy, read 1.0.0, and report a mismatch.
		const previousPath = process.env.PATH;
		process.env.PATH = `${decoyDir}${path.delimiter}${previousPath ?? ""}`;
		try {
			const result = await verifyBinaryVersion(target, "15.1.8");
			expect(result.ok).toBe(true);
			expect(result.actual).toBe("15.1.8");
			expect(result.path).toBe(target);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("reports the real version when it does not match, rather than throwing", async () => {
		// The caller turns this into the rollback message, which names both
		// numbers; an exception here would lose the actual one.
		const result = await verifyBinaryVersion(target, "16.0.0");
		expect(result.ok).toBe(false);
		expect(result.actual).toBe("15.1.8");
	});

	it("fails closed when the binary cannot be run at all", async () => {
		// A missing or non-executable file means the check did not run, which is
		// not the same as passing (Law 10). It must never report ok.
		const missing = path.join(root, "installed", "not-there");
		const result = await verifyBinaryVersion(missing, "15.1.8");
		expect(result.ok).toBe(false);
		expect(result.actual).toBeUndefined();
		expect(result.path).toBe(missing);
	});

	it("fails closed when --version prints nothing version-shaped", async () => {
		// A binary that runs but whose output format changed has not proved
		// anything. Treating an unparseable line as a match would let a wrong
		// binary through on the day the format changes.
		const garbled = path.join(root, "installed", "garbled");
		fs.writeFileSync(garbled, "#!/bin/sh\necho 'hello there'\n");
		fs.chmodSync(garbled, 0o755);
		const result = await verifyBinaryVersion(garbled, "15.1.8");
		expect(result.ok).toBe(false);
		expect(result.actual).toBeUndefined();
	});

	it("fails closed when the binary exits non-zero", async () => {
		const broken = path.join(root, "installed", "broken");
		fs.writeFileSync(broken, "#!/bin/sh\necho 'veyyon/15.1.8'\nexit 3\n");
		fs.chmodSync(broken, 0o755);
		const result = await verifyBinaryVersion(broken, "15.1.8");
		// It printed the right version and still must not pass: a binary that
		// cannot exit 0 on --version is not a working install.
		expect(result.ok).toBe(false);
	});
});
