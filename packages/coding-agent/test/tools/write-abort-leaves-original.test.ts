import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * SIG-1: interrupting a write must leave the file system in a state the operator
 * can reason about, and must say what it did.
 *
 * Ctrl-C is the most-used control in the whole product, and it lands most often
 * exactly when the agent is rewriting files. Two outcomes are acceptable: the
 * file is the OLD content and the tool reports a cancellation, or the file is
 * the NEW content and the tool reports success. Everything else is a trap. A
 * half-written file is unrecoverable, because the content being replaced is
 * usually only in the transcript. A file that was in fact replaced while the
 * tool reported "aborted" is worse still: that is the state nobody goes back to
 * check, so the operator keeps working against content they believe is gone.
 *
 * `test/lsp/aborted-write-does-not-commit.test.ts` proves the PRIMITIVE:
 * `commitFileContentAtomic` refuses to rename once the signal has fired. This
 * suite is the layer above, and it asks the question the primitive cannot: does
 * the tool the agent actually calls route its signal down there at all? A tool
 * that drops the signal on the floor passes every primitive test ever written
 * and still writes through a cancellation.
 *
 * The guarantee comes from `commitFileContentAtomic`, which checks the signal
 * immediately before the rename rather than at the top of the call, and stages
 * the bytes in a sibling temp file. The entry guard alone is NOT enough and the
 * mid-flight cases below prove it: it races `execute` against the signal, so it
 * rejects while the write it started is still running. Delete the pre-rename
 * check and this suite catches the file being replaced about 60ms after the
 * operator was told the write was cancelled. This suite proves the property through the
 * REAL `WriteTool` — the only writer the agent has — on a real temp filesystem,
 * and asserts exact bytes throughout. "The file still exists" would pass on a
 * file that lost half its content.
 *
 * The boundary is stated rather than hidden: a signal that arrives inside the
 * few microseconds between the check and the rename commits, and that is
 * correct. Atomicity is the contract; instantaneous cancellation is not
 * achievable and pretending otherwise would be a lie in the docs.
 */
