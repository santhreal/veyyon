/**
 * The special-handler dispatcher stops when the work was cancelled, and a
 * deadline expiring counts as cancelled.
 *
 * WHY THIS SUITE EXISTS. `handleSpecialUrls` walks every site scraper looking for
 * one that claims the URL. A scraper that throws must not take the whole fetch
 * down, so the catch records a note and continues to the generic fetch. That is
 * right for a scraper failure and wrong for a cancellation, and the guard that
 * separated the two asked only:
 *
 *     if (signal?.aborted || error instanceof ToolAbortError)
 *
 * which sees the user pressing Escape and does NOT see a deadline expiring. That
 * matters because the deadline is the half that actually fires here. Each handler
 * is called as `handler(url, timeout, signal, storage)` and builds its own
 * `scopedTimeoutSignal(timeout, signal)` internally, so when a slow site exhausts
 * the budget the rejection is a `DOMException` named `TimeoutError` while the
 * USER's signal is still unaborted. Both halves of the old condition were false,
 * so the timeout fell through to `notes.push(...); continue`, and `renderUrl` then
 * ran the generic fetch against the same site with the budget already spent: the
 * request that just timed out, made again, and the operator told it was a scraper
 * failure.
 *
 * `scraperDegrade` in `web/scrapers/types.ts` exists to prevent precisely this and
 * its own doc says so. It was fixed there, at the point where a handler RETURNS a
 * degrade. The dispatcher's catch sits one layer above and handles the case where
 * a handler THROWS instead, and it never got the same guard, so the protection was
 * one branch wide. The fix routes both through `isCancellation`, the repo-wide
 * owner that covers abort and timeout together.
 *
 * The suite also pins that the thrown value survives. The old code replaced every
 * cancellation with a bare `new ToolAbortError()`, which carries neither a reason
 * nor a `cause`, so by the time it reached the agent loop a timeout and an abort
 * were the same object. They are not the same event: one is work the user stopped,
 * the other is work worth retrying with a longer limit.
 */
import { describe, expect, it } from "bun:test";
import { handleSpecialUrls } from "@veyyon/coding-agent/tools/fetch";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import type { RenderResult } from "@veyyon/coding-agent/web/scrapers/types";

/** The exact rejection `scopedTimeoutSignal` produces when its budget runs out. */
function timeoutRejection(): DOMException {
	return new DOMException("The operation timed out.", "TimeoutError");
}

/** A handler that always throws `thrown`, and records that it was called. */
function throwingHandler(name: string, thrown: unknown, calls: string[]) {
	const handler = async (): Promise<RenderResult | null> => {
		calls.push(name);
		throw thrown;
	};
	Object.defineProperty(handler, "name", { value: name });
	return handler as never;
}

/** A handler that claims the URL and returns a result, recording the call. */
function succeedingHandler(name: string, calls: string[]) {
	const handler = async (): Promise<RenderResult> => {
		calls.push(name);
		return {
			url: "https://example.com",
			finalUrl: "https://example.com",
			contentType: "text/markdown",
			method: name,
			content: "scraped",
			fetchedAt: "2026-07-25T00:00:00.000Z",
			truncated: false,
			notes: [],
		};
	};
	Object.defineProperty(handler, "name", { value: name });
	return handler as never;
}

