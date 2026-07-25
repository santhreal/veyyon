/**
 * The Twitter handler tries every Nitter instance, and the message it returns
 * when none works describes what actually happened.
 *
 * WHY THIS SUITE EXISTS. `handleTwitter` walks four Nitter instances looking for
 * one that serves the tweet. The whole loop sat inside a single
 *
 *     } catch { if (signal?.aborted) throw new ToolAbortError(); }
 *
 * so the FIRST instance that threw ended every remaining attempt. That is not a
 * rare path: each instance is fetched with `Math.min(timeout, 10)` seconds, and a
 * public Nitter mirror going slow is the ordinary case, not the exception. One
 * slow mirror therefore skipped three healthy ones.
 *
 * What made it a product-truth failure rather than only a missed retry is where
 * control landed next. The handler does not return null on exhaustion; it returns
 * a synthesized `twitter-blocked` result, which counts as a match, so
 * `handleSpecialUrls` stops and the generic fetch never runs. The content of that
 * result was a fixed sentence: "Twitter/X blocks automated access. Nitter
 * instances were unavailable." After one timeout on the first mirror that
 * sentence was false in both halves. Nothing had established that X was blocking
 * anything, and three instances had not been contacted at all. The operator got a
 * confident terminal answer built from a conclusion no code had checked, which is
 * worse than an error, because an error invites a retry and this does not.
 *
 * The bare `catch {}` also discarded the error entirely, so a `TimeoutError` and a
 * linkedom parse bug produced byte-identical output and neither was diagnosable.
 *
 * The fix moves the try inside the loop, separates the caller stopping us from a
 * mirror running out of time, and accumulates a per-instance reason that the final
 * message reports.
 *
 * THE SPLIT IS THE INTERESTING PART, and the first version of this fix got it
 * backwards, which these tests caught. `@veyyon/utils` offers `isAbortError` (the
 * caller cancelled) and the broader `isCancellation` (cancelled OR a deadline
 * expired). Sibling code in `fetch.ts` wants the broad one, because there the
 * deadline IS the operation's budget. Here it is the opposite: `Math.min(timeout,
 * 10)` is a per-instance budget deliberately smaller than the caller's, and its
 * only purpose is to bound one slow mirror so the other three still get a turn.
 * Treating its expiry as a cancellation would defeat the budget that exists to
 * make the walk work. So a deadline joins `attempts` alongside an HTTP 503, and
 * only the CALLER's signal ends the walk. Two adjacent files, two different
 * predicates, both correct; that is why the hierarchy exists rather than one test.
 */
import { describe, expect, it, mock } from "bun:test";

/** Nitter HTML that the handler will accept: over 500 bytes with a `.tweet-content`. */
function nitterPage(text: string): string {
	const padding = "<!-- ".concat("x".repeat(600), " -->");
	return `<html><body>${padding}
		<div class="fullname">Ada Lovelace</div>
		<div class="username">@ada</div>
		<div class="tweet-date"><a>Jul 25, 2026</a></div>
		<div class="tweet-content">${text}</div>
	</body></html>`;
}

/** The exact rejection `scopedTimeoutSignal` produces when a per-instance budget runs out. */
function timeoutRejection(): DOMException {
	return new DOMException("The operation timed out.", "TimeoutError");
}

/**
 * Load the handler with `loadPage` replaced. The module is re-imported per test so
 * each one gets its own mock; `mock.module` is process-wide otherwise.
 */
async function withLoadPage(impl: (url: string, options: { timeout: number; signal?: AbortSignal }) => unknown) {
	const types = await import("@veyyon/coding-agent/web/scrapers/types");
	mock.module("@veyyon/coding-agent/web/scrapers/types", () => ({ ...types, loadPage: impl }));
	const mod = await import(`@veyyon/coding-agent/web/scrapers/twitter?t=${performance.now()}`);
	return mod.handleTwitter as (
		url: string,
		timeout: number,
		signal?: AbortSignal,
	) => Promise<{ content: string; method: string; notes: string[] } | null>;
}

