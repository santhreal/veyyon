import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertHermeticEnvironment,
	assertIsolatedAppPath,
	DESTRUCTIVE_TESTS_ENV,
	guardDestructivePath,
} from "./helpers/destructive-guard";

/**
 * The guard protects real user data from the corruption campaign, so its own
 * failure modes have to be proven — a safety check that silently passes when
 * isolation is broken is worse than none, because the suite then reports green
 * while writing garbage over real credentials.
 *
 * Every test here asserts the guard FAILS CLOSED: unset HOME, a HOME outside the
 * temp directory, a HOME that never actually moved, and a target path outside
 * temp must each throw rather than allow the operation.
 */
describe("destructive-test guard refuses to run against real user data", () => {
	const originalHome = process.env.HOME;

	beforeEach(() => {
		process.env.HOME = path.join(os.tmpdir(), "veyyon-guard-fixture-home");
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
	});

	describe("assertHermeticEnvironment", () => {
		it("passes when the application's home resolves inside the OS temp directory", () => {
			expect(() =>
				assertHermeticEnvironment("fixture suite", path.join(os.tmpdir(), "veyyon-guard-fixture-home")),
			).not.toThrow();
		});

		it("refuses when the home points outside the temp directory (the real-data case)", () => {
			expect(() => assertHermeticEnvironment("fixture suite", "/home/some-real-user")).toThrow(
				/NOT\s+inside the OS temp directory/,
			);
		});

		it("refuses when no home resolves rather than defaulting to somewhere real", () => {
			expect(() => assertHermeticEnvironment("fixture suite", "")).toThrow(/no home directory resolved/);
		});

		it("names the calling suite in the failure so a tripped guard is traceable", () => {
			expect(() => assertHermeticEnvironment("auth-store-corruption", "/home/some-real-user")).toThrow(
				/auth-store-corruption/,
			);
		});

		/**
		 * The defect this locks out, in full: the guard used to read
		 * `process.env.HOME`. Bun resolves `os.homedir()` ONCE at process start, so a
		 * suite that assigned `process.env.HOME` in `beforeEach` changed the env var
		 * and nothing else — the guard saw a temp path, reported "isolated", and the
		 * app under test went on resolving the developer's REAL `~/.veyyon`. A
		 * credential test then wrote rows into the real shared credential store.
		 *
		 * So: a mutated `process.env.HOME` must NOT be able to satisfy the guard while
		 * the actual `os.homedir()` is still the real home.
		 */
		it("is not fooled by a process.env.HOME assigned after process start", () => {
			// A value that would trip the guard instantly if it were the one being read.
			process.env.HOME = "/home/some-real-user-that-is-not-temp";

			// The app's resolver is unaffected by an assignment made after startup...
			expect(os.homedir()).not.toBe(process.env.HOME);

			// ...so whatever the guard decides, it must never be deciding it ABOUT the
			// env var. Asserted this way rather than as a fixed throw/no-throw because
			// the correct outcome legitimately differs between a sandboxed run (home is
			// already temp, so it passes) and a bare run (home is real, so it refuses) —
			// and in both the env var must be irrelevant.
			let message = "";
			try {
				assertHermeticEnvironment("fixture suite");
			} catch (error) {
				message = String(error);
			}
			expect(message).not.toContain("some-real-user-that-is-not-temp");
		});
	});

	describe("assertIsolatedAppPath", () => {
		it("accepts a temp path the application resolved and returns it", () => {
			const resolved = path.join(os.tmpdir(), "veyyon-guard", "profiles", "work", "agent.db");
			expect(assertIsolatedAppPath(resolved, "fixture")).toBe(path.resolve(resolved));
		});

		/**
		 * The exact miss that caused the incident: the suite believed it was writing to
		 * a temp profile store, and the app had resolved the real shared store. Passing
		 * the APP-RESOLVED path through this guard turns that into a loud failure
		 * instead of a silent write to real credentials.
		 */
		it("refuses the real shared credential store even when the test expected a temp path", () => {
			const realStore = path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db");
			expect(() => assertIsolatedAppPath(realStore, "profile-credential-isolation")).toThrow(
				/application-resolved path/,
			);
		});
	});

	describe("guardDestructivePath", () => {
		it("allows a path inside the temp directory and returns it resolved", () => {
			const target = path.join(os.tmpdir(), "veyyon-guard", "agent.db");
			expect(guardDestructivePath(target, "fixture")).toBe(path.resolve(target));
		});

		it("refuses a path outside the temp directory", () => {
			expect(() => guardDestructivePath("/etc/passwd", "fixture")).toThrow(/outside the OS temp directory/);
		});

		it("refuses a relative path that escapes the temp directory", () => {
			const escaping = path.join(os.tmpdir(), "..", "etc", "passwd");
			expect(() => guardDestructivePath(escaping, "fixture")).toThrow(/outside the OS temp directory/);
		});
	});

	it("exposes the opt-in env var name so CI and the skip message cannot drift apart", () => {
		expect(DESTRUCTIVE_TESTS_ENV).toBe("VEYYON_DESTRUCTIVE_TESTS");
	});
});
