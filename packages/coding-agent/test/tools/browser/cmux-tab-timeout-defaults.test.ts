import { describe, expect, it } from "bun:test";
import { CmuxTab } from "@veyyon/coding-agent/tools/browser/cmux/cmux-tab";

/**
 * Single-owner lock for the cmux-tab per-operation timeout default.
 *
 * THE BUG THIS LOCKS OUT. Every tab operation (click, screenshot, waitForSelector,
 * evaluate, ...) needs a fallback deadline when no active browser run context supplies
 * one. That value was inlined as the bare literal `30_000` in 12 separate places, twice
 * on the two lines that also cap with `Math.min`. Twelve byte-identical copies of one
 * magic number drift: an edit that changes the default for one operation and not the
 * others silently gives sibling operations different deadlines, which is invisible until
 * one of them hangs or aborts differently from the rest.
 *
 * WHY THIS FILE WAS REWRITTEN. The first attempt read `cmux-tab.ts` as text and asserted
 * that `const DEFAULT_OP_TIMEOUT_MS = 30_000;` appeared exactly once, that no other
 * `30_000` survived, and that `?? DEFAULT_OP_TIMEOUT_MS` appeared somewhere. It could not
 * fail on the bug it named. Change ONE operation's fallback from
 * `?? DEFAULT_OP_TIMEOUT_MS` to `?? 60_000` and all three assertions still pass: 60_000
 * is not the forbidden literal, the const is still defined once, and the required idiom
 * is still present because eleven other operations use it. It also failed on non-bugs:
 * renaming the constant, or reformatting the `Math.min` line, turned it red while nothing
 * about the product changed. It fails on renames and passes on drift, which is backwards.
 *
 * The assertions below are on the NUMBER each operation actually hands to the transport,
 * captured from a stub client. That is the value the operation's deadline is really set
 * from, and it is what a changed literal, a changed constant, a dropped `?? ` fallback, or
 * a lost `Math.min` cap all move.
 *
 * IF IT REGRESSES: two browser operations in one run abort at different times for no
 * reason an operator can see, and the one with the longer deadline holds the session past
 * the run's own budget.
 */

/** The default every operation must resolve to when no run context is set. */
const DEFAULT_MS = 30_000;

interface Captured {
	method: string;
	timeoutMs: number | undefined;
}

/**
 * A tab whose transport records the resolved deadline per request instead of talking to a
 * browser. `browser.eval` returns a `{ value }` envelope and the geometry/screenshot
 * methods need their own shapes, so the stub answers by method rather than returning one
 * generic object; an operation that got the wrong shape would throw and be reported as a
 * failure rather than silently recording nothing.
 */
function stubTab(): { tab: CmuxTab; calls: Captured[] } {
	const calls: Captured[] = [];
	const client = {
		request: async (method: string, _params: unknown, opts?: { timeoutMs?: number }) => {
			calls.push({ method, timeoutMs: opts?.timeoutMs });
			if (method === "browser.eval") {
				return { value: { innerWidth: 800, innerHeight: 600, dpr: 1, scrollX: 0, scrollY: 0 } };
			}
			if (method === "browser.url.get") return { url: "https://example.test/" };
			if (method === "browser.screenshot") return { png_base64: "AAAA" };
			return {};
		},
	};
	const tab = new CmuxTab({ client: client as never, surfaceId: "surface-1" });
	return { tab, calls };
}

/**
 * Every operation reachable without a run context, with the deadline each one must
 * resolve to. `observe` and `ariaSnapshot` are the two that cap with `Math.min`, and with
 * no run context the cap resolves to the same default; the capped pair is driven again
 * under a run context below, where the cap is the whole point.
 */
const OPERATIONS: Array<[label: string, run: (tab: CmuxTab) => Promise<unknown>]> = [
	["goto", tab => tab.goto("https://example.test/")],
	["observe", tab => tab.observe()],
	["ariaSnapshot", tab => tab.ariaSnapshot()],
	["waitFor", tab => tab.waitFor("#ok")],
	["waitForSelector", tab => tab.waitForSelector("#ok")],
	["waitForUrl", tab => tab.waitForUrl("example.test")],
	["id", tab => tab.id(1)],
];

describe("the cmux tab's resolved per-operation deadline", () => {
	for (const [label, run] of OPERATIONS) {
		it(`resolves ${label} to the ${DEFAULT_MS}ms default when no run context is set`, async () => {
			const { tab, calls } = stubTab();
			await run(tab);

			// Every request the operation made, so an operation that issues two calls with
			// two different deadlines (the drift this file exists for) is visible.
			const deadlines = calls.filter(call => call.timeoutMs !== undefined).map(call => call.timeoutMs);
			expect(`${label}: ${deadlines.join(",")}`).toBe(`${label}: ${deadlines.map(() => DEFAULT_MS).join(",")}`);
			// And it really did reach the transport, or the line above compares two empty
			// strings and asserts nothing.
			expect(deadlines.length).toBeGreaterThan(0);
		});
	}

	/**
	 * The discriminator for the whole file. If the capture were reading something other
	 * than the operation's deadline, these would still report the default instead of the
	 * run context's 7000, and every case above would be measuring nothing.
	 */
	it("prefers an active run context's timeout over the default", async () => {
		const { tab, calls } = stubTab();
		tab.setRunContext({ timeoutMs: 7_000, signal: new AbortController().signal } as never);
		await tab.waitFor("#ok");

		expect(calls.filter(call => call.timeoutMs !== undefined).map(call => call.timeoutMs)).toEqual([7_000]);
	});

	/**
	 * The two capped operations cap AGAINST the same owner, which is the second half of
	 * "one owner": a run context asking for longer than the default must not widen a
	 * snapshot's deadline. This is the assertion the old `toContain` on the literal
	 * `Math.min(...)` expression was reaching for, and it holds through a reformat.
	 */
	it("caps observe and ariaSnapshot at the default even when the run asks for longer", async () => {
		for (const [label, run] of [
			["observe", (tab: CmuxTab) => tab.observe()],
			["ariaSnapshot", (tab: CmuxTab) => tab.ariaSnapshot()],
		] as const) {
			const { tab, calls } = stubTab();
			tab.setRunContext({ timeoutMs: 600_000, signal: new AbortController().signal } as never);
			await run(tab);

			const deadlines = [...new Set(calls.filter(c => c.timeoutMs !== undefined).map(c => c.timeoutMs))];
			expect(`${label}: ${deadlines.join(",")}`).toBe(`${label}: ${DEFAULT_MS}`);
		}
	});

	/**
	 * And the cap only ever LOWERS. A run context under the default must be honoured, or
	 * `Math.min` would have been written as a bare constant and the run's own budget would
	 * be ignored.
	 */
	it("honours a run context shorter than the default on the capped operations", async () => {
		const { tab, calls } = stubTab();
		tab.setRunContext({ timeoutMs: 5_000, signal: new AbortController().signal } as never);
		await tab.observe();

		expect([...new Set(calls.filter(c => c.timeoutMs !== undefined).map(c => c.timeoutMs))]).toEqual([5_000]);
	});

	/**
	 * An explicit per-call timeout outranks both, so a caller that names a deadline gets
	 * it verbatim rather than the owner's default.
	 */
	it("uses an explicitly requested per-call timeout verbatim", async () => {
		const { tab, calls } = stubTab();
		await tab.waitForSelector("#ok", { timeout: 1_234 });

		expect(calls.filter(call => call.timeoutMs !== undefined).map(call => call.timeoutMs)).toEqual([1_234]);
	});
});
