/**
 * Session inputs that cannot be read must not present as inputs that are not there.
 *
 * WHY THIS SUITE EXISTS. Two reads on the session path answered every failure with the same value a
 * successful read of nothing returns. `ArtifactManager.listFiles` returned `[]` from a bare `catch`,
 * and `SessionManager.peekSessionInit` returned `null` from a bare `catch`. Both are the value the
 * caller gets in the ordinary "nothing here yet" case, so a directory or a file that exists and
 * cannot be read was indistinguishable from a fresh session, and nothing was logged.
 *
 * What each loss costs the reader is why the two are worth reporting. Artifacts are what an
 * `artifact://` URL resolves against: an empty list means every truncated tool output in the session
 * becomes unreachable, with no error to trace. `peekSessionInit` is the cold-revival peek for a
 * subagent, so a null there is presented to the user as a session that does not exist, which is a
 * false statement about their own file when the file is right where they left it.
 *
 * The split is the same one drawn in `session-listing.ts` and in the `@veyyon/stats` session parser,
 * and it is drawn at ENOENT rather than at an error class: absent is quiet because it is the normal
 * state of a fresh install and would otherwise train the reader to ignore the warning that matters,
 * and everything else is reported. The return value is deliberately unchanged in both cases, so
 * these tests assert the report: the report is the entire difference between a loss you can see and
 * one you cannot.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@veyyon/coding-agent/session/artifacts";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { logger } from "@veyyon/utils";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let warnings: Warning[];
let restore: () => void;
let root: string;

beforeEach(() => {
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-unreadable-session-"));
});

afterEach(() => {
	restore();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("listing a session's artifacts", () => {
	/** The ordinary case: the artifacts are found by name, and nothing is reported. */
	it("returns the artifact names and warns about nothing", async () => {
		const dir = path.join(root, "artifacts");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "tool-out-1.txt"), "truncated output");
		fs.writeFileSync(path.join(dir, "tool-out-2.txt"), "more");

		expect((await new ArtifactManager(dir).listFiles()).sort()).toEqual(["tool-out-1.txt", "tool-out-2.txt"]);
		expect(warnings).toEqual([]);
	});

	/**
	 * A session that has never truncated an output has no artifact directory. This is the case that has
	 * to stay quiet: it is what every new session looks like, and a warning here would fire constantly.
	 */
	it("returns an empty list without warning when the directory does not exist", async () => {
		expect(await new ArtifactManager(path.join(root, "never-created")).listFiles()).toEqual([]);
		expect(warnings).toEqual([]);
	});

	/**
	 * The case this exists for. The list is still empty on purpose, because a session must keep running
	 * when its artifacts are unreachable, so the warning is the only trace that anything was lost. It
	 * names the directory, since the reader chasing a dead `artifact://` URL needs the path to check.
	 */
	it("reports a directory that exists and cannot be read", async () => {
		const notADir = path.join(root, "artifacts-is-a-file");
		fs.writeFileSync(notADir, "not a directory");

		expect(await new ArtifactManager(notADir).listFiles()).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Artifact directory could not be read; truncated tool outputs are unreachable");
		expect(warnings[0]?.meta.dir).toBe(notADir);
		expect(typeof warnings[0]?.meta.error).toBe("string");
		expect(warnings[0]?.meta.error).not.toBe("");
	});

	/**
	 * A permission failure is a different errno from ENOTDIR and must be reported too, so a fix that
	 * special-cased one cannot pass the test above while still swallowing the other.
	 */
	it("reports a directory whose permissions deny the read", async () => {
		const locked = path.join(root, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "hidden.txt"), "x");
		fs.chmodSync(locked, 0o000);
		try {
			const files = await new ArtifactManager(locked).listFiles();

			// Permission bits do not bind root; when the read succeeds anyway, silence is the correct
			// outcome, so the report is only required when the read actually failed.
			if (files.length === 0) {
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.meta.dir).toBe(locked);
			} else {
				expect(files).toEqual(["hidden.txt"]);
			}
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});

	/**
	 * The message has to state the consequence, not just that a call failed. Whoever reads it is
	 * looking at a tool output they cannot open, and "unreachable" is the fact that explains it.
	 */
	it("says the outputs are unreachable rather than only naming an errno", async () => {
		const notADir = path.join(root, "again-a-file");
		fs.writeFileSync(notADir, "x");

		await new ArtifactManager(notADir).listFiles();

		expect(warnings[0]?.message).toContain("unreachable");
	});
});

describe("peeking at a session file for cold revival", () => {
	/**
	 * A path that was never written is a genuine miss: the caller's "no such session" is true, and
	 * warning would fire on every speculative peek.
	 */
	it("returns null without warning when the file does not exist", async () => {
		expect(await SessionManager.peekSessionInit(path.join(root, "no-such-session.jsonl"))).toBeNull();
		expect(warnings).toEqual([]);
	});

	/**
	 * An empty file parses to no entries, which is not a read failure. It must stay quiet: the file is
	 * readable and simply has nothing to revive from, so there is no loss to report.
	 */
	it("returns null without warning for a readable file with no entries", async () => {
		const empty = path.join(root, "empty.jsonl");
		fs.writeFileSync(empty, "");

		expect(await SessionManager.peekSessionInit(empty)).toBeNull();
		expect(warnings).toEqual([]);
	});

	/**
	 * The case this exists for: a session file is right where the user left it and could not be loaded.
	 * A directory in a session file's place fails with EISDIR, which is not ENOENT, so the null the
	 * caller still receives is accompanied by a report naming the path.
	 */
	it("reports a path that exists but cannot be loaded", async () => {
		const dirInPlaceOfFile = path.join(root, "session.jsonl");
		fs.mkdirSync(dirInPlaceOfFile);

		expect(await SessionManager.peekSessionInit(dirInPlaceOfFile)).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Session file exists but could not be loaded; treating it as missing");
		expect(warnings[0]?.meta.path).toBe(dirInPlaceOfFile);
		expect(typeof warnings[0]?.meta.error).toBe("string");
	});

	/**
	 * The wording matters as much as the warning. "Treating it as missing" tells the reader that the
	 * null they are about to see is a decision this code made, not a fact about their disk, which is
	 * exactly what the silent version left them unable to work out.
	 */
	it("says the file exists and is being treated as missing", async () => {
		const dirInPlaceOfFile = path.join(root, "other-session.jsonl");
		fs.mkdirSync(dirInPlaceOfFile);

		await SessionManager.peekSessionInit(dirInPlaceOfFile);

		expect(warnings[0]?.message).toContain("exists");
		expect(warnings[0]?.message).toContain("treating it as missing");
	});
});
