/**
 * WHY: `packages/coding-agent/src/mnemopi/backend.ts` declared its own `removeWithRetries` that shadowed
 * the exported one in `packages/utils/src/temp.ts`, with half its retry window — 40 × 25 ms against the
 * owner's 40 × 50 ms. The owner's comment states why 50 ms: a Windows SQLite lock can outlive `close()`
 * by about 1.5 s, and 1 s "was too short". The copy applied 1 s to SQLite DB files and their WAL/SHM
 * sidecars, which is exactly the case the owner sized its window for, so a memory clear on Windows could
 * report success while the files were still locked and left behind.
 *
 * THE CLASS: a retry window with two definitions. The number that matters is invisible at the call site,
 * so a copy that halves it reads identically and fails only on the platform nobody develops on. The sweep
 * below derives the offender set from the tree at run time, so a new copy anywhere in production source
 * turns this red rather than waiting for a Windows report.
 *
 * WHAT IT DOES NOT CATCH: a caller that inlines the loop without naming it `removeWithRetries`, and the
 * Windows timing itself, which no test on this platform can observe — the owner's retry arm is gated on
 * `process.platform === "win32"`, and the tests here assert the POSIX arm terminates rather than
 * simulating a locked file.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, removeWithRetries } from "@veyyon/utils";
import { collectPackageSources } from "./support/package-sources";

const OWNER = "utils/src/temp.ts";

/** A declaration of either retry helper, in any of the forms production source uses. */
const RETRY_HELPER_DEF =
	/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+remove(?:Sync)?WithRetries\b|(?:^|\n)\s*(?:export\s+)?const\s+remove(?:Sync)?WithRetries\s*[:=]/;

describe("a deletion retry window has one owner", () => {
	it("no production source outside the owner declares its own removeWithRetries", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === OWNER) continue;
			if (RETRY_HELPER_DEF.test(text)) offenders.push(rel);
		}

		expect(offenders.sort(), "a second retry window — import removeWithRetries from @veyyon/utils instead").toEqual(
			[],
		);
	});

	/** NON-VACUITY: the sweep really reads source, and the owner's own declaration is in it. */
	it("finds the owner's declaration, so an empty offender list means something", async () => {
		const owner = (await collectPackageSources({ dirs: ["src"] })).find(source => source.rel === OWNER);

		expect(owner, "the owner file must be in the swept set").toBeDefined();
		expect(RETRY_HELPER_DEF.test(owner?.text ?? "")).toBe(true);
	});
});

describe("the owner's removal terminates on every input it is handed", () => {
	it("treats a missing path as success, which every cleanup caller relies on", async () => {
		const missing = path.join(os.tmpdir(), `remove-owner-${process.pid}-absent`);

		await removeWithRetries(missing);
		removeSyncWithRetries(missing);
	});

	it("removes a directory and its contents", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remove-owner-"));
		await fs.writeFile(path.join(dir, "a.db"), "x", "utf8");
		await fs.mkdir(path.join(dir, "nested"));
		await fs.writeFile(path.join(dir, "nested", "b.db-wal"), "x", "utf8");

		await removeWithRetries(dir);

		await expect(fs.stat(dir)).rejects.toThrow();
	});

	/**
	 * The bound. A retry loop that cannot end is the failure this window could hide, and a test that only
	 * observes the wrong value cannot see a hang, so the deadline is the assertion.
	 */
	it("returns within its retry window rather than looping", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remove-owner-bound-"));
		const started = Date.now();

		await removeWithRetries(dir);
		await removeWithRetries(dir);

		expect(Date.now() - started, "two removals must not approach the 2s retry window").toBeLessThan(2000);
	});
});
