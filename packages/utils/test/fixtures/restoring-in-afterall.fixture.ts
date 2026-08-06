/**
 * Moves a tracked variable between its own tests and restores it in `afterAll`.
 *
 * Used by `scripts/test-sandbox/find-test-leaks.test.ts` to prove the tracer's verdict is per
 * FILE, not per test: `logger-file-transport-rebind` legitimately moves the config
 * root three times because following the move is the behaviour under test, and a
 * per-test rule reported it five times while it polluted nothing.
 */
import { afterAll, expect, it } from "bun:test";

const original = process.env.VEYYON_CONFIG_DIR;

afterAll(() => {
	if (original === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = original;
});

it("moves the config root", () => {
	process.env.VEYYON_CONFIG_DIR = "/tmp/moved-once";
	expect(process.env.VEYYON_CONFIG_DIR).toBe("/tmp/moved-once");
});

it("moves it again", () => {
	process.env.VEYYON_CONFIG_DIR = "/tmp/moved-twice";
	expect(process.env.VEYYON_CONFIG_DIR).toBe("/tmp/moved-twice");
});
