/**
 * Listing sessions: "no sessions" and "could not look" must not print the same.
 *
 * WHY THIS SUITE EXISTS. This listing is what the session picker and `--resume` show you. Both the
 * cross-project scan and the per-directory storage seam answered any failure with an empty list, so
 * a sessions directory that exists but cannot be scanned presented as a user with no sessions: the
 * picker came up empty, `--resume` had nothing to offer, and your work looked gone. Nothing was
 * logged, so there was nothing to disagree with.
 *
 * The distinction is drawn where the truth differs, matching the session parser in `@veyyon/stats`
 * that had the same defect. An ABSENT directory is an empty list in silence, which is a fresh
 * install and also a project you have not used yet. A directory that is there and unreadable is
 * reported, and the empty list is still returned on purpose: a picker that cannot list is more
 * useful empty than crashed, and the log is the entire difference between a loss you can see and one
 * you cannot.
 *
 * The tests assert the warning rather than the return value, because the return value is
 * deliberately identical in both cases.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { FileSessionStorage } from "../../src/session/session-storage";

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
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-session-listing-"));
});

afterEach(() => {
	restore();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a directory that can be listed", () => {
	/** The ordinary case: matches come back, non-matches do not, and nothing is reported. */
	it("returns the matching files and warns about nothing", () => {
		fs.writeFileSync(path.join(root, "one.jsonl"), "{}\n");
		fs.writeFileSync(path.join(root, "two.jsonl"), "{}\n");
		fs.writeFileSync(path.join(root, "notes.md"), "ignored");

		const files = new FileSessionStorage().listFilesSync(root, "*.jsonl");

		expect(files.map(file => path.basename(file)).sort()).toEqual(["one.jsonl", "two.jsonl"]);
		expect(warnings).toEqual([]);
	});

	/** A real directory with nothing matching is genuinely empty, and silence is the right answer. */
	it("returns an empty list quietly when nothing matches", () => {
		fs.writeFileSync(path.join(root, "readme.md"), "no sessions");

		expect(new FileSessionStorage().listFilesSync(root, "*.jsonl")).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a directory that is not there", () => {
	/**
	 * Absent must stay quiet. A project you have never opened has no session directory, and warning
	 * here would fire on ordinary use and teach the reader to ignore the warning that matters.
	 */
	it("returns an empty list without warning", () => {
		expect(new FileSessionStorage().listFilesSync(path.join(root, "no-such-project"), "*.jsonl")).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a directory that is there and cannot be listed", () => {
	/**
	 * The case this exists for. The sessions are invisible to this run, the caller carries on with an
	 * empty list, and the report is the only trace. It names the directory and the pattern, because a
	 * reader who cannot see their sessions needs to know which path to check.
	 */
	it("reports the loss and still returns an empty list", () => {
		const locked = path.join(root, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "hidden.jsonl"), "{}\n");
		fs.chmodSync(locked, 0o000);
		try {
			const files = new FileSessionStorage().listFilesSync(locked, "*.jsonl");

			// Permission bits do not bind root; when the scan succeeds anyway the no-warning path is the
			// correct outcome, so the report is only required when the read actually failed.
			if (files.length === 0) {
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.message).toBe(
					"Session directory could not be listed; its sessions are invisible to this run",
				);
				expect(warnings[0]?.meta.dir).toBe(locked);
				expect(warnings[0]?.meta.pattern).toBe("*.jsonl");
				expect(typeof warnings[0]?.meta.error).toBe("string");
			} else {
				expect(files.map(file => path.basename(file))).toEqual(["hidden.jsonl"]);
			}
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});

	/**
	 * A file where a directory was expected fails with ENOTDIR, a different errno from a permission
	 * failure, and it must be reported too. Checked separately so a fix that special-cased EACCES
	 * cannot pass the test above while still swallowing this one.
	 */
	it("reports a path that is a file rather than a directory", () => {
		const notADir = path.join(root, "regular-file");
		fs.writeFileSync(notADir, "not a directory");

		expect(new FileSessionStorage().listFilesSync(notADir, "*.jsonl")).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.meta.dir).toBe(notADir);
	});
});

describe("what the report has to say", () => {
	/**
	 * The reader is looking at an empty session picker. The actionable fact is that sessions exist and
	 * cannot be seen, so the message says that rather than only naming an errno.
	 */
	it("says the sessions are invisible, not merely that a call failed", () => {
		const notADir = path.join(root, "file-again");
		fs.writeFileSync(notADir, "x");

		new FileSessionStorage().listFilesSync(notADir, "*.jsonl");

		expect(warnings[0]?.message).toContain("invisible to this run");
	});
});
