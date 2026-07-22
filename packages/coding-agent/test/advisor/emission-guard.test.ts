import { describe, expect, it } from "bun:test";
import { AdvisorEmissionGuard, normalizeAdvisorNote } from "../../src/advisor/emission-guard";

/**
 * The advisor emission guard makes the advisor's prose rules ("at most one advise
 * per update", "never repeat advice", "never send content-free noise") load-bearing
 * in code, because real advisor models violate them (issue #3520: 309 advise calls,
 * 92 unique, flooding the primary transcript with `Stop.` after the task finished).
 * Neither `normalizeAdvisorNote` nor `AdvisorEmissionGuard` had a test despite the
 * "Exported for tests" contract. The rules pinned here:
 *   - normalization lowercases, NFKC-folds, and collapses every run of non-alnum
 *     characters to a single space, then trims, so `"Stop."`, `"*Stop*"`, `"STOP!"`,
 *     and the fullwidth `"ＳＴＯＰ"` all key to `"stop"`; a punctuation-only note keys
 *     to the empty string; accented letters survive (they are alphanumeric);
 *   - accept() suppresses (returns false) empty/whitespace-only notes, the content-
 *     free filler phrases (stop / done / no issue / lgtm / continue ...), exact
 *     normalized duplicates within the session, and any second note in one update;
 *   - a suppressed note does NOT consume the per-update budget, so a real concern
 *     after noise in the same update still gets through;
 *   - beginUpdate() refreshes the one-per-update budget; reset() clears the whole
 *     dedupe history so a re-primed advisor can re-raise an old concern;
 *   - the dedupe history is FIFO-evicted at the configured capacity: the oldest key
 *     is forgotten (and can be re-accepted) once capacity is exceeded, while newer
 *     keys stay deduped.
 * A regression would let duplicate/noise advice reach the primary transcript, burn
 * the update budget on noise, or grow the dedupe set without bound.
 */

describe("normalizeAdvisorNote", () => {
	it("folds casing, punctuation, and surrounding whitespace to a single key", () => {
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("  STOP!  ")).toBe("stop");
	});

	it("collapses each run of separators to one space between words", () => {
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
		expect(normalizeAdvisorNote("nothing   to    add")).toBe("nothing to add");
	});

	it("NFKC-folds compatibility forms so fullwidth text keys the same as ASCII", () => {
		expect(normalizeAdvisorNote("ＳＴＯＰ")).toBe("stop");
	});

	it("keeps alphanumeric Unicode letters, dropping only the surrounding noise", () => {
		expect(normalizeAdvisorNote("Café ☕ done")).toBe("café done");
	});

	it("folds code identifiers so backticks, dots, and hyphens become word separators", () => {
		// A concrete advisory frequently names a file/symbol; the normalizer must key it
		// the same way regardless of the surrounding punctuation so dedupe still works.
		expect(normalizeAdvisorNote("Refactor `auth-flow.ts`: drop legacy branch.")).toBe(
			"refactor auth flow ts drop legacy branch",
		);
	});

	it("keys a punctuation-only note to the empty string", () => {
		expect(normalizeAdvisorNote("...!!!")).toBe("");
		expect(normalizeAdvisorNote("   ")).toBe("");
	});
});

describe("AdvisorEmissionGuard noise and dedupe suppression", () => {
	it("suppresses content-free filler phrases regardless of punctuation/casing", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Stop.")).toBe(false);
		expect(guard.accept("done")).toBe(false);
		expect(guard.accept("No issue; continue.")).toBe(false);
		expect(guard.accept("LGTM")).toBe(false);
		expect(guard.accept("continue")).toBe(false);
		// A longer multi-word filler phrase from the list still keys to a single membership hit.
		expect(guard.accept("No further watcher input needed.")).toBe(false);
	});

	it("suppresses empty and whitespace/punctuation-only notes", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("")).toBe(false);
		expect(guard.accept("   ...  ")).toBe(false);
	});

	it("lets a real concern through but drops its exact normalized duplicate", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Missing await on writeStream.end()")).toBe(true);
		guard.beginUpdate();
		// Same note, different punctuation -> same normalized key -> deduped.
		expect(guard.accept("Missing await on writeStream.end().")).toBe(false);
	});

	it("does not suppress a genuine blocker that merely starts with a noise word", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Stop: 'await' missing on end() will lose buffered writes")).toBe(true);
	});
});

