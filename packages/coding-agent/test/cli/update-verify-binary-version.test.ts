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

/**
 * A failure has to say WHICH failure it was, in the binary's own words.
 *
 * Every route out of this function used to answer `{ok: false, path}` and nothing
 * else, so the caller printed "could not verify updated version at <path>" for
 * three unrelated situations: a binary that will not start, a binary that starts
 * and prints something unreadable, and a binary that reports a different version.
 * Only the third has an obvious next step. The first is what an install directory
 * mounted `noexec` looks like — the downloaded file is byte-perfect and the mount
 * refuses to execute it — and the operator was told nothing that would let them
 * find that out.
 *
 * These assert the exact evidence carried back: the exit code, the binary's own
 * stderr, and the distinction between "no process started" and "a process ran and
 * failed". A test that only checked `ok === false` passed before the fix.
 */
describe.skipIf(isWindows)("verifyBinaryVersion says why a binary would not run", () => {
	it("quotes the exit code and stderr of a binary that fails to start", async () => {
		const loud = path.join(root, "installed", "loud");
		fs.writeFileSync(loud, "#!/bin/sh\necho 'cannot execute: required file not found' >&2\nexit 126\n");
		fs.chmodSync(loud, 0o755);

		const result = await verifyBinaryVersion(loud, "15.1.8");

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("exited 126");
		expect(result.reason).toContain("cannot execute: required file not found");
		expect(result.reason).toContain(loud);
	});

	/**
	 * The silent variant. Saying "it printed nothing" is itself the finding: it
	 * rules out a message the operator might otherwise go looking for.
	 */
	it("says it printed nothing when a failing binary is silent", async () => {
		const silent = path.join(root, "installed", "silent");
		fs.writeFileSync(silent, "#!/bin/sh\nexit 1\n");
		fs.chmodSync(silent, 0o755);

		const result = await verifyBinaryVersion(silent, "15.1.8");

		expect(result.reason).toContain("exited 1");
		expect(result.reason).toContain("printed nothing");
	});

	/**
	 * The `noexec` shape, reproduced the one way it can be without mounting a
	 * filesystem: a file whose execute bit is off. The kernel refuses the same way
	 * for the same errno, and the point of the assertion is that the refusal
	 * reaches the operator instead of being flattened into "could not verify".
	 */
	it("reports a file the system refuses to execute as unrunnable, not as a version mismatch", async () => {
		const noexec = path.join(root, "installed", "noexec");
		fs.writeFileSync(noexec, "#!/bin/sh\necho 'veyyon/15.1.8'\n");
		fs.chmodSync(noexec, 0o644);

		const result = await verifyBinaryVersion(noexec, "15.1.8");

		expect(result.ok).toBe(false);
		expect(result.reason).toBeDefined();
		expect(result.reason).toContain(noexec);
		// Never the wrong-version wording: nothing ran, so there is no actual version.
		expect(result.actual).toBeUndefined();
		expect(result.reason).not.toContain("expected");
	});

	it("quotes what an unreadable --version actually printed", async () => {
		const garbled = path.join(root, "installed", "garbled-reason");
		fs.writeFileSync(garbled, "#!/bin/sh\necho 'hello there'\n");
		fs.chmodSync(garbled, 0o755);

		const result = await verifyBinaryVersion(garbled, "15.1.8");

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("did not report a version");
		expect(result.reason).toContain("hello there");
	});

	/**
	 * A version MISMATCH is the one failure that must NOT carry a reason: the
	 * caller has a better sentence for it, naming both numbers, and a reason would
	 * suppress it. This is the assertion that keeps the new evidence from
	 * swallowing the old message.
	 */
	it("leaves a plain version mismatch without a reason so the caller names both versions", async () => {
		const result = await verifyBinaryVersion(target, "16.0.0");

		expect(result.ok).toBe(false);
		expect(result.actual).toBe("15.1.8");
		expect(result.reason).toBeUndefined();
	});

	/** A path with nothing at it never starts a process, so there is no exit code. */
	it("reports a missing binary as one that could not be started", async () => {
		const missing = path.join(root, "installed", "still-not-there");

		const result = await verifyBinaryVersion(missing, "15.1.8");

		expect(result.ok).toBe(false);
		expect(result.reason).toContain(missing);
	});
});
