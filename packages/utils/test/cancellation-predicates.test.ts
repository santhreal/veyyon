/**
 * "Did this error mean the work was cancelled?" has ONE answer, and it reads the error's name.
 *
 * WHY THIS SUITE EXISTS. Cancellation reaches a `catch` block wearing several coats: an unreasoned
 * `AbortController.abort()` produces a `DOMException` named `AbortError`, `fetch` propagates that
 * same exception, `AbortError` in `abortable.ts` is a plain `Error` with the same name, and the eval
 * kernels build their own `Error` subclasses and set `name` to match. `AbortSignal.timeout()` raises
 * a `TimeoutError`. The only thing they share is the NAME.
 *
 * Getting this wrong is not a cosmetic mistake, which is why it needs an owner rather than six
 * private copies (`eval/js/executor.ts` and `eval/executor-base.ts` each had one, and
 * `agent-loop.ts`, `agent-session.ts`, `agent/utils/yield.ts` and `stt-controller.ts` compared the
 * name inline). A cancellation misread as a failure gets REPORTED and the caller carries on: a site
 * scraper turned the user's Ctrl-C into "the scraper failed, falling back to a generic fetch" and
 * then made the request they had just cancelled. A failure misread as a cancellation is the other
 * direction, silently swallowed as "the user left".
 *
 * The name check is deliberate and `instanceof` is deliberately avoided: `DOMException` inherits from
 * `Error` under Bun and Node but NOT in a browser, and this module is bundled for the dashboard, so
 * an `instanceof Error` gate would stop recognising cancelled fetches in exactly one runtime. Both
 * runtimes' shapes are pinned below.
 */

import { describe, expect, it } from "bun:test";
import { isAbortError, isCancellation, isTimeoutError } from "@veyyon/utils";
// The signal-shaped AbortError by PATH, not through the barrel: three classes in this
// repository are named `AbortError` (this one, `utils/src/ptree.ts`, and
// `ai/src/error/abort.ts`) and the barrel re-exports ptree's, whose constructor takes
// `(reason, stderr)`. All three set `name` to "AbortError", which is why the predicate
// below recognises every one of them, and is also why importing "the" AbortError by name
// is a trap. See the ledger row THREE-CLASSES-NAMED-ABORTERROR.
import { AbortError } from "../src/abortable";
import { collectPackageSources } from "./support/package-sources";

/** An error carrying a name, in the shape a kernel or a library raises it. */
function named(name: string, message = "stopped"): Error {
	return Object.assign(new Error(message), { name });
}

