import { afterEach, describe, expect, it } from "bun:test";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import { loadPage } from "@veyyon/coding-agent/web/scrapers/types";
import { CHROME_WINDOWS_USER_AGENT } from "@veyyon/coding-agent/web/search/providers/browser-headers";

/**
 * `loadPage` retries across a list of user agents, and the reason it exists is
 * narrow: some sites answer a browser `User-Agent` and refuse `curl/8.0`. The
 * loop must advance for THAT and for an ordinary transport error, and must not
 * advance for a deadline.
 *
 * It used to advance for a deadline. Each attempt armed its own
 * `scopedTimeoutSignal(timeout * 1000, signal)`, and the catch recorded the
 * rejection in `lastError` and continued, so an origin that could not answer
 * inside the budget was asked again, with a different `User-Agent`, twice more.
 * A caller passing `timeout: 20` therefore waited sixty seconds on every slow
 * origin, which means the option did not mean what it says. That is the bug this
 * file locks out, from both sides: a deadline must cost exactly one attempt, and
 * a bot block must still cost every user agent, because collapsing the loop
 * entirely would trade a speed bug for a capability loss.
 *
 * Attempts are counted rather than timed. A wall-clock assertion would prove the
 * same thing and fail on a loaded machine; the `User-Agent` of each request is
 * the deterministic record of how many times the loop went round.
 */

const realFetch = globalThis.fetch;

/** The user agents `loadPage` walks, in order, mirrored from the source. */
const CURL_UA = "curl/8.0";
const TEXTBOT_UA = "Mozilla/5.0 (compatible; TextBot/1.0)";
/**
 * Read from the module that owns what browser this tree claims to be, not retyped.
 *
 * The rotation's last rung has to actually get through, and a copy here would be a fourth statement of the
 * Chrome version that has to agree with the User-Agent and the `Sec-Ch-Ua` client hint in
 * `web/search/providers/browser-headers.ts`. This test file held Chrome 131 while that module claimed 149,
 * so it was asserting a stale identity and would have kept passing while the shipped rotation announced a
 * different browser. The order and the exact bytes are still asserted; only the source of the last string
 * moved.
 */
const CHROME_UA = CHROME_WINDOWS_USER_AGENT;
const ALL_USER_AGENTS = [CURL_UA, TEXTBOT_UA, CHROME_UA];

interface Attempt {
	userAgent: string;
	signal?: AbortSignal;
}

/**
 * Install a fetch that records every attempt and answers from `respond`.
 *
 * `respond` receives the zero-based attempt index so a test can describe a site
 * that behaves differently on the second try, which is the whole point of the
 * rotation.
 */
function patchFetch(respond: (attempt: number, init: RequestInit) => Response | Promise<Response>): Attempt[] {
	const attempts: Attempt[] = [];
	globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		attempts.push({ userAgent: headers["User-Agent"] ?? "", signal: init?.signal ?? undefined });
		return respond(attempts.length - 1, init ?? {});
	}, realFetch) as typeof fetch;
	return attempts;
}

/**
 * A response that never arrives, rejecting with the abort reason exactly as the
 * platform does.
 *
 * Verified against Bun: an aborted `fetch` rejects with the signal's `reason`
 * object itself, so a `scopedTimeoutSignal` deadline surfaces as the
 * `DOMException` named `TimeoutError` that `isTimeoutError` recognises. If this
 * helper rejected with a generic error instead, every test below would pass for
 * the wrong reason.
 */
