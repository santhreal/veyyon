/**
 * `listLocalPlanFileUrls`: the plan-approval fallback, with one owner and one reason.
 *
 * WHY THIS SUITE EXISTS. When a plan reference arrives without its title, plan approval falls back to
 * the newest `*plan.md` in the session-local root. The interactive path and the ACP path each had
 * their own copy of that walk, byte-identical apart from how they resolved the root, and both copies
 * ended in a `catch` returning an empty array. Two problems in one: the rule lived in two places, so a
 * fix would have had to be made twice, and an unreadable local root was indistinguishable from a
 * session that has written no plan, which left plan approval quietly offering nothing.
 *
 * There is now one owner beside `resolveLocalRoot`, and it draws the line at ENOENT. A root that does
 * not exist is an empty list in silence, because that is every new session. Anything else is reported
 * and still returns empty, because plan approval must keep working when it cannot enumerate fallbacks.
 *
 * Newest-first is asserted with real mtimes rather than insertion order, since the ordering IS the
 * feature: the fallback picks the first entry, so a wrong sort hands the user the wrong plan.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listLocalPlanFileUrls } from "@veyyon/coding-agent/internal-urls/local-protocol";
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
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-local-plans-"));
});

afterEach(() => {
	restore();
	fs.rmSync(root, { recursive: true, force: true });
});

/** Write a file and stamp its mtime, so the ordering under test is the mtime and not the write order. */
function writePlan(name: string, mtimeMs: number): void {
	const target = path.join(root, name);
	fs.writeFileSync(target, `# ${name}\n`);
	fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
}

describe("a local root holding plan files", () => {
	/**
	 * Newest first, by mtime. The caller takes the first URL as "the plan the user just wrote", so this
	 * ordering is the whole contract; alphabetical order here would hand back the wrong plan.
	 */
	it("returns local:// URLs newest first", async () => {
		writePlan("older-plan.md", 1_600_000_000_000);
		writePlan("newest-plan.md", 1_700_000_000_000);
		writePlan("middle-plan.md", 1_650_000_000_000);

		expect(await listLocalPlanFileUrls(root)).toEqual([
			"local://newest-plan.md",
			"local://middle-plan.md",
			"local://older-plan.md",
		]);
		expect(warnings).toEqual([]);
	});

	/** Only files whose name ends in `plan.md` are plans; everything else in the root is scratch space. */
	it("ignores files that are not plans", async () => {
		writePlan("plan.md", 1_700_000_000_000);
		fs.writeFileSync(path.join(root, "notes.md"), "not a plan");
		fs.writeFileSync(path.join(root, "plan.md.bak"), "not a plan either");
		fs.writeFileSync(path.join(root, "output.txt"), "nor this");

		expect(await listLocalPlanFileUrls(root)).toEqual(["local://plan.md"]);
	});

	/** The suffix match is case-insensitive, because the name comes from whatever the model wrote. */
	it("accepts a capitalized plan suffix", async () => {
		writePlan("MY-PLAN.MD", 1_700_000_000_000);

		expect(await listLocalPlanFileUrls(root)).toEqual(["local://MY-PLAN.MD"]);
	});

	/** A directory named like a plan is not a plan file, and must not be offered as one. */
	it("ignores a directory whose name looks like a plan", async () => {
		fs.mkdirSync(path.join(root, "archive-plan.md"));
		writePlan("real-plan.md", 1_700_000_000_000);

		expect(await listLocalPlanFileUrls(root)).toEqual(["local://real-plan.md"]);
	});

	/** A root with nothing matching is genuinely empty, and silence is the right answer. */
	it("returns an empty list quietly when it holds no plans", async () => {
		fs.writeFileSync(path.join(root, "readme.md"), "no plans");

		expect(await listLocalPlanFileUrls(root)).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a local root that is not there", () => {
	/**
	 * Absent must stay quiet: every session starts with no local root, so a warning here would fire on
	 * ordinary use and teach the reader to ignore the warning that matters.
	 */
	it("returns an empty list without warning", async () => {
		expect(await listLocalPlanFileUrls(path.join(root, "never-created"))).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe("a local root that is there and cannot be read", () => {
	/**
	 * The case this exists for. The empty list is still returned, because plan approval must not fail
	 * outright when its fallback list is unavailable, so the report is the only trace. It names the root,
	 * since that is the path whose permissions the reader has to look at.
	 */
	it("reports the loss and still returns an empty list", async () => {
		const notADir = path.join(root, "root-is-a-file");
		fs.writeFileSync(notADir, "not a directory");

		expect(await listLocalPlanFileUrls(notADir)).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			"Local plan root could not be read; plan approval has no plan files to fall back on",
		);
		expect(warnings[0]?.meta.root).toBe(notADir);
		expect(typeof warnings[0]?.meta.error).toBe("string");
		expect(warnings[0]?.meta.error).not.toBe("");
	});

	/**
	 * A permission failure is a different errno from ENOTDIR and must be reported too, so a fix that
	 * special-cased one cannot pass the test above and still swallow the other.
	 */
	it("reports a root whose permissions deny the listing", async () => {
		const locked = path.join(root, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "plan.md"), "# hidden");
		fs.chmodSync(locked, 0o000);
		try {
			const plans = await listLocalPlanFileUrls(locked);

			// Permission bits do not bind root; when the listing succeeds anyway, silence is correct.
			if (plans.length === 0) {
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.meta.root).toBe(locked);
			} else {
				expect(plans).toEqual(["local://plan.md"]);
			}
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});

	/**
	 * The message has to say what the reader loses, not merely that a read failed: a plan approval with
	 * no fallbacks looks like a session with no plans, and that is the sentence that explains it.
	 */
	it("says plan approval has nothing to fall back on", async () => {
		const notADir = path.join(root, "file-again");
		fs.writeFileSync(notADir, "x");

		await listLocalPlanFileUrls(notADir);

		expect(warnings[0]?.message).toContain("fall back on");
	});
});

describe("a plan file that disappears mid-listing", () => {
	/**
	 * The entry was listed and then removed before its mtime could be read, which is routine when a
	 * session is writing plans while the picker opens. It keeps its URL and sorts last rather than
	 * dropping out: reading it reports its own failure, and silently shortening the list would make the
	 * fallback skip a plan without saying so.
	 */
	it("keeps its URL and sorts last", async () => {
		writePlan("kept-plan.md", 1_700_000_000_000);
		const doomed = path.join(root, "vanishing-plan.md");
		fs.writeFileSync(doomed, "# going away");
		// The listing reads `node:fs/promises` directly, so the spy has to sit on that module's own binding;
		// spying on `fs.promises` leaves the call it actually makes untouched and the test passes blind.
		const realStat = fsp.stat;
		const statSpy = spyOn(fsp, "stat").mockImplementation((async (target: string, ...rest: unknown[]) => {
			if (String(target) === doomed) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return (realStat as (t: string, ...r: unknown[]) => Promise<unknown>)(target, ...rest);
		}) as never);
		try {
			expect(await listLocalPlanFileUrls(root)).toEqual(["local://kept-plan.md", "local://vanishing-plan.md"]);
		} finally {
			statSpy.mockRestore();
		}
	});
});