describe("handleSpecialUrls, when a handler throws", () => {
	it("propagates a scraper deadline instead of degrading to a generic fetch", async () => {
		// THE REGRESSION. `signal` is undefined here on purpose: this is the shape
		// the bug took in production. Nothing the user did was cancelled, the
		// SCRAPER's own budget ran out, and both halves of the old guard were false.
		const calls: string[] = [];
		const notes: string[] = [];

		await expect(
			handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
				throwingHandler("slowsite", timeoutRejection(), calls),
				succeedingHandler("nextsite", calls),
			]),
		).rejects.toThrow("The operation timed out.");

		// The two things the degrade path would have done, and must not have.
		expect(notes).toEqual([]);
		expect(calls).toEqual(["slowsite"]);
	});

	it("rethrows the deadline as the same object, keeping the TimeoutError name", async () => {
		// A minted `ToolAbortError` would satisfy "it threw" while erasing which
		// event it was. The agent loop's correct response differs: a timeout is worth
		// retrying with a longer limit, an abort is not worth retrying at all.
		const thrown = timeoutRejection();
		const notes: string[] = [];

		const error = await handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
			throwingHandler("slowsite", thrown, []),
		]).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBe(thrown);
		expect((error as DOMException).name).toBe("TimeoutError");
	});

	it("propagates a user abort as the same object too", async () => {
		const thrown = new ToolAbortError("Fetch cancelled while scraping example.com");
		const notes: string[] = [];

		const error = await handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
			throwingHandler("site", thrown, []),
		]).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBe(thrown);
		expect((error as Error).message).toBe("Fetch cancelled while scraping example.com");
	});

	it("propagates a platform AbortError, which is what fetch actually rejects with", async () => {
		// The scrapers call `fetch` with the combined signal. When the caller aborts,
		// the rejection is a `DOMException` named "AbortError", not the coding
		// agent's own class, so an `instanceof ToolAbortError` test misses it. Only
		// the surrounding `signal?.aborted` check used to catch this case, and only
		// when the caller passed a signal at all.
		const thrown = new DOMException("This operation was aborted", "AbortError");
		const notes: string[] = [];

		const error = await handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
			throwingHandler("site", thrown, []),
		]).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBe(thrown);
	});

	it("still degrades and continues for an ordinary scraper failure", async () => {
		// THE NEGATIVE TWIN, and the behaviour the catch exists for. Narrowing the
		// guard must not turn every scraper bug into a failed fetch: a handler that
		// breaks on one page has to hand the URL to the next handler.
		const calls: string[] = [];
		const notes: string[] = [];

		const result = await handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
			throwingHandler("brokensite", new Error("Unexpected token < in JSON"), calls),
			succeedingHandler("nextsite", calls),
		]);

		expect(calls).toEqual(["brokensite", "nextsite"]);
		expect(result?.method).toBe("nextsite");
		expect(notes).toEqual(["brokensite scraper threw (Unexpected token < in JSON); fell back to a generic fetch"]);
	});

	it("degrades for an HTTP error, which reads as a timeout but is not one", async () => {
		// The boundary case. A 504 says the ORIGIN timed out; the scrape itself
		// completed and reported it. That is a site fact, not a cancellation of our
		// work, so it must still degrade. Matching on the message rather than the
		// error name would have gotten this wrong.
		const notes: string[] = [];

		const result = await handleSpecialUrls("https://example.com", 5, undefined, null, notes, [
			throwingHandler("site", new Error("HTTP 504 Gateway Timeout"), []),
		]);

		expect(result).toBeNull();
		expect(notes).toEqual(["site scraper threw (HTTP 504 Gateway Timeout); fell back to a generic fetch"]);
	});
});

describe("handleSpecialUrls, when the caller's signal is already aborted", () => {
	it("throws before calling any handler, carrying the signal's reason", async () => {
		const controller = new AbortController();
		controller.abort(new Error("user pressed Escape"));
		const calls: string[] = [];

		const error = await handleSpecialUrls(
			"https://example.com",
			5,
			controller.signal,
			null,
			[],
			[succeedingHandler("site", calls)],
		).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect((error as Error).name).toBe("ToolAbortError");
		expect((error as Error).message).toContain("user pressed Escape");
		expect(calls).toEqual([]);
	});

	it("reports the cancellation even when a handler swallowed it and threw something else", async () => {
		// A scraper that catches its own abort and rethrows a parse error would
		// otherwise be reported as a scraper failure while the user is already gone.
		// The `throwIfAborted` after the `isCancellation` check covers that gap, and
		// keeps the signal's reason as the `cause` rather than inventing a message.
		const controller = new AbortController();
		const reason = new Error("session ended");
		const notes: string[] = [];

		const handler = async (): Promise<RenderResult | null> => {
			controller.abort(reason);
			throw new Error("Unexpected end of JSON input");
		};
		Object.defineProperty(handler, "name", { value: "site" });

		const error = await handleSpecialUrls("https://example.com", 5, controller.signal, null, notes, [
			handler as never,
		]).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect((error as Error).name).toBe("ToolAbortError");
		expect((error as Error).cause).toBe(reason);
		expect(notes).toEqual([]);
	});

	it("throws between handlers when the signal aborts mid-walk", async () => {
		// The abort lands while handler one is deciding it does not claim the URL.
		// Handler two must never run.
		const controller = new AbortController();
		const calls: string[] = [];

		const first = async (): Promise<RenderResult | null> => {
			calls.push("first");
			controller.abort(new Error("stopped"));
			return null;
		};
		Object.defineProperty(first, "name", { value: "first" });

		await expect(
			handleSpecialUrls(
				"https://example.com",
				5,
				controller.signal,
				null,
				[],
				[first as never, succeedingHandler("second", calls)],
			),
		).rejects.toThrow("stopped");

		expect(calls).toEqual(["first"]);
	});
});