function hangUntilAborted(init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const signal = init.signal;
		if (!signal) return;
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/** A Cloudflare-style block, the case the user-agent rotation exists for. */
function botBlocked(): Response {
	return html("<html><body>Attention Required! Cloudflare challenge</body></html>", 403);
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("loadPage stops the attempt loop on a deadline", () => {
	/**
	 * The headline regression. One expired budget must buy one attempt, so the
	 * `timeout` a caller passes is the whole call's ceiling and not a third of it.
	 */
	it("makes exactly one request when the deadline expires", async () => {
		const attempts = patchFetch((_attempt, init) => hangUntilAborted(init));

		const result = await loadPage("https://slow.example/page", { timeout: 0.05 });

		expect(attempts).toHaveLength(1);
		expect(attempts[0]?.userAgent).toBe(CURL_UA);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("The operation timed out.");
		expect(result.finalUrl).toBe("https://slow.example/page");
	});

	/**
	 * The rotation is not merely cut short, it is never entered: neither remaining
	 * user agent may appear. Asserting the count alone would still pass if the loop
	 * retried and the retry happened to fail before recording a header.
	 */
	it("never reaches the remaining user agents after a deadline", async () => {
		const attempts = patchFetch((_attempt, init) => hangUntilAborted(init));

		await loadPage("https://slow.example/page", { timeout: 0.05 });

		expect(attempts.map(entry => entry.userAgent)).toEqual([CURL_UA]);
	});

	/**
	 * The break has to work from the middle of the loop, not only from the first
	 * index. A site that fails a transport error on `curl/8.0` and then times out
	 * must stop at two attempts, and must report the DEADLINE rather than the
	 * earlier message that `lastError` was already holding.
	 */
	it("stops mid-rotation and reports the deadline, not the earlier failure", async () => {
		const attempts = patchFetch((attempt, init) => {
			if (attempt === 0) throw new TypeError("fetch failed");
			return hangUntilAborted(init);
		});

		const result = await loadPage("https://flaky.example/page", { timeout: 0.05 });

		expect(attempts.map(entry => entry.userAgent)).toEqual([CURL_UA, TEXTBOT_UA]);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("The operation timed out.");
	});

	/**
	 * A deadline expiring while the body streams is the same deadline. The scoped
	 * signal deliberately fences the streamed read as well as the request, so a
	 * response whose headers arrive in time but whose body stalls must not restart
	 * the download under a different user agent.
	 */
	it("does not retry when the deadline expires during the body read", async () => {
		const attempts = patchFetch((_attempt, init) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("<html>partial"));
					init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
		});

		const result = await loadPage("https://stalled.example/page", { timeout: 0.05 });

		expect(attempts).toHaveLength(1);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("The operation timed out.");
	});
});

describe("loadPage keeps rotating user agents for the cases that need it", () => {
	/**
	 * The negative twin of the headline test, and the reason the fix is a `break`
	 * on a deadline rather than a `break` on any failure. A Cloudflare block is
	 * exactly what a different `User-Agent` can get past, so all three must be
	 * tried before the call gives up.
	 */
	it("tries every user agent when the site bot-blocks", async () => {
		const attempts = patchFetch(() => botBlocked());

		const result = await loadPage("https://guarded.example/page", { timeout: 5 });

		expect(attempts.map(entry => entry.userAgent)).toEqual(ALL_USER_AGENTS);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
	});

	/**
	 * Rotation stops the moment it works. This is the payoff case: without it the
	 * whole loop would be dead weight, so it is pinned alongside the limit on it.
	 */
	it("stops as soon as a user agent gets through the block", async () => {
		const attempts = patchFetch(attempt =>
			attempt === 0 ? botBlocked() : html("<html><body>real page</body></html>"),
		);

		const result = await loadPage("https://guarded.example/page", { timeout: 5 });

		expect(attempts.map(entry => entry.userAgent)).toEqual([CURL_UA, TEXTBOT_UA]);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("real page");
	});

	/**
	 * An ordinary transport error still rotates. It is cheap, because a connection
	 * that fails fails fast, and the distinction the fix draws is about the budget
	 * being spent, not about failure in general.
	 */
	it("tries every user agent on an ordinary transport error", async () => {
		const attempts = patchFetch(() => {
			throw new TypeError("Unable to connect");
		});

		const result = await loadPage("https://down.example/page", { timeout: 5 });

		expect(attempts.map(entry => entry.userAgent)).toEqual(ALL_USER_AGENTS);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Unable to connect");
	});

	/**
	 * The boundary case that must NOT be read as our deadline. A gateway timeout is
	 * the site telling us something, delivered as a response inside the budget, and
	 * the existing contract returns it with its status intact.
	 */
	it("treats an HTTP 504 as the site's answer, not as an expired budget", async () => {
		const attempts = patchFetch(() => html("<html><body>Gateway Timeout</body></html>", 504));

		const result = await loadPage("https://gateway.example/page", { timeout: 5 });

		expect(attempts).toHaveLength(1);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(504);
		expect(result.content).toContain("Gateway Timeout");
		expect(result.error).toBeUndefined();
	});

	/**
	 * A 429 is retried once with the SAME user agent, because the site is rate
	 * limiting the caller rather than refusing the client. The deadline break must
	 * not disturb that, and the retry must not consume a rotation slot.
	 */
	it("retries a 429 once with the same user agent", async () => {
		const attempts = patchFetch(attempt =>
			attempt === 0 ? html("", 429, { "retry-after": "0" }) : html("<html><body>after the limit</body></html>"),
		);

		const result = await loadPage("https://limited.example/page", { timeout: 5 });

		expect(attempts.map(entry => entry.userAgent)).toEqual([CURL_UA, CURL_UA]);
		expect(result.ok).toBe(true);
		expect(result.content).toContain("after the limit");
	});
});

