/**
 * A session file that exists and cannot be reached is reported, not silently treated as absent.
 *
 * WHY THIS MATTERS MORE HERE THAN AT MOST PROBES. `FileSessionStorage.existsSync` is one method behind
 * NINE call sites: `SessionManager` asks it whether the session file is there before a rewrite, whether a
 * marker exists, whether an old file existed before a move, whether a draft has already been written, and
 * `session-listing` asks it whether a primary path is present. It was `fs.existsSync`, which answers
 * `false` for a path that exists and cannot be reached exactly as it does for one that is absent. So a
 * session directory on a mount that had gone away, or whose permissions changed, made every one of those
 * probes say "not there" and the session behave as though it had no history: nothing failed, nothing was
 * logged, and nobody looked (Law 10).
 *
 * WHAT THIS CHANGE DOES AND DOES NOT DO, because the distinction is the design. The boolean is unchanged:
 * `false` for unreachable, exactly as before. Several callers WRITE on the false branch, and whether a
 * wrong answer there is worse than failing is a per-site contract decision (`pathExistsOrThrow` is the
 * shape for the ones that overwrite), recorded as its own task rather than guessed at across session
 * persistence in one sweep. What is fixed is the SILENCE. So these tests assert the report, and assert
 * that the answer did not move.
 *
 * `chmod 0o000` DOES NOT DENY ROOT, and CI containers routinely run as root, so the denial is verified and
 * skipped rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { attachFaultSink, type DetachFaultSink, type Fault } from "@veyyon/utils";

let root: string;
let nested: string;
let sessionFile: string;
let faults: Fault[];
let detach: DetachFaultSink;
/** Whether making `nested` untraversable actually denied us. */
let denied = false;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-session-unreachable-"));
	nested = path.join(root, "sessions");
	await fs.mkdir(nested);
	sessionFile = path.join(nested, "session.jsonl");
	await fs.writeFile(sessionFile, '{"type":"start"}\n');
	faults = [];
	detach = attachFaultSink(fault => faults.push(fault));

	await fs.chmod(nested, 0o000);
	try {
		await fs.stat(sessionFile);
		await fs.chmod(nested, 0o700);
		denied = false;
	} catch {
		denied = true;
	}
});

afterEach(async () => {
	detach();
	await fs.chmod(nested, 0o700).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

describe("FileSessionStorage.existsSync on an unreachable path", () => {
	/**
	 * The answer stays `false` AND the operator is told which file and why.
	 *
	 * Both halves in one case on purpose: the value of the change is entirely in the second half, and a
	 * test that only asserted the report would not notice if the boolean had moved and broken the eight
	 * callers that depend on it. The text names the path, says the session is being treated as absent (the
	 * consequence, which the boolean cannot express), and names the two causes worth checking.
	 */
	it("answers false and reports the fault", () => {
		if (!denied) return;

		const storage = new FileSessionStorage();

		expect(storage.existsSync(sessionFile)).toBe(false);

		expect(faults).toHaveLength(1);
		expect(faults[0]?.source).toBe("session");
		expect(faults[0]?.text).toContain(sessionFile);
		expect(faults[0]?.text).toContain("could not be reached");
		expect(faults[0]?.text).toContain("treated as though it were not there");
		expect(faults[0]?.context).toMatchObject({ path: sessionFile });
	});

	/**
	 * Reported ONCE per path, however often the probe runs.
	 *
	 * These probes run per turn: a rewrite guard, a draft guard, a marker check. A report per call would
	 * put the identical line in the log on every turn until someone fixed the mount, which is how a
	 * channel becomes noise and stops being read. The fault is a property of the path, not of the probe.
	 */
	it("reports once for repeated probes of the same path", () => {
		if (!denied) return;

		const storage = new FileSessionStorage();
		storage.existsSync(sessionFile);
		storage.existsSync(sessionFile);
		storage.existsSync(sessionFile);

		expect(faults).toHaveLength(1);
	});

	/**
	 * Two unreachable paths get two reports, which is why the bookkeeping is keyed by path.
	 *
	 * A single "already reported" flag would report the first path and hide every other one, and an
	 * operator whose whole sessions directory is unreachable would be told about one file out of many.
	 */
	it("reports each unreachable path separately", () => {
		if (!denied) return;

		const storage = new FileSessionStorage();
		const other = path.join(nested, "other.jsonl");

		storage.existsSync(sessionFile);
		storage.existsSync(other);

		expect(faults.map(fault => fault.context?.path)).toEqual([sessionFile, other]);
	});

	/**
	 * A path that becomes reachable again is reported again if it breaks again.
	 *
	 * The remembered set is cleared on a successful probe, so a mount that flaps is reported each time it
	 * goes rather than once for the lifetime of the process. Without this, the one report an operator gets
	 * is the one they miss.
	 */
	it("reports again after the path recovers and breaks once more", async () => {
		if (!denied) return;

		const storage = new FileSessionStorage();
		storage.existsSync(sessionFile);

		await fs.chmod(nested, 0o700);
		expect(storage.existsSync(sessionFile)).toBe(true);

		await fs.chmod(nested, 0o000);
		storage.existsSync(sessionFile);

		expect(faults).toHaveLength(2);
	});
});

describe("FileSessionStorage.existsSync on ordinary paths", () => {
	/** A reachable file is `true`, silently: the fault path must not have made every probe suspect. */
	it("answers true for a file that is there, with no report", async () => {
		await fs.chmod(nested, 0o700);
		const storage = new FileSessionStorage();

		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(faults).toEqual([]);
	});

	/** And `false` with no report for one that is genuinely absent, which is the ordinary miss. */
	it("answers false for a file that is not there, with no report", async () => {
		await fs.chmod(nested, 0o700);
		const storage = new FileSessionStorage();

		expect(storage.existsSync(path.join(nested, "never-written.jsonl"))).toBe(false);
		expect(faults).toEqual([]);
	});

	/**
	 * A file that stats but cannot be OPENED is still `true`, unchanged from `existsSync`.
	 *
	 * The boundary that keeps this change behaviour-preserving for its eight callers. `pathStateSync` calls
	 * such a file `present` deliberately (its bytes are the opener's problem), and `fs.existsSync` said
	 * `true` as well, so nothing moved. Pinned because "unreadable file" is the case a reader would expect
	 * to report here, and it must not.
	 */
	it("answers true for a file it could not open, with no report", async () => {
		await fs.chmod(nested, 0o700);
		await fs.chmod(sessionFile, 0o000);
		try {
			await fs.readFile(sessionFile, "utf-8");
			return; // running as root: the denial did not take, so there is nothing to assert
		} catch {
			// denied, which is what this case needs
		}

		const storage = new FileSessionStorage();

		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(faults).toEqual([]);
	});
});
