/**
 * The session's working directory is an absolute path at every read, on every branch.
 *
 * WHY THIS SUITE EXISTS. A successful re-root reported itself as:
 *
 *     Session cwd is now . (previously .)
 *
 * Both halves are false. The previous cwd was a real absolute directory and the new one was
 * `/media/.../software/keyhog`, and a model reading that line has been told nothing at all: it
 * cannot tell the call worked, cannot tell where it now is, and its next move is to retry or to
 * guess from whether a relative read happens to resolve.
 *
 * THE FIELD, NOT THE FORMATTER. `SessionManager`'s constructor resolves its seed and every later
 * assignment resolved too, so the value looked safe, but nothing kept it that way on the way OUT:
 * `getCwd()` returned the raw field, `setCwd`'s no-op branch returned the raw field, and
 * `restoreState` wrote a snapshot's cwd through unresolved. Both `ToolSession.cwd` getters in
 * `sdk.ts` are live reads of `getCwd()`, so a relative value did not reach one surface, it reached
 * every tool in the process at once.
 *
 * AND THE DISPLAY IS THE SMALL HALF. `resolveToCwd(target, session.cwd)` rebases a relative path on
 * its `cwd` argument, and `path.resolve` falls back to `process.cwd()` when that argument is itself
 * relative. So a relative session cwd means the tools resolve against the OS process directory
 * while the session believes it is somewhere else, and the two agree only for as long as those two
 * directories happen to coincide. The unreadable message was the visible symptom of a session and
 * its tools disagreeing about where they are.
 *
 * Every test below asserts an ABSOLUTE path against a directory built for it, never merely that two
 * strings match: `expect(a).toBe(b)` would have passed throughout the bug, since `.` equals `.`.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

/** A real directory tree to re-root around, removed when the test ends. */
function tempProject(): { root: string; child: string; cleanup: () => void } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cwd-")));
	const child = path.join(root, "keyhog");
	fs.mkdirSync(child);
	return { root, child, cleanup: () => fs.rmSync(root, { force: true, recursive: true }) };
}

/**
 * A fully initialized manager, through the same factory the product uses.
 *
 * `SessionManager.create` is what seeds the header, and a bare `new SessionManager(...)` leaves it
 * undefined: a test built that way would crash inside `setCwd` on a line that has nothing to do
 * with the working directory, which reads as a defect in the code under test.
 */
function managerAt(cwd: string): SessionManager {
	return SessionManager.create(cwd, path.join(path.resolve(cwd), ".veyyon-sessions"), new MemorySessionStorage());
}

describe("the session cwd a caller can read", () => {
	/**
	 * The constructor's own guarantee, which was already true and is asserted so the rest of the
	 * suite is standing on something. A relative seed is the ordinary case: `veyyon` launched with no
	 * `--cwd` passes whatever the caller had.
	 */
	it("is absolute even when the session was seeded with a relative path", () => {
		const project = tempProject();
		try {
			const previousProcessCwd = process.cwd();
			process.chdir(project.root);
			try {
				const manager = managerAt(".");

				expect(manager.getCwd()).toBe(project.root);
				expect(path.isAbsolute(manager.getCwd())).toBe(true);
			} finally {
				process.chdir(previousProcessCwd);
			}
		} finally {
			project.cleanup();
		}
	});

	/**
	 * THE REGRESSION. A re-root to the directory the session is already in takes `setCwd`'s no-op
	 * branch, which returned the raw field. With the field holding `.` that branch answered `.` to a
	 * caller that had asked for an absolute path and been told, by the method's own doc, that it
	 * "returns the resolved absolute path".
	 *
	 * Asserted against `project.root` rather than against the argument, so a future version that
	 * echoes its input back unexamined does not pass this by accident.
	 */
	it("answers an absolute path when a re-root lands on the directory it is already in", async () => {
		const project = tempProject();
		try {
			const previousProcessCwd = process.cwd();
			process.chdir(project.root);
			try {
				const manager = managerAt(".");

				expect(await manager.setCwd(project.root, { validate: true })).toBe(project.root);
				expect(manager.getCwd()).toBe(project.root);
			} finally {
				process.chdir(previousProcessCwd);
			}
		} finally {
			project.cleanup();
		}
	});

	/**
	 * The moving branch, so the fix is not "the no-op branch only". A real move already resolved, and
	 * this pins that the two branches now agree rather than one having been corrected into
	 * disagreement with the other.
	 */
	it("answers an absolute path when the re-root actually moves", async () => {
		const project = tempProject();
		try {
			const previousProcessCwd = process.cwd();
			process.chdir(project.root);
			try {
				const manager = managerAt(".");

				expect(await manager.setCwd("keyhog", { validate: true })).toBe(project.child);
				expect(manager.getCwd()).toBe(project.child);
			} finally {
				process.chdir(previousProcessCwd);
			}
		} finally {
			project.cleanup();
		}
	});

	/**
	 * A relative target resolves against the SESSION, never against the OS process directory. This is
	 * the half that is a correctness bug rather than a readability one: with a relative session cwd
	 * the two bases coincide, and the first time they diverge the tools write somewhere the session
	 * never moved to.
	 */
	it("resolves a relative target against the session, not the process", async () => {
		const project = tempProject();
		const elsewhere = tempProject();
		try {
			const previousProcessCwd = process.cwd();
			process.chdir(elsewhere.root);
			try {
				const manager = managerAt(project.root);

				expect(await manager.setCwd("keyhog", { validate: true })).toBe(project.child);
				expect(manager.getCwd()).toBe(project.child);
			} finally {
				process.chdir(previousProcessCwd);
			}
		} finally {
			project.cleanup();
			elsewhere.cleanup();
		}
	});

	/**
	 * `restoreState` is the one assignment that takes a cwd from outside the class. A snapshot
	 * normally round-trips a value that was already absolute, but it is plain data any caller can
	 * build, and an unresolved write here would put the field back into the state the rest of this
	 * suite is about.
	 */
	it("resolves a working directory restored from a snapshot", () => {
		const project = tempProject();
		try {
			const previousProcessCwd = process.cwd();
			process.chdir(project.root);
			try {
				const manager = managerAt(project.root);
				const snapshot = manager.captureState();

				manager.restoreState({ ...snapshot, cwd: "." });

				expect(manager.getCwd()).toBe(project.root);
			} finally {
				process.chdir(previousProcessCwd);
			}
		} finally {
			project.cleanup();
		}
	});

	/**
	 * NON-VACUITY, and the one that keeps the others honest. Every assertion above compares against a
	 * temp directory, so none of them can pass on a session that has quietly re-rooted itself to the
	 * process directory: this states outright that the two are different places.
	 */
	it("does not silently answer the process directory", () => {
		const project = tempProject();
		try {
			const manager = managerAt(project.root);

			expect(manager.getCwd()).toBe(project.root);
			expect(manager.getCwd()).not.toBe(process.cwd());
		} finally {
			project.cleanup();
		}
	});
});