describe("loadPage cancellation", () => {
	/**
	 * A caller who has already given up gets no request at all. The check is at the
	 * top of the loop precisely so an aborted signal costs nothing.
	 */
	it("throws before fetching when the caller's signal is already aborted", async () => {
		const attempts = patchFetch(() => html("<html>unreachable</html>"));
		const controller = new AbortController();
		controller.abort(new DOMException("User pressed Escape", "AbortError"));

		await expect(loadPage("https://example.com/page", { signal: controller.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(attempts).toHaveLength(0);
	});

	/**
	 * The reason survives. `throwIfAborted` replaced a bare `new ToolAbortError()`
	 * here, which produced the generic "Operation aborted" for every cancellation
	 * and threw away the only thing that told an Escape from an expired deadline.
	 */
	it("preserves the caller's abort reason on the thrown error", async () => {
		patchFetch(() => html("<html>unreachable</html>"));
		const reason = new DOMException("Parent tool cancelled the child", "AbortError");
		const controller = new AbortController();
		controller.abort(reason);

		const error = await loadPage("https://example.com/page", { signal: controller.signal }).catch(caught => caught);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as ToolAbortError).cause).toBe(reason);
		expect((error as Error).message).toContain("Parent tool cancelled the child");
	});

	/**
	 * A caller abort mid-request ends the call rather than rotating. The deadline
	 * break and the abort throw are different exits and both have to hold: an
	 * abort is not a failure to describe, it is nobody waiting for the answer.
	 */
	it("throws instead of retrying when the caller aborts mid-request", async () => {
		const controller = new AbortController();
		const attempts = patchFetch((_attempt, init) => {
			queueMicrotask(() => controller.abort(new DOMException("User pressed Escape", "AbortError")));
			return hangUntilAborted(init);
		});

		await expect(
			loadPage("https://example.com/page", { timeout: 30, signal: controller.signal }),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(attempts).toHaveLength(1);
	});

	/**
	 * Aborting during the 429 backoff is the same cancellation with a different
	 * shape. That catch also minted a bare `ToolAbortError`, so the reason a wait
	 * of up to ten seconds ended was unrecoverable; it now goes through the one
	 * owner like every other abort.
	 */
	it("preserves the reason when the caller aborts during a 429 backoff", async () => {
		const controller = new AbortController();
		const reason = new DOMException("User pressed Escape", "AbortError");
		const attempts = patchFetch(() => {
			queueMicrotask(() => controller.abort(reason));
			return html("", 429, { "retry-after": "5" });
		});

		const error = await loadPage("https://limited.example/page", {
			timeout: 30,
			signal: controller.signal,
		}).catch(caught => caught);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as ToolAbortError).cause).toBe(reason);
		expect(attempts).toHaveLength(1);
	});
});