describe("an interrupted write leaves the original file intact", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir = "";

	/** The bytes every test below expects to survive an interruption. */
	const ORIGINAL = "export const answer = 42;\n// second line\n";
	const REPLACEMENT = "export const answer = 0;\n";

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-abort-"));
	});

	afterEach(async () => {
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = "";
		}
	});

	function tool(): WriteTool {
		return new WriteTool(
			makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => path.join(tmpDir, "s.jsonl"),
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(tmpDir, "artifacts"),
				allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
				settings: Settings.isolated({ "lsp.formatOnWrite": false, "lsp.diagnosticsOnWrite": false }),
				enableLsp: false,
				getPlanModeState: () => ({ enabled: false }),
			}),
		);
	}

	/** Seed a file with {@link ORIGINAL} and return its absolute path. */
	async function seed(name: string): Promise<string> {
		const file = path.join(tmpDir, name);
		await fs.writeFile(file, ORIGINAL);
		return file;
	}

	/** Run a write under an already-aborted signal and capture the rejection. */
	async function abortedWrite(file: string, content = REPLACEMENT): Promise<Error> {
		const controller = new AbortController();
		controller.abort();
		try {
			await tool().execute("w1", { path: file, content }, controller.signal);
		} catch (err) {
			return err as Error;
		}
		throw new Error(`expected the interrupted write to ${file} to reject, but it resolved`);
	}

	/** Everything in the working directory, so temp debris cannot hide. */
	async function entries(): Promise<string[]> {
		return (await fs.readdir(tmpDir)).sort();
	}

	it("leaves the original bytes exactly as they were", async () => {
		const file = await seed("interrupted.ts");

		await abortedWrite(file);

		expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
	});

	it("rejects instead of reporting a write that did not happen", async () => {
		// The silent-success shape is the dangerous one: the agent would move on
		// believing the edit landed and keep building on content that is not there.
		const file = await seed("interrupted-report.ts");

		const error = await abortedWrite(file);

		expect(error).toBeInstanceOf(Error);
		expect(error.message.toLowerCase()).toContain("abort");
	});

	it("leaves no temp sibling behind for the next run to trip over", async () => {
		// The bytes are staged in a hidden `.<name>.<pid>.<n>.tmp` sibling. An
		// interrupt that leaves those behind turns every cancelled write into
		// litter in the user's source tree, and a glob or a build that picks one up
		// sees content that was explicitly cancelled.
		const file = await seed("interrupted-debris.ts");

		await abortedWrite(file);

		expect(await entries()).toEqual(["interrupted-debris.ts"]);
	});

	it("creates nothing at all when the interrupted write was a new file", async () => {
		// The new-file case has no original to protect, so the whole contract is
		// that the path stays absent. A zero-byte file here would read as "the
		// agent created it and it is empty", which is a different and misleading
		// fact than "the write was cancelled".
		const file = path.join(tmpDir, "never-created.ts");

		await abortedWrite(file, "brand new content\n");

		expect(await fs.exists(file)).toBe(false);
		expect(await entries()).toEqual([]);
	});

	/**
	 * Abort from inside the tool's own progress callback.
	 *
	 * The tests above abort BEFORE `execute`, which the entry guard
	 * (`untilAborted`) catches on its own. That is the cheap half. This is the
	 * expensive half and the one Ctrl-C actually produces: the tool has already
	 * started, resolved the path, and reported progress, and the interrupt lands
	 * in the window before the rename. `emitWriteProgress` fires immediately
	 * before the writethrough, so aborting from the callback puts the signal in
	 * exactly that window every run, with no sleep and no race.
	 */
	async function abortedMidFlight(file: string): Promise<Error> {
		const controller = new AbortController();
		try {
			await tool().execute("w1", { path: file, content: REPLACEMENT }, controller.signal, () => {
				controller.abort();
			});
		} catch (err) {
			await settle();
			return err as Error;
		}
		throw new Error(`expected the mid-flight interrupt on ${file} to reject, but it resolved`);
	}

	/**
	 * Outlive a write that may still be in flight after the rejection.
	 *
	 * This wait is the whole point of the mid-flight cases, not padding. The
	 * entry guard RACES the tool against the signal, so `execute` rejects the
	 * instant the abort fires while the write it started keeps running. Asserting
	 * immediately therefore proves nothing: the file is still the original simply
	 * because the racing write has not landed yet. Removing
	 * `commitFileContentAtomic`'s pre-rename check and re-running this suite is
	 * the check that matters, and with this wait in place it fails exactly as it
	 * should — the file becomes the new content roughly 60ms after the operator
	 * was told the write was cancelled. Without the wait, it passes.
	 */
	async function settle(): Promise<void> {
		await Bun.sleep(60);
	}

	it("leaves the original bytes when the interrupt lands after the tool started", async () => {
		const file = await seed("mid-flight.ts");

		await abortedMidFlight(file);

		expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
	});

	it("leaves no temp sibling when the interrupt lands mid-flight", async () => {
		// This is where a staged temp file genuinely exists at the moment of the
		// interrupt, so it is the case that would actually litter the source tree.
		const file = await seed("mid-flight-debris.ts");

		await abortedMidFlight(file);

		expect(await entries()).toEqual(["mid-flight-debris.ts"]);
	});

	it("reports the mid-flight interrupt rather than claiming the write landed", async () => {
		// The specific lie this guards: the operator sees "aborted" and believes
		// the file is untouched. If the commit ran anyway, the report and the disk
		// disagree and nobody goes back to check.
		const file = await seed("mid-flight-report.ts");

		const error = await abortedMidFlight(file);

		expect(error.message.toLowerCase()).toContain("abort");
		expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
	});

	it("still writes normally under a signal that was never aborted", async () => {
		// The control. A guard that rejected every write carrying a signal would
		// pass every assertion above while breaking the product outright, since the
		// agent always passes one.
		const file = await seed("not-interrupted.ts");
		const controller = new AbortController();

		await tool().execute("w1", { path: file, content: REPLACEMENT }, controller.signal);

		expect(await fs.readFile(file, "utf8")).toBe(REPLACEMENT);
		expect(await entries()).toEqual(["not-interrupted.ts"]);
	});

	it("does NOT roll back a write that had already committed when the signal arrived", async () => {
		// The boundary, pinned deliberately so nobody later reads the suite as a
		// promise of undo. Aborting after the rename cannot un-rename; the file is
		// the new content and the operator has to be told that plainly. A test that
		// asserted a rollback here would be asserting a feature that does not and
		// cannot exist.
		const file = await seed("already-committed.ts");
		const controller = new AbortController();

		await tool().execute("w1", { path: file, content: REPLACEMENT }, controller.signal);
		controller.abort();

		expect(await fs.readFile(file, "utf8")).toBe(REPLACEMENT);
	});

	it("keeps the original intact across repeated interruptions", async () => {
		// A user holding Ctrl-C hits this path several times in a row. Each attempt
		// stages a new temp sibling, so a leak that is invisible once becomes
		// obvious here, and any partial-write bug compounds instead of cancelling
		// out.
		const file = await seed("interrupted-repeatedly.ts");

		for (let attempt = 0; attempt < 5; attempt++) {
			await abortedWrite(file, `attempt ${attempt}\n`);
		}

		expect(await fs.readFile(file, "utf8")).toBe(ORIGINAL);
		expect(await entries()).toEqual(["interrupted-repeatedly.ts"]);
	});
});
