/**
 * Listing sessions: an empty result must mean "there are none", never "we could not look".
 *
 * WHY THIS SUITE EXISTS. Every number the dashboard shows is a sum over the entries in the session
 * files these two functions find. Both used to answer any failure with the same empty array, so a
 * sessions directory that exists but cannot be read was indistinguishable from a user who has never
 * run a session, and the dashboard reported zero of everything with nothing to suggest otherwise.
 * `syncAllSessions` makes that worse by returning early on an empty list: it reports success, having
 * read nothing.
 *
 * The distinction is now drawn where the truth differs. An ABSENT directory really is zero sessions,
 * which is what a fresh install looks like, and it stays quiet. A directory that is present and
 * unreadable is a loss, and it is reported through the same logger the unparseable-line reporter
 * beside it uses, with the same framing: the sessions are missing from every statistic.
 *
 * The tests assert the warning, not just the return value, because the return value is the same in
 * both cases by design: the sync keeps going with the folders it could read (a permissions problem
 * on one project must not take the whole dashboard down). The warning is the entire difference
 * between a loss you can see and one you cannot, so it is what has to be pinned.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { listSessionFiles } from "../src/parser";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let warnings: Warning[];
let restore: () => void;
let root: string;

beforeEach(async () => {
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-stats-listing-"));
});

afterEach(async () => {
	restore();
	await fs.rm(root, { recursive: true, force: true });
});

describe("a folder that is there and readable", () => {
	/** The ordinary case: the `.jsonl` files are found and nothing is reported. */
	it("returns its session files and warns about nothing", async () => {
		await fs.writeFile(path.join(root, "a.jsonl"), "{}\n");
		await fs.writeFile(path.join(root, "notes.txt"), "ignored");
		await fs.mkdir(path.join(root, "nested"));
		await fs.writeFile(path.join(root, "nested", "b.jsonl"), "{}\n");

		const files = await listSessionFiles(root);

		expect(files.map(file => path.relative(root, file)).sort()).toEqual(["a.jsonl", path.join("nested", "b.jsonl")]);
		expect(warnings).toEqual([]);
	});

	/** A real folder with no transcripts in it is genuinely empty, and silence is the right answer. */
	it("returns an empty list quietly when it holds no session files", async () => {
		await fs.writeFile(path.join(root, "readme.md"), "no sessions here");

		expect(await listSessionFiles(root)).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a folder that is not there", () => {
	/**
	 * Absent is not an anomaly. A fresh install has no sessions directory, and a folder can be
	 * removed between the listing and the walk, so warning here would train the reader to ignore the
	 * warning that matters.
	 */
	it("returns an empty list without warning", async () => {
		expect(await listSessionFiles(path.join(root, "never-existed"))).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a folder that is there and cannot be read", () => {
	/**
	 * The case this suite exists for. Sessions inside an unreadable folder are gone from every total,
	 * and the caller keeps going deliberately (one unreadable project must not blank the whole
	 * dashboard), so the report is the only trace. It names the path and the underlying error, because
	 * "something failed" does not tell you whose permissions to fix.
	 */
	it("reports the loss and keeps going", async () => {
		const locked = path.join(root, "locked");
		await fs.mkdir(locked);
		await fs.writeFile(path.join(locked, "hidden.jsonl"), "{}\n");
		await fs.chmod(locked, 0o000);
		try {
			const files = await listSessionFiles(locked);

			// Running as root defeats the permission bits entirely; the file is then readable and the
			// no-warning path is the correct outcome, so only assert the report when the read did fail.
			if (files.length === 0) {
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.message).toBe(
					"Session folder could not be read; its sessions are missing from every statistic",
				);
				expect(warnings[0]?.meta.path).toBe(locked);
				expect(typeof warnings[0]?.meta.error).toBe("string");
				expect(warnings[0]?.meta.error).not.toBe("");
			} else {
				expect(files.map(file => path.basename(file))).toEqual(["hidden.jsonl"]);
			}
		} finally {
			await fs.chmod(locked, 0o700);
		}
	});

	/**
	 * A file where a folder was expected fails with ENOTDIR, which is not ENOENT and must therefore be
	 * reported: the path is there, and the walk still found nothing. This is the same class of fault
	 * as a permission failure and it is checked separately because it exercises a different errno, so
	 * a fix that special-cased only EACCES would pass the test above and still swallow this.
	 */
	it("reports a path that is a file rather than a folder", async () => {
		const notAFolder = path.join(root, "regular-file");
		await fs.writeFile(notAFolder, "not a directory");

		expect(await listSessionFiles(notAFolder)).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			"Session folder could not be read; its sessions are missing from every statistic",
		);
		expect(warnings[0]?.meta.path).toBe(notAFolder);
	});
});

describe("the report itself", () => {
	/**
	 * It has to say that statistics are affected, not merely that a read failed. The reader of this
	 * warning is looking at a dashboard, and the actionable part is that the numbers in front of them
	 * are incomplete; a bare "EACCES" leaves them trusting the totals.
	 */
	it("says the sessions are missing from every statistic", async () => {
		const notAFolder = path.join(root, "file-again");
		await fs.writeFile(notAFolder, "x");

		await listSessionFiles(notAFolder);

		expect(warnings[0]?.message).toContain("missing from every statistic");
	});
});