describe("AdvisorEmissionGuard per-update rate limit", () => {
	it("accepts at most one note per update until beginUpdate refreshes the budget", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("First distinct concern")).toBe(true);
		expect(guard.accept("Second distinct concern")).toBe(false);
		guard.beginUpdate();
		expect(guard.accept("Second distinct concern")).toBe(true);
	});

	it("does not let a suppressed noise call consume the update budget", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("done")).toBe(false); // noise, budget untouched
		expect(guard.accept("A real concern in the same update")).toBe(true);
	});

	it("does not let a deduped call consume the update budget", () => {
		// A repeat of a prior-session note is dropped, but the model can still follow it with
		// a fresh concrete concern in the same cycle — dedupe must not burn the slot either.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Concrete: read race in #handleRetry.")).toBe(true);
		guard.beginUpdate();
		expect(guard.accept("Concrete: read race in #handleRetry.")).toBe(false); // deduped
		expect(guard.accept("New concern: cache eviction never fires.")).toBe(true);
	});
});

describe("AdvisorEmissionGuard reset", () => {
	it("clears the dedupe history so a re-primed advisor can re-raise an old concern", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Concern A")).toBe(true);
		guard.beginUpdate();
		expect(guard.accept("Concern A")).toBe(false); // still deduped
		guard.reset();
		expect(guard.accept("Concern A")).toBe(true); // history cleared
	});
});

describe("AdvisorEmissionGuard FIFO history eviction", () => {
	it("forgets the oldest key once capacity is exceeded while keeping newer keys deduped", () => {
		const guard = new AdvisorEmissionGuard({ capacity: 3 });
		expect(guard.accept("one")).toBe(true);
		guard.beginUpdate();
		expect(guard.accept("two")).toBe(true);
		guard.beginUpdate();
		expect(guard.accept("three")).toBe(true);
		guard.beginUpdate();
		// "four" pushes history to 4 > capacity 3, evicting the oldest key "one".
		expect(guard.accept("four")).toBe(true);
		guard.beginUpdate();
		// A newer key still inside the window stays deduped. Assert this BEFORE
		// re-accepting "one", since that would itself evict the next-oldest key.
		expect(guard.accept("three")).toBe(false);
		guard.beginUpdate();
		// "one" was evicted, so it is no longer deduped and re-accepts.
		expect(guard.accept("one")).toBe(true);
	});
});

describe("AdvisorEmissionGuard end-to-end spam suppression", () => {
	it("collapses the reporter's 309-call spam log to a single accepted note across many updates", () => {
		// Issue #3520 mimicked: 114× "Stop.", 52× "No issue; continue.", 41× "Done." (all filler),
		// plus 102 copies of one concrete-but-repeated nit, spread across 50 advisor update cycles.
		// Every filler is suppressed, every identical-text repeat is deduped, and the one-per-update
		// budget caps the rest, so exactly the concrete nit is accepted — and only once.
		const guard = new AdvisorEmissionGuard();
		const accepted: string[] = [];
		const stream: string[] = [
			...Array(114).fill("Stop."),
			...Array(52).fill("No issue; continue."),
			...Array(41).fill("Done."),
			...Array(102).fill("Concrete-but-repeated nit: x"),
		];
		const cycles = 50;
		const perCycle = Math.ceil(stream.length / cycles);
		for (let c = 0; c < cycles; c++) {
			guard.beginUpdate();
			for (let i = 0; i < perCycle; i++) {
				const note = stream[c * perCycle + i];
				if (note === undefined) break;
				if (guard.accept(note)) accepted.push(note);
			}
		}
		expect(accepted).toEqual(["Concrete-but-repeated nit: x"]);
	});
});
