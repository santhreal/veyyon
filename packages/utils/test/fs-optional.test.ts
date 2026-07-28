/**
 * An optional filesystem read may be ABSENT quietly. It may not FAIL quietly.
 *
 * WHY THIS SUITE EXISTS. `await fs.readdir(dir).catch(() => [])` appears all over the tree and it is right
 * about the common case: `~/.veyyon/agents` usually does not exist, and a project without `.veyyon/` is not
 * an error. It is wrong about every other case, and wrong in the way that costs the most, because a
 * directory that exists and cannot be LISTED collapses to the same empty array. The user's subagents
 * disappear from `/agents`, a managed-skills sweep sees nothing to keep, a plugin scan finds no plugins --
 * and nothing fails, so nobody looks. That is the silent-fallback shape Law 10 bans, wearing a one-line
 * idiom that reads as defensive coding.
 *
 * `readdirIfPresent` and `statIfPresent` are the one place that decision is made, so this suite pins both
 * halves of it. The quiet half is as important as the loud one: a helper that reported ENOENT would put a
 * warning in the log for every optional directory a normal launch probes, which is how a real report gets
 * tuned out. So the assertions are paired -- missing is silent, unreadable is reported, and both return
 * the empty answer the caller has to work with either way.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, readdirIfPresent, statIfPresent } from "../src/index";

const created: string[] = [];
const restricted: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-fs-optional-"));
	created.push(dir);
	return dir;
}

/** Mode bits do not restrict root, and Windows does not honour them. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

/** Take a mode away and remember to restore it, since cleanup needs the permission back. */
function restrict(target: string, mode: number): void {
	restricted.push(target);
	fs.chmodSync(target, mode);
}

afterEach(() => {
	for (const target of restricted.splice(0)) fs.chmodSync(target, 0o700);
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `body` with `logger.warn` captured, returning both the result and the warnings it produced. */
async function withWarnings<T>(body: () => Promise<T>): Promise<{ result: T; warnings: Array<[string, unknown]> }> {
	const warnings: Array<[string, unknown]> = [];
	const spy = spyOn(logger, "warn").mockImplementation((message: string, fields?: unknown) => {
		warnings.push([message, fields]);
	});
	try {
		return { result: await body(), warnings };
	} finally {
		spy.mockRestore();
	}
}

describe("listing a directory that may not be there", () => {
	/** The ordinary find: real entries come back, with their kinds intact. */
	it("returns the entries of a directory that exists", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "one.md"), "one");
		fs.mkdirSync(path.join(dir, "sub"));

		const { result, warnings } = await withWarnings(() => readdirIfPresent(dir, "test entries"));

		expect(result.map(entry => entry.name).sort()).toEqual(["one.md", "sub"]);
		expect(result.find(entry => entry.name === "sub")?.isDirectory()).toBe(true);
		expect(result.find(entry => entry.name === "one.md")?.isFile()).toBe(true);
		expect(warnings).toEqual([]);
	});

	/**
	 * The quiet half, and the reason it must stay quiet: this is the state of nearly every optional config
	 * directory on a normal launch. A helper that warned here would print a line per probe and train the
	 * operator to ignore the one that matters.
	 */
	it("returns an empty list for a directory that does not exist, silently", async () => {
		const dir = path.join(tempDir(), "never-created");

		const { result, warnings } = await withWarnings(() => readdirIfPresent(dir, "test entries"));

		expect(result).toEqual([]);
		expect(warnings).toEqual([]);
	});

	/** An empty directory is not a missing one, and it must also be silent. */
	it("returns an empty list for an empty directory, silently", async () => {
		const { result, warnings } = await withWarnings(() => readdirIfPresent(tempDir(), "test entries"));

		expect(result).toEqual([]);
		expect(warnings).toEqual([]);
	});

	/**
	 * The loud half: the failure the `.catch(() => [])` idiom hid. The report has to carry the path AND
	 * what the caller was looking for, because "a directory could not be listed" is not actionable on its
	 * own -- the operator needs to know that it was their agent definitions that vanished.
	 */
	it("reports a directory that exists but cannot be listed", async () => {
		if (!canRestrictAccess()) return;
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "hidden.md"), "hidden");
		restrict(dir, 0o000);

		const { result, warnings } = await withWarnings(() => readdirIfPresent(dir, "agent definitions"));

		expect(result).toEqual([]);
		expect(warnings).toHaveLength(1);
		// THE FILE LOG STILL GETS IT, which is what this assertion is for. The report now goes through
		// `reportFault`, so it also reaches an attached operator surface, and `reportFault` writes the log
		// line FIRST and unconditionally: attaching a sink can only add reach, never replace the record a
		// later reader diagnoses from. The wording changed with the routing, and deliberately. "Could not
		// list a directory" names the syscall; what an operator needs is what they have LOST, because the
		// empty array they are about to see is indistinguishable from "nothing configured".
		expect(warnings[0]?.[0]).toContain("agent definitions");
		expect(warnings[0]?.[0]).toContain("could not be listed");
		expect(warnings[0]?.[0]).toContain("continuing without any");
		const [, context] = warnings[0] ?? [];
		expect(context).toMatchObject({ dir, what: "agent definitions" });
		// Pulled out of the array first rather than read through `warnings[0]?.[1].error`.
		// The optional chain short-circuits to `undefined` and the property read then
		// throws a TypeError, so a missing warning failed this test with a stack trace
		// about reading a property instead of the assertion above saying what was absent.
		expect(String((context as { error: unknown }).error)).toContain("EACCES");
	});

	/**
	 * A file where a directory was expected is a caller bug, not an absent directory, so it must not be
	 * silently reclassified as "nothing here" either. ENOTDIR names the actual mistake.
	 */
	it("reports a path that is a file rather than a directory", async () => {
		const file = path.join(tempDir(), "not-a-dir");
		fs.writeFileSync(file, "content");

		const { result, warnings } = await withWarnings(() => readdirIfPresent(file, "test entries"));

		expect(result).toEqual([]);
		expect(warnings).toHaveLength(1);
		const [, context] = warnings[0] ?? [];
		expect(String((context as { error: unknown }).error)).toContain("ENOTDIR");
	});
});

