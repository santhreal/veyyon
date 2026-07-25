/**
 * The restore-on-throw contract of `withIsolatedConfigRoot`.
 *
 * THE BUG THIS SUITE LOCKS OUT. `enterIsolatedConfigRoot` and its `restore()` are
 * two separate calls, and anything that throws between them skips the second. A
 * suite whose setup deliberately threw when isolation failed to take left its root,
 * `VEYYON_CONFIG_DIR`, `VEYYON_CODING_AGENT_DIR` and its active profile in place for
 * the entire rest of the process. Every later suite in that run resolved into the
 * leaked temp directory, an unrelated `/agents` rendering test failed on wording it
 * had never set, and the run left 42 abandoned roots in `/tmp`.
 *
 * The damage is asymmetric, which is why the guarantee is worth its own suite: a
 * leak never fails the suite that caused it, only some later one, so nothing about
 * the failure points at the file responsible. Every test below therefore asserts on
 * the environment AFTER the scope ends, which is the only place the leak is visible.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";

import { CONFIG_ROOT_ENV_KEYS, withIsolatedConfigRoot, XDG_BASE_DIRS } from "./helpers/isolated-config-root";

/** Snapshot of every variable the helper promises to manage, for before/after comparison. */
function managedEnv(): Record<string, string | undefined> {
	const snapshot: Record<string, string | undefined> = {};
	for (const key of [...CONFIG_ROOT_ENV_KEYS, ...XDG_BASE_DIRS]) snapshot[key] = process.env[key];
	return snapshot;
}

describe("withIsolatedConfigRoot — the restore cannot be skipped", () => {
	/**
	 * THE FAILING CASE FROM THE REAL LEAK. The body throws exactly the way an
	 * isolation proof does, and every managed variable must still come back. Before
	 * this guarantee existed the variables kept pointing at the temp root and the
	 * next suite in the process silently inherited them.
	 */
	test("restores every managed variable when the body throws", () => {
		const before = managedEnv();
		expect(() =>
			withIsolatedConfigRoot("scope-throws", () => {
				throw new Error("isolation proof failed");
			}),
		).toThrow("isolation proof failed");
		expect(managedEnv()).toEqual(before);
	});

	/** The thrown error reaches the caller unchanged, so a real setup failure is still diagnosable. */
	test("rethrows the original error rather than swallowing it", () => {
		const sentinel = new Error("the original cause");
		let caught: unknown;
		try {
			withIsolatedConfigRoot("scope-rethrow", () => {
				throw sentinel;
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(sentinel);
	});

	/**
	 * The temp directory is removed on the throwing path too. The leak that motivated
	 * this left 42 roots in `/tmp` across a single run, one per abandoned scope, which
	 * is the same accumulation the helper's stale sweep exists to clean up after.
	 */
	test("removes the temp root when the body throws", () => {
		let root = "";
		expect(() =>
			withIsolatedConfigRoot("scope-removes", isolated => {
				root = isolated.root;
				expect(fs.existsSync(root)).toBe(true);
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(root).not.toBe("");
		expect(fs.existsSync(root)).toBe(false);
	});

	/** The ordinary path still restores and still returns the body's value. */
	test("restores after a body that returns normally, and passes the value through", () => {
		const before = managedEnv();
		const value = withIsolatedConfigRoot("scope-returns", isolated => {
			expect(fs.existsSync(isolated.root)).toBe(true);
			return 42;
		});
		expect(value).toBe(42);
		expect(managedEnv()).toEqual(before);
	});

	/**
	 * INSIDE the scope the config root must actually be redirected, or the suite
	 * proves only that nothing changed. This is the positive half of the contract:
	 * isolation took effect, and then it was undone.
	 */
	test("redirects the config root inside the scope and puts it back after", () => {
		const before = process.env.VEYYON_CONFIG_DIR;
		let inside: string | undefined;
		withIsolatedConfigRoot("scope-redirects", () => {
			inside = process.env.VEYYON_CONFIG_DIR;
		});
		expect(inside).toBeDefined();
		expect(inside).not.toBe(before);
		expect(process.env.VEYYON_CONFIG_DIR).toBe(before);
	});

	/**
	 * AN ASYNC BODY MUST NOT BE RESTORED OUT FROM UNDER ITSELF. Restoring when the
	 * promise is returned rather than when it settles would delete the temp root while
	 * the body was still using it, turning the leak into the opposite and equally
	 * confusing failure: a suite whose files vanish mid-test.
	 */
	test("waits for an async body before restoring", async () => {
		const before = managedEnv();
		let rootDuring = "";
		const result = await withIsolatedConfigRoot("scope-async", async isolated => {
			rootDuring = isolated.root;
			await Promise.resolve();
			// Still inside the scope: the root exists and the redirect is live.
			expect(fs.existsSync(isolated.root)).toBe(true);
			expect(process.env.VEYYON_CONFIG_DIR).not.toBe(before.VEYYON_CONFIG_DIR);
			return "done";
		});
		expect(result).toBe("done");
		expect(fs.existsSync(rootDuring)).toBe(false);
		expect(managedEnv()).toEqual(before);
	});

	/** A rejected async body restores on the rejection path and propagates the rejection. */
	test("restores when an async body rejects", async () => {
		const before = managedEnv();
		let rootDuring = "";
		await expect(
			withIsolatedConfigRoot("scope-async-rejects", async isolated => {
				rootDuring = isolated.root;
				await Promise.resolve();
				throw new Error("async boom");
			}),
		).rejects.toThrow("async boom");
		expect(fs.existsSync(rootDuring)).toBe(false);
		expect(managedEnv()).toEqual(before);
	});

	/**
	 * Restore runs exactly once even when the body both throws and the scope settles,
	 * so the second call cannot delete a directory a LATER scope has since been given.
	 * Temp names carry a counter, but relying on that to paper over a double restore
	 * would make the guarantee depend on never reusing a name.
	 */
	test("restores once, so a later scope's root is never removed by an earlier one", () => {
		let first = "";
		expect(() =>
			withIsolatedConfigRoot("scope-once-a", isolated => {
				first = isolated.root;
				throw new Error("first fails");
			}),
		).toThrow("first fails");
		const second = withIsolatedConfigRoot("scope-once-b", isolated => {
			// The failed scope must not have taken this one's directory with it.
			expect(fs.existsSync(isolated.root)).toBe(true);
			return isolated.root;
		});
		expect(second).not.toBe(first);
	});
});