describe("isAbortError", () => {
	it("recognises the DOMException fetch raises on abort", async () => {
		// The real thing, produced the way production produces it, because this is the shape
		// the `instanceof Error` version of this predicate would break on in a browser.
		const controller = new AbortController();
		controller.abort();
		let caught: unknown;
		try {
			await fetch("http://127.0.0.1:1/", { signal: controller.signal });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeDefined();
		expect((caught as Error).name).toBe("AbortError");
		expect(isAbortError(caught)).toBe(true);
	});

	it("recognises a hand-built DOMException", () => {
		expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
	});

	it("recognises the AbortError this package raises", () => {
		// `abortable.ts` throws a plain Error subclass with the name set, so a predicate
		// written against DOMException alone would miss every abort raised in-process.
		const controller = new AbortController();
		controller.abort();
		expect(isAbortError(new AbortError(controller.signal))).toBe(true);
	});

	it("recognises the other two cancellation classes in this repository, which keep the same wire name", async () => {
		// `ProcessAbortError` is raised for a killed child process and `@veyyon/ai`'s
		// `RequestAbortError` for a cancelled request. The three classes no longer share a NAME in
		// source — that collision made an `instanceof` check read as a question about cancellation
		// when it was really a question about which layer raised it — but they still all report
		// `name === "AbortError"`, which is the property that lets one predicate replace twenty-two
		// hand-written checks.
		const { ProcessAbortError } = await import("../src/ptree");
		const processAbort = new ProcessAbortError("cancelled", "");

		expect(processAbort.name).toBe("AbortError");
		expect(isAbortError(processAbort)).toBe(true);
	});

	it("keeps TimeoutError's own name even though it extends the process-abort class", async () => {
		// The wire name is restored on `ProcessAbortError` only. A subclass inherits the constructor
		// and must keep the name `Exception` derived for it, because `isTimeoutError` reads that name
		// and a timeout means something different to the user than a cancellation.
		const { TimeoutError } = await import("../src/ptree");
		const timeout = new TimeoutError(1500, "");

		expect(timeout.name).toBe("TimeoutError");
		expect(isTimeoutError(timeout)).toBe(true);
		expect(isAbortError(timeout)).toBe(false);
	});

	it("recognises a kernel error that only sets the name", () => {
		// `eval/rb/executor.ts` does exactly this: `this.name = timedOut ? ... : "AbortError"`.
		expect(isAbortError(named("AbortError", "Execution aborted"))).toBe(true);
	});

	it("does not recognise a timeout, which means something different to the user", () => {
		expect(isAbortError(named("TimeoutError"))).toBe(false);
	});

	it("does not recognise an ordinary error whose MESSAGE mentions aborting", () => {
		// The failure this guards: matching on text would make an HTTP 500 whose body says
		// "aborted" look like the user cancelling, and it would be swallowed.
		expect(isAbortError(new Error("upstream aborted the connection"))).toBe(false);
		expect(isAbortError(new Error("AbortError"))).toBe(false);
	});

	it("does not recognise values that carry no name", () => {
		expect(isAbortError(undefined)).toBe(false);
		expect(isAbortError(null)).toBe(false);
		expect(isAbortError("AbortError")).toBe(false);
		expect(isAbortError(42)).toBe(false);
	});

	it("recognises a thrown object that is not an Error but carries the name", () => {
		// Deliberate: a worker boundary or an RPC layer can rehydrate an error as a plain
		// object, and the cancellation is no less real for having lost its prototype.
		expect(isAbortError({ name: "AbortError", message: "aborted" })).toBe(true);
	});
});

describe("isTimeoutError", () => {
	it("recognises the DOMException a timeout signal raises", () => {
		expect(isTimeoutError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
	});

	it("recognises a kernel error that sets the name", () => {
		expect(isTimeoutError(named("TimeoutError", "eval timed out"))).toBe(true);
	});

	it("does not recognise an abort", () => {
		// Kept separate on purpose: work the user stopped and work that ran out of time are
		// different facts, and a caller may want to retry only the second with a longer limit.
		expect(isTimeoutError(named("AbortError"))).toBe(false);
	});

	it("does not recognise an ordinary error", () => {
		expect(isTimeoutError(new Error("connection timed out"))).toBe(false);
	});
});

describe("isCancellation", () => {
	it("is true for both an abort and a timeout", () => {
		expect(isCancellation(named("AbortError"))).toBe(true);
		expect(isCancellation(new DOMException("x", "TimeoutError"))).toBe(true);
	});

	it("is exactly the union of the two, with nothing else in it", () => {
		// The relation, pinned: a later edit cannot quietly widen this to swallow, say,
		// `NetworkError` as "not my fault" and hide a real failure.
		for (const name of ["AbortError", "TimeoutError", "TypeError", "NetworkError", "Error", "ToolAbortError"]) {
			const error = named(name);
			expect(isCancellation(error), name).toBe(isAbortError(error) || isTimeoutError(error));
		}
	});

	it("is false for an ordinary failure, which is what callers must keep reporting", () => {
		expect(isCancellation(new Error("HTTP 500"))).toBe(false);
		expect(isCancellation(new TypeError("undefined is not a function"))).toBe(false);
		expect(isCancellation(undefined)).toBe(false);
	});
});

describe("the repository", () => {
	it("compares an error name against AbortError or TimeoutError nowhere else", async () => {
		// The lock. Every one of the copies this replaced behaved correctly on the day it was
		// written; what they could not do is stay in agreement, and a source-level assertion
		// is the only thing that catches a re-spelling, since a re-spelled copy passes every
		// behavioural test in the repository.
		const patterns = [/name === "AbortError"/, /name === "TimeoutError"/];
		const owner = "utils/src/abortable.ts";

		const offenders = (await collectPackageSources())
			.filter(({ rel }) => rel !== owner)
			.filter(({ text }) => patterns.some(pattern => pattern.test(text)))
			.map(({ rel }) => rel);

		expect(
			offenders,
			"inline abort/timeout name comparison — import isAbortError / isTimeoutError / isCancellation from @veyyon/utils",
		).toEqual([]);
	});

	/**
	 * One class may be called `AbortError`, and it is the signal-shaped one in `abortable.ts`.
	 *
	 * Three used to answer to the name: this one, a killed child process in `ptree.ts`, and a cancelled
	 * provider request in `@veyyon/ai`. Two of them lived in the SAME package, and this package's barrel
	 * exported `ptree`'s, so `import { AbortError } from "@veyyon/utils"` handed you the process-abort
	 * class whichever one you meant. A wrong constructor call is the cheap version of that trap: a test
	 * written against the signal-shaped class failed with "Expected 2 arguments, but got 1". The
	 * expensive version is an `instanceof AbortError` check that compiles, passes, and asks about a
	 * different class than the author had in mind — which cannot be caught by reading the line.
	 *
	 * The other two are named for the layer they come from (`ProcessAbortError`, `RequestAbortError`)
	 * and keep `name === "AbortError"` on the wire, so `isAbortError` and every message shape are
	 * unchanged. This lock exists because nothing else would notice a fourth class taking the name.
	 */
	it("is the name of exactly one class in the workspace", async () => {
		const claimants = (await collectPackageSources())
			.filter(({ text }) => /^export (?:abstract )?class AbortError\b/m.test(text))
			.map(({ rel }) => rel);

		expect(claimants, "one class may be named AbortError — name the others for their layer").toEqual([
			"utils/src/abortable.ts",
		]);
	});

	/**
	 * And the barrel exports THAT one, which is the half of the fix a rename alone would not deliver:
	 * the collision was harmful because the name resolved to the wrong class at the import site.
	 */
	it("is what the package barrel exports under that name", async () => {
		const { AbortError: Exported } = await import("@veyyon/utils");
		const controller = new AbortController();
		controller.abort();

		// Constructible from a signal, which the process-abort class is not: it takes (reason, stderr).
		const error = new Exported(controller.signal);

		expect(error).toBeInstanceOf(AbortError);
		// Bun's bare `abort()` supplies a DOMException reason, whose message is carried through.
		expect(error.message).toBe("Aborted: The operation was aborted.");
	});
});
