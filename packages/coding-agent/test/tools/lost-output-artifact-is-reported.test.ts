/**
 * Output that was produced and can no longer be reached must say so.
 *
 * WHY THIS SUITE EXISTS. `saveOutputArtifact` is the one owner of the `artifact://<id>` spill every
 * tool routes oversized output through, and it answered a failed allocation or write with `undefined`
 * in silence. `undefined` is also how a session with no artifact store at all answers, and the caller
 * treats both the same way: it omits the recovery footer and prints the bounded head/tail window it
 * already built. That window is all there is. The full bytes are kept nowhere else, so a failed write
 * DESTROYS output the operator asked for, and what they see is a truncated result that looks exactly
 * like a normal truncated result.
 *
 * `undefined` is still the return value, deliberately: the visible result is correct without the
 * artifact, and a bash command must not fail because its raw copy could not be written. The report is
 * the entire fix, which is why this suite asserts the report and pins that the return value did not
 * change.
 *
 * The no-store case is asserted to stay SILENT, because that is the distinction the fix rests on: an
 * MCP or extension tool context legitimately has no `allocateOutputArtifact`, nothing is lost, and a
 * warning there would fire on ordinary use and train the reader to ignore the one that matters.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@veyyon/utils";
import type { ToolSession } from "../../src/tools/index";
import { reportLostOutputArtifact, saveOutputArtifact } from "../../src/tools/output-artifact";
import { makeToolSession } from "../helpers/tool-session";

/** Captured `logger.warn` calls: the message and its structured fields. */
type Warning = { message: string; meta: Record<string, unknown> };

let warnings: Warning[];
let restore: () => void;
let dir: string;

beforeEach(() => {
	warnings = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	}) as never);
	restore = () => spy.mockRestore();
	dir = mkdtempSync(path.join(tmpdir(), "veyyon-artifact-loss-"));
});

afterEach(() => {
	restore();
	rmSync(dir, { recursive: true, force: true });
});

/** The one warning this suite is about, picked out of anything else the call may log. */
function lossReports(): Warning[] {
	return warnings.filter(warning => warning.message.includes("could not be saved as an artifact"));
}

/**
 * A tool session whose artifact allocation behaves however the test needs.
 *
 * Built through the shared `makeToolSession` factory rather than a
 * `as unknown as ToolSession` cast. The cast compiles against a session that has
 * NOTHING on it, so a field added to `ToolSession` (or renamed on it) leaves every
 * stub silently missing that field and the suite goes on passing against a shape
 * production never sees. `tool-session-stub-typing.test.ts` is the gate that keeps
 * that cast out of the test tree; this file is the offender it caught.
 */
function sessionWith(alloc: ToolSession["allocateOutputArtifact"]): ToolSession {
	return makeToolSession({ allocateOutputArtifact: alloc });
}

describe("an artifact that is written successfully", () => {
	/** The ordinary case: the id comes back so the caller can print a footer, and nothing is reported. */
	it("returns the id and reports nothing", async () => {
		const target = path.join(dir, "out.txt");
		const id = await saveOutputArtifact(
			sessionWith(async () => ({ id: "abc123", path: target })),
			"bash-original",
			"the full output",
		);

		expect(id).toBe("abc123");
		expect(await Bun.file(target).text()).toBe("the full output");
		expect(lossReports()).toEqual([]);
	});
});

describe("a session with no artifact store", () => {
	/**
	 * The case that must stay silent. An MCP or extension tool context has no `allocateOutputArtifact`,
	 * so there was never an artifact to lose. This is the silence the old code was borrowing to excuse
	 * the failure cases below.
	 */
	it("returns undefined without reporting when the hook is absent", async () => {
		expect(await saveOutputArtifact(sessionWith(undefined), "bash-original", "x")).toBeUndefined();
		expect(lossReports()).toEqual([]);
	});

	/** Same when the hook exists but declines to allocate: declining is an answer, not a failure. */
	it("returns undefined without reporting when allocation yields no id or path", async () => {
		expect(
			await saveOutputArtifact(
				sessionWith(async () => ({})),
				"grep",
				"x",
			),
		).toBeUndefined();
		expect(
			await saveOutputArtifact(
				sessionWith(async () => ({ id: "only-id" })),
				"grep",
				"x",
			),
		).toBeUndefined();
		expect(
			await saveOutputArtifact(
				sessionWith(async () => ({ path: "/only/path" })),
				"grep",
				"x",
			),
		).toBeUndefined();
		expect(lossReports()).toEqual([]);
	});
});

