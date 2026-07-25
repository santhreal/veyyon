/**
 * A project config directory that exists but cannot be read is announced, not walked past.
 *
 * WHY THIS SUITE EXISTS. `findAllNearestProjectConfigDirs` climbs from the working directory toward
 * the root, probing one candidate per config base (`.veyyon`, `.claude`) at every level, and takes
 * the NEAREST one it finds. Every probe was wrapped in `catch {}`.
 *
 * Absence has to be silent there: the walk performs a couple of probes per ancestor directory and
 * nearly all of them miss. But an EXISTING candidate that cannot be stat'd took the same path, and
 * the consequence is specific and invisible: the walk carries on to the ancestor above, a farther
 * config wins, and the user's own project settings quietly stop applying to their project. Nothing
 * fails, nothing is logged, and the settings that do apply come from somewhere they did not expect.
 *
 * So the split is the same one `isMissingPath` owns everywhere else in the repository: absent is
 * quiet, present-and-unreadable is loud. Both halves are pinned here, because a warning on every
 * ordinary probe miss would be as bad as no warning at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findAllNearestProjectConfigDirs } from "@veyyon/coding-agent/config";
import { logger, removeWithRetries } from "@veyyon/utils";

const tempDirs: string[] = [];
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

/** Only this call's warning, so unrelated logging cannot make the assertions pass or fail. */
function walkWarnings(): Array<{ message: string; fields: Record<string, unknown> }> {
	return warnings.filter(entry => entry.message.startsWith("Config directory could not be read"));
}

function makeTree(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
});

describe("findAllNearestProjectConfigDirs", () => {
	it("finds the nearest config directory and says nothing on the way", () => {
		// The healthy path, and the load-bearing silence: several ancestors are probed and
		// every miss must stay quiet or the warning below is worthless.
		const root = makeTree("walk-ok-");
		const nested = path.join(root, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, ".veyyon", "agent"), { recursive: true });

		const found = findAllNearestProjectConfigDirs("agent", nested);

		expect(found.map(entry => entry.path)).toEqual([path.join(root, ".veyyon", "agent")]);
		expect(walkWarnings()).toEqual([]);
	});

	it("says nothing when there is no config directory anywhere above the start", () => {
		const root = makeTree("walk-none-");

		expect(findAllNearestProjectConfigDirs("agent", root)).toEqual([]);
		expect(walkWarnings()).toEqual([]);
	});

	it("says nothing when the candidate exists but is a file rather than a directory", () => {
		// `statSync` succeeds and `isDirectory()` is false. That is a well-formed answer — the
		// candidate is not a config directory — so it takes no error path at all.
		const root = makeTree("walk-file-");
		fs.mkdirSync(path.join(root, ".veyyon"), { recursive: true });
		fs.writeFileSync(path.join(root, ".veyyon", "agent"), "not a directory");

		expect(findAllNearestProjectConfigDirs("agent", root)).toEqual([]);
		expect(walkWarnings()).toEqual([]);
	});

	it("reports a candidate whose parent path is unreadable, naming the path it skipped", () => {
		// A directory with no execute permission cannot be traversed, so `statSync` on a child
		// fails with EACCES: the config IS there and the walk cannot see it. Skipped on Windows,
		// where the mode bits do not produce this.
		if (process.platform === "win32") return;
		const root = makeTree("walk-eacces-");
		const base = path.join(root, ".veyyon");
		fs.mkdirSync(path.join(base, "agent"), { recursive: true });
		fs.chmodSync(base, 0o000);
		try {
			const found = findAllNearestProjectConfigDirs("agent", root);

			// The unreadable candidate did not win, which is the behaviour that used to be
			// silent — and now it is on the record.
			expect(found.map(entry => entry.path)).toEqual([]);
			const reported = walkWarnings();
			expect(reported.length).toBeGreaterThan(0);
			expect(reported[0]?.message).toBe("Config directory could not be read while walking up; skipped it");
			expect(reported[0]?.fields.path).toBe(path.join(base, "agent"));
			expect(String(reported[0]?.fields.error)).toContain("EACCES");
		} finally {
			// Restore before the temp-tree cleanup, which cannot delete what it cannot enter.
			fs.chmodSync(base, 0o755);
		}
	});

	it("keeps walking after an unreadable candidate, so a farther config still applies", () => {
		// Non-fatal by design: a broken candidate must not leave the session with no config at
		// all. The warning is what tells the user why the config that applied is not the
		// nearest one.
		if (process.platform === "win32") return;
		const root = makeTree("walk-fallback-");
		const nested = path.join(root, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, ".veyyon", "agent"), { recursive: true });
		const blocked = path.join(nested, ".veyyon");
		fs.mkdirSync(path.join(blocked, "agent"), { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const found = findAllNearestProjectConfigDirs("agent", nested);

			expect(found.map(entry => entry.path)).toEqual([path.join(root, ".veyyon", "agent")]);
			expect(walkWarnings().map(entry => entry.fields.path)).toContain(path.join(blocked, "agent"));
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});
});