describe("stat-ing a path that may not be there", () => {
	/** The ordinary find, with a real field asserted so a stub could not satisfy it. */
	it("returns the stat of a path that exists", async () => {
		const dir = tempDir();
		const file = path.join(dir, "sized.txt");
		fs.writeFileSync(file, "1234567890");

		const { result, warnings } = await withWarnings(() => statIfPresent(file, "test file"));

		expect(result?.size).toBe(10);
		expect(result?.isFile()).toBe(true);
		expect(warnings).toEqual([]);
	});

	/** Absence is the answer, reported as `undefined` and nothing else. */
	it("returns undefined for a path that does not exist, silently", async () => {
		const { result, warnings } = await withWarnings(() => statIfPresent(path.join(tempDir(), "gone"), "test file"));

		expect(result).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	/**
	 * And a path that cannot be stat'd is reported. Without this, an unreadable parent turns every path
	 * under it into "does not exist", which is the same invisible answer the helpers exist to prevent.
	 */
	it("reports a path whose parent cannot be traversed", async () => {
		if (!canRestrictAccess()) return;
		const dir = tempDir();
		const file = path.join(dir, "inside", "file.txt");
		fs.mkdirSync(path.dirname(file));
		fs.writeFileSync(file, "content");
		restrict(path.join(dir, "inside"), 0o000);

		const { result, warnings } = await withWarnings(() => statIfPresent(file, "a plan file"));

		expect(result).toBeUndefined();
		expect(warnings).toHaveLength(1);
		// Same routing change as above. "Treating it as absent" is kept in the wording because it is the
		// dangerous part: the caller behaves as though the path is not there, so the operator has to be
		// told the absent answer is a guess rather than a fact.
		expect(warnings[0]?.[0]).toContain("a plan file");
		expect(warnings[0]?.[0]).toContain("treated as absent");
		expect(warnings[0]?.[1]).toMatchObject({ path: file, what: "a plan file" });
	});
});