describe("an allocation that throws", () => {
	/**
	 * The regression this exists to prevent. The window the caller already built is still printed, so
	 * without the report there is no trace anywhere that the full output existed.
	 */
	it("returns undefined and reports the loss with the tool type and the error", async () => {
		const result = await saveOutputArtifact(
			sessionWith(async () => {
				throw new Error("session store is closed");
			}),
			"bash-original",
			"the full output",
		);

		expect(result).toBeUndefined();
		expect(lossReports()).toHaveLength(1);
		expect(lossReports()[0]?.meta.toolType).toBe("bash-original");
		expect(String(lossReports()[0]?.meta.error)).toContain("session store is closed");
	});

	/** The message has to name the consequence, since "artifact failed" does not tell the reader what it cost. */
	it("says only the truncated window is recoverable", async () => {
		await saveOutputArtifact(
			sessionWith(async () => {
				throw new Error("boom");
			}),
			"grep",
			"x",
		);

		expect(lossReports()[0]?.message).toContain("only the truncated window is recoverable");
	});
});

describe("a write that fails after a successful allocation", () => {
	/**
	 * A missing parent directory is NOT one of these failures, which is worth pinning so nobody reaches
	 * for `mkdir` here: `Bun.write` creates the parent chain, so the artifact lands and its id comes back.
	 * This was written as a failure case first and it passed the write, so the behaviour is asserted
	 * rather than assumed.
	 */
	it("creates a missing parent directory instead of losing the artifact", async () => {
		const target = path.join(dir, "no-such-dir", "out.txt");
		const result = await saveOutputArtifact(
			sessionWith(async () => ({ id: "abc123", path: target })),
			"bash-original",
			"the full output",
		);

		expect(result).toBe("abc123");
		expect(await Bun.file(target).text()).toBe("the full output");
		expect(lossReports()).toEqual([]);
	});

	/**
	 * A path that is a DIRECTORY is the write failure that does reach the catch: `Bun.write` cannot create
	 * the parent chain out of it, so it fails with EISDIR. Checked separately from the throwing allocation
	 * above, because a fix that only wrapped the allocation call would lose this one.
	 */
	it("reports a path that is a directory", async () => {
		const result = await saveOutputArtifact(
			sessionWith(async () => ({ id: "abc123", path: dir })),
			"browser",
			"the full output",
		);

		expect(result).toBeUndefined();
		expect(lossReports()).toHaveLength(1);
		expect(lossReports()[0]?.meta.toolType).toBe("browser");
	});
});

describe("the reporter itself", () => {
	/**
	 * `reportLostOutputArtifact` is exported because a second path reaches the same outcome: the session's
	 * own `bash-original` save writes through `SessionManager` rather than the tool session, so it cannot
	 * use `saveOutputArtifact`. Both must say the same thing, which only holds if there is one reporter,
	 * so its message and fields are pinned here directly.
	 */
	it("reports the same message and fields for a caller outside saveOutputArtifact", () => {
		reportLostOutputArtifact("bash-original", new Error("disk full"));

		expect(lossReports()).toHaveLength(1);
		expect(lossReports()[0]?.message).toBe(
			"Full tool output could not be saved as an artifact; only the truncated window is recoverable",
		);
		expect(lossReports()[0]?.meta.toolType).toBe("bash-original");
		expect(String(lossReports()[0]?.meta.error)).toContain("disk full");
	});

	/** A thrown non-Error still has to produce a usable reason rather than "[object Object]". */
	it("reports a thrown string", () => {
		reportLostOutputArtifact("grep", "EROFS: read-only file system");

		expect(String(lossReports()[0]?.meta.error)).toContain("read-only file system");
	});
});
