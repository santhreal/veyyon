/**
 * Cancelling a search stops the search, not just the promise waiting on it.
 *
 * WHY THIS SUITE EXISTS (TOOLE-1-ABORT). `grep` and `glob` do their work inside
 * the Rust natives rather than in a child process, so the bash suite's proof
 * (`kill(pid, 0)` against a pid the grandchild recorded) has nothing to point
 * at: there is no pid. That absence is what made the gap easy to miss, because
 * "no orphaned process" is trivially true of a tool that never spawned one, and
 * a suite asserting only the rejection would have been green throughout.
 *
 * THE DEFECT THIS SUITE FOUND. Both tools wrap their body in `untilAborted`,
 * which REJECTS on abort and cancels nothing: the inner promise runs to
 * completion regardless. Stopping the actual work is the native's job, and the
 * natives take the signal for exactly that. But `CancelToken::new` only called
 * `AbortSignal::on_abort`, which registers a listener for the abort EVENT, and a
 * signal that has ALREADY fired never emits it again. So a native handed an
 * already-aborted signal registered a listener that would never run, checked a
 * token that was never marked, ran the whole scan, and RESOLVED with a full
 * result set. Cancelled work returning results indistinguishable from real ones
 * is the worst shape this can take: nothing downstream can notice.
 *
 * The JS entry guards hide that for a single call and not for a loop. The grep
 * tool's `nativeChunkedLineIndexes` calls back into the native per chunk with
 * the same signal, so a cancellation between chunks handed every later chunk an
 * already-aborted signal and bought a full scan for each.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. The obvious test is a timing one: walk
 * a big tree, cancel partway, require the cancelled walk back sooner. It was
 * tried and abandoned, and the reason is worth recording so nobody re-adds it.
 * The natives are parallel and fast enough that 40k files across 200 directories
 * (159 MB) greps in 130 ms on this machine, so the baseline never clears the
 * noise floor, and a fixture large enough to clear it is not a fixture a test
 * suite should build. The mechanism test below is deterministic, runs in
 * milliseconds, and is what actually caught the bug.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { GlobTool } from "@veyyon/coding-agent/tools/glob";
import { GrepTool } from "@veyyon/coding-agent/tools/grep";
import { glob as nativeGlob, GrepOutputMode, grep as nativeGrep } from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

let settingsState: SettingsTestState | undefined;
let tmpDir = "";

/** A tree big enough to be a real walk and small enough to build per file. The
 * assertions below are on behaviour rather than on time, so size is not load
 * bearing here; it only has to contain something findable. */
const DIRS = 8;
const FILES_PER_DIR = 25;

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-abort-"));
	for (let d = 0; d < DIRS; d++) {
		const dir = path.join(tmpDir, `pkg-${d}`, "src", "nested");
		await fs.mkdir(dir, { recursive: true });
		await Promise.all(
			Array.from({ length: FILES_PER_DIR }, (_, f) =>
				fs.writeFile(path.join(dir, `mod-${f}.ts`), `export const id = "${d}-${f}";\n`.repeat(8)),
			),
		);
	}
});

afterAll(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	if (tmpDir) await removeWithRetries(tmpDir);
});

function session() {
	return makeToolSession({
		cwd: tmpDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "glob.enabled": true }),
	});
}

/** An already-spent signal: the exact input that used to be ignored. */
function spentSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
	return result.content?.find(c => c.type === "text")?.text ?? "";
}

describe("the natives refuse work under a signal that has already fired", () => {
	/**
	 * THE REGRESSION, at the layer that had it. This resolved with a full match
	 * list before `CancelToken::new` learned to read `signal.aborted` up front.
	 * Asserted on the native rather than through the tool on purpose: the tool's
	 * `untilAborted` entry guard rejects first, so a tool-level test cannot reach
	 * this code path at all and would have stayed green through the whole bug.
	 */
	it("grep rejects instead of returning a full result set", async () => {
		const call = nativeGrep(
			{
				pattern: "export const id",
				path: tmpDir,
				ignoreCase: false,
				multiline: false,
				hidden: true,
				gitignore: false,
				maxCount: 1000,
				contextBefore: 0,
				contextAfter: 0,
				maxColumns: 200,
				mode: GrepOutputMode.Content,
				signal: spentSignal(),
			},
			undefined,
		);

		await expect(call).rejects.toThrow();
	});

	/**
	 * Every native entry point routes its `signal` through the same
	 * `CancelToken::new`, so glob is not a second implementation to fix but the
	 * proof that the fix is at the shared owner. If glob ever diverges, one of
	 * these two fails and the other does not, which is the signal to look for a
	 * second cancellation path rather than a second bug.
	 */
	it("glob rejects instead of walking the whole tree", async () => {
		const signal = spentSignal();
		const rejected = await new Promise<boolean>(resolve => {
			try {
				nativeGlob({ patterns: ["**/*.ts"], cwd: tmpDir, hidden: true, gitignore: false, signal }, (err: unknown) =>
					resolve(err !== null && err !== undefined),
				);
			} catch {
				resolve(true);
			}
		});

		expect(rejected).toBe(true);
	});

	/**
	 * The guard on the guard. Both assertions above are satisfied by a native that
	 * refuses everything, so the same call under a live signal has to succeed.
	 */
	it("grep still returns matches under a signal that has not fired", async () => {
		const result = await nativeGrep(
			{
				pattern: "export const id",
				path: tmpDir,
				ignoreCase: false,
				multiline: false,
				hidden: true,
				gitignore: false,
				maxCount: 1000,
				contextBefore: 0,
				contextAfter: 0,
				maxColumns: 200,
				mode: GrepOutputMode.Content,
				signal: new AbortController().signal,
			},
			undefined,
		);

		expect(result.matches.length).toBeGreaterThan(0);
	});
});

describe("glob", () => {
	const globArgs = { path: "**/*.ts", limit: 200 };

	it("rejects with an abort rather than resolving with a short result list", async () => {
		// The silent-success shape is the dangerous one: a cancelled search that
		// RESOLVES with whatever it had found so far reads as "these are all the
		// matches", and an agent acting on that concludes a file does not exist. An
		// absence claim from a cancelled search is a lie.
		let error: Error | undefined;
		try {
			await new GlobTool(session() as never).execute("g-pre", globArgs, spentSignal());
		} catch (err) {
			error = err as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message.toLowerCase()).toContain("abort");
	});

	it("still returns matches when the signal is never aborted", async () => {
		const result = await new GlobTool(session() as never).execute("g-ok", globArgs, new AbortController().signal);

		expect(textOf(result)).toContain("mod-0.ts");
	});
});

describe("grep", () => {
	const grepArgs = { pattern: "export const id", path: "." };

	it("rejects with an abort rather than reporting no matches", async () => {
		// Worse than the glob case, because grep's empty result IS its answer: a
		// cancelled search that resolves with zero matches is indistinguishable
		// from one that genuinely found nothing, and that is exactly the claim an
		// agent uses to decide a symbol is unused.
		let error: Error | undefined;
		try {
			await new GrepTool(session() as never).execute("s-pre", grepArgs as never, spentSignal());
		} catch (err) {
			error = err as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message.toLowerCase()).toContain("abort");
	});

	it("still finds a real match when the signal is never aborted", async () => {
		// Non-vacuity, and it also proves the fixture is greppable at all: an
		// unreadable tree would make every assertion above pass for the wrong
		// reason.
		const result = await new GrepTool(session() as never).execute(
			"s-ok",
			grepArgs as never,
			new AbortController().signal,
		);

		expect(textOf(result)).toContain("mod-0.ts");
	});
});
