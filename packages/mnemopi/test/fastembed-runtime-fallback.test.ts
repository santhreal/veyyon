import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecoverableFastembedLoadError } from "../src/core/fastembed-runtime";

/**
 * The fastembed runtime-install fallback: when it is taken, and how loudly.
 *
 * `loadFastembedOnce` imports the optional `fastembed` peer, and on failure
 * falls back to downloading and installing a private copy into a runtime cache.
 * Two separate things about that need locking down.
 *
 * First, WHEN. Only a missing or unloadable module may trigger the fallback. If
 * an installed fastembed throws a real error (a corrupt model file, an
 * assertion inside the addon), falling back replaces a clear message with a
 * multi-minute install that fails exactly the same way at the end of it, so
 * that error is rethrown.
 *
 * Second, HOW LOUDLY. The fallback used to be a `logger.debug`, and this is the
 * case Law 10's speed bound is written for. The fallback preserves the
 * behaviour perfectly, so nothing is wrong with the result, but it downloads
 * and installs a runtime before the first embedding is produced. A user whose
 * first index takes minutes instead of seconds had nothing anywhere to explain
 * it. A degrade that expensive cannot be invisible.
 */
describe("the fastembed runtime-install fallback", () => {
	/**
	 * Bun's own resolver failure. This is the shape the fallback exists for: the
	 * optional peer was never installed, which is the default for anyone who did
	 * not opt into the ~270MB of native assets.
	 */
	it("falls back on Bun's ResolveMessage", () => {
		expect(
			isRecoverableFastembedLoadError(Object.assign(new Error("Cannot find package"), { name: "ResolveMessage" })),
		).toBe(true);
	});

	/** Node's equivalents, which is what a non-Bun consumer of the library sees. */
	it("falls back on the Node module-not-found codes", () => {
		for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]) {
			expect(isRecoverableFastembedLoadError(Object.assign(new Error("nope"), { code })), code).toBe(true);
		}
	});

	/**
	 * A native addon that will not dlopen is the compiled-binary case, and it is
	 * genuinely recoverable: the runtime install fetches a build that matches the
	 * host. Without this the compiled binary would hard-fail rather than fall
	 * back, which is the whole reason the fallback was written.
	 */
	it("falls back when the native addon cannot be loaded", () => {
		expect(
			isRecoverableFastembedLoadError(Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" })),
		).toBe(true);
	});

	/** The message-text path, for runtimes that carry no code on the error. */
	it("falls back on a cannot-find-module message with no code at all", () => {
		expect(isRecoverableFastembedLoadError(new Error("Cannot find module 'fastembed'"))).toBe(true);
		expect(isRecoverableFastembedLoadError(new Error("cannot find package fastembed"))).toBe(true);
	});

	/**
	 * The half that matters most, and the one an over-eager predicate would break:
	 * a fastembed that IS installed and threw a real error must surface that
	 * error. Falling back here costs the user a long install and then fails
	 * identically, with the original cause now buried.
	 */
	it("rethrows a real error from an installed fastembed", () => {
		expect(isRecoverableFastembedLoadError(new Error("model file is corrupt"))).toBe(false);
		expect(isRecoverableFastembedLoadError(new TypeError("embed is not a function"))).toBe(false);
		expect(isRecoverableFastembedLoadError(Object.assign(new Error("out of memory"), { code: "ENOMEM" }))).toBe(
			false,
		);
	});

	/**
	 * Non-objects reach this predicate whenever something throws a string or a
	 * rejected promise resolves to `undefined`. Treating those as recoverable
	 * would kick off a runtime install for an error nobody can read.
	 */
	it("does not fall back for a thrown value that is not an error object", () => {
		for (const thrown of [undefined, null, "Cannot find module", 42]) {
			expect(isRecoverableFastembedLoadError(thrown), String(thrown)).toBe(false);
		}
	});

	/**
	 * The loudness lock.
	 *
	 * The report cannot be reached from a test without actually failing the
	 * import and then performing the network install it falls back to, so the
	 * level is asserted at the source instead. This is narrow on purpose: it
	 * fails if the fallback branch goes back to `logger.debug`, which is the
	 * exact regression it exists to prevent, and it names why in the failure.
	 */
	it("reports the fallback at warn level, never debug", () => {
		const source = fs.readFileSync(path.join(import.meta.dir, "../src/core/fastembed-runtime.ts"), "utf8");
		const fallbackBranch = source.slice(
			source.indexOf("if (!isRecoverableFastembedLoadError(error)) throw error;"),
			source.indexOf("return loadFromRuntimeInstall();"),
		);

		expect(fallbackBranch.length, "the fallback branch moved; update this lock").toBeGreaterThan(0);
		expect(
			fallbackBranch.includes("logger.warn("),
			"the runtime-install fallback must report at warn: it downloads and installs a runtime, so a user whose first index takes minutes needs a line explaining why",
		).toBe(true);
		expect(fallbackBranch.includes("logger.debug(")).toBe(false);
	});
});