describe("handleTwitter, when an instance fails", () => {
	it("keeps going to the next instance after one throws a deadline", async () => {
		// THE REGRESSION. Instance one times out; instance two has the tweet. The old
		// code abandoned the loop on the first throw and never reached instance two.
		const tried: string[] = [];
		const handleTwitter = await withLoadPage(async (url: string) => {
			tried.push(new URL(url).hostname);
			if (tried.length === 1) throw timeoutRejection();
			return {
				ok: true,
				content: nitterPage("Hello from the second mirror"),
				contentType: "text/html",
				finalUrl: url,
				status: 200,
			};
		});

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(result?.method).toBe("twitter-nitter");
		expect(result?.content).toContain("Hello from the second mirror");
		expect(tried).toHaveLength(2);
	});

	it("tries all four instances before giving up", async () => {
		const tried: string[] = [];
		const handleTwitter = await withLoadPage(async (url: string) => {
			tried.push(new URL(url).hostname);
			throw timeoutRejection();
		});

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(tried).toHaveLength(4);
		expect(new Set(tried).size).toBe(4);
		expect(result?.method).toBe("twitter-blocked");
	});

	it("names every instance and its reason in the fallback message", async () => {
		// The old fixed sentence asserted a cause nobody checked. The operator's next
		// move differs by reason: four timeouts is a transient network problem worth
		// retrying, four 429s is not.
		const handleTwitter = await withLoadPage(async (url: string) => {
			const host = new URL(url).hostname;
			if (host === "nitter.poast.org")
				return { ok: false, status: 429, content: "", contentType: "", finalUrl: url };
			throw timeoutRejection();
		});

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(result?.content).toContain("nitter.privacyredirect.com: The operation timed out.");
		expect(result?.content).toContain("nitter.poast.org: HTTP 429");
		expect(result?.content).not.toContain("Nitter instances were unavailable.");
		expect(result?.notes[0]).toContain("4 Nitter instance(s) tried");
	});

	it("does not let a per-instance deadline end the walk, unlike a caller abort", async () => {
		// THE PREDICATE CHOICE, pinned. `isCancellation` would return true for this
		// TimeoutError and abandon three healthy mirrors, defeating the per-instance
		// budget whose whole job is to give them a turn. Only `isAbortError` plus the
		// caller's own signal may stop the walk. The first version of this fix used
		// `isCancellation` here and this test is what caught it.
		const tried: string[] = [];
		const handleTwitter = await withLoadPage(async (url: string) => {
			tried.push(new URL(url).hostname);
			throw timeoutRejection();
		});

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(tried).toHaveLength(4);
		expect(result?.method).toBe("twitter-blocked");
	});

	it("records a short response as a distinct reason, not as a network failure", async () => {
		// A mirror that answers with a 200 and an interstitial is a different problem
		// from one that never answered, and the old code could not tell them apart
		// because the `content.length > 500` test just fell off the end of the loop.
		const handleTwitter = await withLoadPage(async (url: string) => ({
			ok: true,
			content: "<html>rate limited</html>",
			contentType: "text/html",
			finalUrl: url,
			status: 200,
		}));

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(result?.content).toContain("response too short to be a tweet (25 bytes)");
	});

	it("records a page with no tweet content as its own reason", async () => {
		const handleTwitter = await withLoadPage(async (url: string) => ({
			ok: true,
			content: `<html><body>${"y".repeat(600)}</body></html>`,
			contentType: "text/html",
			finalUrl: url,
			status: 200,
		}));

		const result = await handleTwitter("https://x.com/ada/status/1", 10);

		expect(result?.content).toContain("responded, but the page carried no tweet content");
	});
});

describe("handleTwitter, when the work is cancelled", () => {
	it("propagates a user abort instead of returning the blocked message", async () => {
		// The blocked message is a terminal answer: `handleSpecialUrls` treats it as a
		// match and stops. Returning it for a cancelled fetch tells the operator that
		// X blocks bots when in fact they pressed Escape.
		const controller = new AbortController();
		const tried: string[] = [];
		const handleTwitter = await withLoadPage(async (url: string) => {
			tried.push(new URL(url).hostname);
			controller.abort(new Error("user pressed Escape"));
			throw new DOMException("This operation was aborted", "AbortError");
		});

		const error = await handleTwitter("https://x.com/ada/status/1", 10, controller.signal).then(
			() => undefined,
			(e: unknown) => e,
		);

		// The signal's own reason wins over the shape the rejection happened to take,
		// because the reason is the sentence that names WHY, and the DOMException's
		// generic text does not.
		expect((error as Error).name).toBe("ToolAbortError");
		expect((error as Error).message).toContain("user pressed Escape");
		// The remaining three mirrors must not be attempted after the user is gone.
		expect(tried).toEqual(["nitter.privacyredirect.com"]);
	});

	it("ends the walk on an AbortError even when the caller's signal is untouched", async () => {
		// An abort SHAPE with no aborted signal means someone else cancelled the work
		// (a nested controller inside loadPage). It is still a cancellation, so it must
		// not be filed under "this mirror is slow" and retried against the next three.
		const tried: string[] = [];
		const thrown = new DOMException("This operation was aborted", "AbortError");
		const handleTwitter = await withLoadPage(async (url: string) => {
			tried.push(new URL(url).hostname);
			throw thrown;
		});

		const error = await handleTwitter("https://x.com/ada/status/1", 10).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBe(thrown);
		expect(tried).toHaveLength(1);
	});

	it("reports the cancellation when an instance swallowed it and threw something else", async () => {
		const controller = new AbortController();
		const reason = new Error("session ended");
		const handleTwitter = await withLoadPage(async () => {
			controller.abort(reason);
			throw new Error("Unexpected end of JSON input");
		});

		const error = await handleTwitter("https://x.com/ada/status/1", 10, controller.signal).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect((error as Error).name).toBe("ToolAbortError");
		expect((error as Error).cause).toBe(reason);
	});
});

describe("handleTwitter, when the URL is not its own", () => {
	it("returns null for a non-Twitter host so the next handler sees it", async () => {
		// THE NEGATIVE TWIN. Hoisting the URL checks out of the old try must not turn
		// a decline into a match; a match here would stop the whole dispatcher.
		const handleTwitter = await withLoadPage(async () => {
			throw new Error("loadPage must not be called for a URL this handler declines");
		});

		expect(await handleTwitter("https://example.com/ada/status/1", 10)).toBeNull();
	});

	it("returns null for an unparseable URL", async () => {
		const handleTwitter = await withLoadPage(async () => {
			throw new Error("loadPage must not be called for an unparseable URL");
		});

		expect(await handleTwitter("not a url", 10)).toBeNull();
	});
});
