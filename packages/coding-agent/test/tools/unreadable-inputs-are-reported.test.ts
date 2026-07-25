/**
 * Tool-side reads that fail must not be reported as reads that found nothing.
 *
 * WHY THIS SUITE EXISTS. Three places under `src/tools` answered every failure with the value that
 * also means "there is nothing here", so the loss was invisible to the person affected by it.
 *
 * `findArtifactPath` resolves an `artifact://<id>` reference by listing the session's artifact
 * directory. A `catch` returning `null` meant an unreadable directory presented as an artifact that
 * does not exist, which is what a reader is told when they follow the recovery link under a truncated
 * tool output. The file was there.
 *
 * `#trySummarize` decides whether a read comes back as an outline or as the whole file. Every failure
 * became `null`, and `null` is also the answer for a file that has nothing worth folding, so a file
 * the summarizer could not parse looked like a file with no structure. The decision is now in
 * `summarizeFailureReport`, which is what this suite pins: the split between a cancellation (quiet,
 * because the caller asked for the stop and the read path reports it) and a real failure (reported,
 * because what you see changed).
 *
 * `openAutoQaDb` returns `null` both when auto-QA has never been used and when its database cannot be
 * opened, and the CLI printed "enable auto-QA" for both. On a machine that had already enabled it,
 * that is advice which cannot help and it hides the fact that reports are being dropped.
 * `grievanceDbUnavailable` is now the one owner of that explanation and tells the two apart.
 *
 * Each of these keeps its return value on purpose: a read must not fail because its artifact is
 * unreachable, a read must not fail because it could not be summarized, and a CLI must not crash
 * because a database is missing. The report is the entire fix, so the report is what is asserted.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { findArtifactPath } from "@veyyon/coding-agent/tools/fetch";
import { summarizeFailureReport } from "@veyyon/coding-agent/tools/read";
import { errorMessage, logger } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

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
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-tool-reads-"));
});

afterEach(() => {
	restore();
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The only part of a session `findArtifactPath` touches: where the artifacts live.
 *
 * Built through the typed helper rather than `as unknown as ToolSession`, which
 * `tool-session-stub-typing.test.ts` bans: the cast switches off checking of the
 * one member this stub sets, so a misspelled `getArtifactsDir` would be accepted
 * as an excess property and every test below would pass against a session that
 * configures nothing.
 */
function sessionWithArtifactsDir(dir: string | null): ToolSession {
	return makeToolSession({ getArtifactsDir: () => dir });
}

describe("resolving an artifact:// reference", () => {
	/** The ordinary hit: the file whose name starts with the id, extension included. */
	it("returns the artifact file and warns about nothing", async () => {
		const dir = path.join(root, "artifacts");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "abc123.txt"), "the full output");

		expect(await findArtifactPath(sessionWithArtifactsDir(dir), "abc123")).toBe(path.join(dir, "abc123.txt"));
		expect(warnings).toEqual([]);
	});

	/** A readable directory that simply has no such artifact is a genuine miss, and it stays quiet. */
	it("returns null quietly when the directory holds no matching artifact", async () => {
		const dir = path.join(root, "artifacts-empty");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "other.txt"), "not it");

		expect(await findArtifactPath(sessionWithArtifactsDir(dir), "abc123")).toBeNull();
		expect(warnings).toEqual([]);
	});

	/**
	 * A session that has never written an artifact has no directory. This must stay quiet: it is the
	 * state of every new session, and a warning here would fire on ordinary use.
	 */
	it("returns null quietly when the directory does not exist", async () => {
		const missing = path.join(root, "never-created");

		expect(await findArtifactPath(sessionWithArtifactsDir(missing), "abc123")).toBeNull();
		expect(warnings).toEqual([]);
	});

	/** No artifact wiring at all is not a failure either; there is simply nowhere to look. */
	it("returns null quietly when the session has no artifacts directory", async () => {
		expect(await findArtifactPath(sessionWithArtifactsDir(null), "abc123")).toBeNull();
		expect(warnings).toEqual([]);
	});

	/**
	 * The case this exists for. A file where the artifact directory should be fails with ENOTDIR, and
	 * the null the caller still gets is now accompanied by a report naming the directory and the id, so
	 * a dead recovery link can be traced to the directory rather than blamed on a missing artifact.
	 */
	it("reports a directory that exists and cannot be read", async () => {
		const notADir = path.join(root, "artifacts-is-a-file");
		fs.writeFileSync(notADir, "not a directory");

		expect(await findArtifactPath(sessionWithArtifactsDir(notADir), "abc123")).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Artifact directory could not be read; the artifact cannot be resolved");
		expect(warnings[0]?.meta.dir).toBe(notADir);
		expect(warnings[0]?.meta.artifactId).toBe("abc123");
		expect(typeof warnings[0]?.meta.error).toBe("string");
		expect(warnings[0]?.meta.error).not.toBe("");
	});

	/**
	 * A permission failure is a different errno from ENOTDIR, checked separately so a fix that
	 * special-cased one cannot pass the test above and still swallow the other.
	 */
	it("reports a directory whose permissions deny the listing", async () => {
		const locked = path.join(root, "locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "abc123.txt"), "hidden");
		fs.chmodSync(locked, 0o000);
		try {
			const found = await findArtifactPath(sessionWithArtifactsDir(locked), "abc123");

			// Permission bits do not bind root; when the listing succeeds anyway, silence is correct.
			if (found === null) {
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.meta.dir).toBe(locked);
			} else {
				expect(found).toBe(path.join(locked, "abc123.txt"));
			}
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});
});

describe("deciding whether a failed summarize is worth reporting", () => {
	/**
	 * A parse or read failure changes what you see: the whole file instead of an outline. It is
	 * reported, and the message carried is the error's own, so the log names the actual cause.
	 */
	it("reports an ordinary failure with the error's message", () => {
		const error = new Error("Unexpected token at line 12");

		expect(summarizeFailureReport(error)).toBe("Unexpected token at line 12");
	});

	/** A thrown non-Error still has to produce something readable rather than "[object Object]". */
	it("reports a thrown value that is not an Error", () => {
		expect(summarizeFailureReport("parser exploded")).toBe(errorMessage("parser exploded"));
		expect(summarizeFailureReport({ code: "EPARSE" })).toBe(errorMessage({ code: "EPARSE" }));
	});

	/**
	 * Cancellation is the caller's own decision and the read path already reports it, so reporting it
	 * again here would put a warning in the log for every interrupted read. This is the case that makes
	 * the helper worth having rather than warning unconditionally in the catch.
	 */
	it("stays quiet for an abort", () => {
		const abort = new Error("This operation was aborted");
		abort.name = "AbortError";

		expect(summarizeFailureReport(abort)).toBeNull();
	});

	/**
	 * A timeout arrives as its own error name rather than as an abort, which the read path had to be
	 * corrected for once already. It must be quiet here for the same reason an abort is.
	 */
	it("stays quiet for a timeout", () => {
		const timeout = new Error("The operation timed out");
		timeout.name = "TimeoutError";

		expect(summarizeFailureReport(timeout)).toBeNull();
	});

	/**
	 * The failure that is NOT a cancellation must never be mistaken for one, whatever its message says.
	 * A file whose contents mention "aborted" is still a summarize failure worth reporting.
	 */
	it("does not treat an error that merely mentions aborting as a cancellation", () => {
		expect(summarizeFailureReport(new Error("the parse aborted midway"))).toBe("the parse aborted midway");
	});
});
