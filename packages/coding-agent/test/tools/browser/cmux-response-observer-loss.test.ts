/**
 * Regression: the in-page network observer must not lose responses silently.
 *
 * `tab.waitForResponse()` polls a buffer that a page-injected script fills from
 * `fetch` and `XMLHttpRequest`. That script had three losses, all of them quiet:
 *
 *  1. A bare `catch {}` around the whole record-writing path. Anything that
 *     threw dropped the response with nothing anywhere to say so.
 *  2. `clone.text().catch(() => "")`, which makes a body that could not be read
 *     indistinguishable from a response that genuinely had no body. The empty
 *     string then reached the caller through `response.text()`.
 *  3. A 200-entry ring buffer that evicted the oldest records with no count.
 *
 * Every one of them produces the same symptom at the tool boundary:
 * `waitForResponse` times out with "timed out after Nms", exactly as if the
 * request had never been made. The operator cannot tell "it never arrived" from
 * "it arrived and we threw it away", and those have completely different fixes.
 *
 * The script cannot log (it runs in the browser page, where there is no
 * logger), so the loud path is to count the losses in the page state that the
 * tool already reads back, and to name them in the timeout error. These tests
 * pin the counts and the wording, because the wording is the part the operator
 * acts on.
 *
 * The script is exercised in a real VM context with stub `fetch`/`XMLHttpRequest`
 * rather than asserted against as source text, so what is proven is behaviour.
 */
import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import {
	CmuxTab,
	type CmuxTabClient,
	RESPONSE_OBSERVER_SCRIPT,
} from "@veyyon/coding-agent/tools/browser/cmux/cmux-tab";

interface StubHeaders {
	forEach(fn: (value: string, name: string) => void): void;
}

interface RecordedLoss {
	failed: number;
	evicted: number;
	bodyUnreadable: number;
}

/** A stand-in for a fetch Response, with control over what `clone().text()` does. */
function stubResponse(opts: {
	url: string;
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	/** When set, `clone().text()` rejects, standing in for a consumed or binary body. */
	bodyFails?: boolean;
	/** When set, `clone()` itself throws, standing in for a response that cannot be recorded at all. */
	cloneFails?: boolean;
}): unknown {
	const headers: StubHeaders = {
		forEach(fn) {
			for (const [name, value] of Object.entries(opts.headers ?? {})) fn(value, name);
		},
	};
	return {
		url: opts.url,
		status: opts.status ?? 200,
		statusText: opts.statusText ?? "OK",
		headers,
		clone() {
			if (opts.cloneFails) throw new Error("body already consumed");
			return {
				text: async () => {
					if (opts.bodyFails) throw new Error("stream is locked");
					return opts.body ?? "";
				},
			};
		},
	};
}

/**
 * A page context with the observer installed.
 *
 * `fetch` and `XMLHttpRequest` are replaced by stubs before the script runs, so
 * the script wraps the stubs exactly as it wraps the real ones in a browser.
 */
function installedPage(): {
	context: vm.Context;
	fetch(response: unknown): Promise<void>;
	xhr(opts: {
		url: string;
		status?: number;
		rawHeaders?: string;
		responseText?: string | null;
		throws?: boolean;
	}): void;
	loss(): RecordedLoss;
	recordCount(): number;
	eval<T>(script: string): T;
} {
	const sandbox: Record<string, unknown> = {};
	// The stub fetch resolves whatever the caller hands it; the script's wrapper
	// is what decides whether the response is recorded.
	sandbox.fetch = async (response: unknown) => response;
	sandbox.XMLHttpRequest = function StubXHR(this: Record<string, unknown>) {
		const listeners: Array<() => void> = [];
		this.addEventListener = (_type: string, fn: () => void) => listeners.push(fn);
		this.__fire = () => {
			for (const fn of listeners) fn();
		};
		return this;
	};
	const context = vm.createContext(sandbox);
	const installed = vm.runInContext(RESPONSE_OBSERVER_SCRIPT, context) as boolean;
	expect(installed).toBe(true);

	const run = <T>(script: string): T => vm.runInContext(script, context) as T;

	return {
		context,
		async fetch(response) {
			sandbox.__pending = response;
			await run<Promise<unknown>>("globalThis.fetch(globalThis.__pending)");
			// The observer records without awaiting, so let its microtasks settle.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
		xhr(opts) {
			sandbox.__xhrOpts = opts;
			run(`(() => {
				const opts = globalThis.__xhrOpts;
				const xhr = new globalThis.XMLHttpRequest();
				xhr.responseURL = opts.url;
				xhr.status = opts.status === undefined ? 200 : opts.status;
				xhr.statusText = "OK";
				xhr.getAllResponseHeaders = () => opts.rawHeaders === undefined ? "content-type: text/plain" : opts.rawHeaders;
				if (opts.throws) {
					Object.defineProperty(xhr, "responseText", { get() { throw new Error("responseType is arraybuffer"); } });
				} else {
					xhr.responseText = opts.responseText === undefined ? "hello" : opts.responseText;
				}
				xhr.__fire();
				return true;
			})()`);
		},
		loss: () => run<RecordedLoss>("(() => globalThis.__veyyonCmuxResponses.lost)()"),
		recordCount: () => run<number>("(() => globalThis.__veyyonCmuxResponses.records.length)()"),
		eval: run,
	};
}

describe("the in-page response observer counts what it loses", () => {
	it("records a normal fetch response and reports no loss", async () => {
		// The premise of every test below: with nothing going wrong, the counters
		// stay at zero, so a non-zero count later means something real.
		const page = installedPage();

		await page.fetch(stubResponse({ url: "https://example.test/api", body: '{"ok":true}' }));

		expect(page.recordCount()).toBe(1);
		expect(page.loss()).toEqual({ failed: 0, evicted: 0, bodyUnreadable: 0 });
	});

	it("counts a response it could not record at all instead of swallowing the throw", async () => {
		// The bare `catch {}`. A response whose clone throws is gone; the only
		// question is whether anything says so.
		const page = installedPage();

		await page.fetch(stubResponse({ url: "https://example.test/gone", cloneFails: true }));

		expect(page.recordCount()).toBe(0);
		expect(page.loss().failed).toBe(1);
	});

	it("counts an unreadable body and marks the record, rather than storing an empty string", async () => {
		// `.catch(() => "")`. The record is still worth keeping (status and headers
		// are intact), but its body is not "" in the sense a caller would read it.
		const page = installedPage();

		await page.fetch(stubResponse({ url: "https://example.test/blob", bodyFails: true }));

		expect(page.recordCount()).toBe(1);
		expect(page.loss().bodyUnreadable).toBe(1);
		expect(page.eval<boolean>("(() => globalThis.__veyyonCmuxResponses.records[0].bodyUnreadable)()")).toBe(true);
	});

	it("distinguishes a genuinely empty body from one it could not read", async () => {
		// The two used to be byte-identical in the buffer. This is the assertion
		// that says they no longer are.
		const page = installedPage();

		await page.fetch(stubResponse({ url: "https://example.test/empty", body: "" }));
		await page.fetch(stubResponse({ url: "https://example.test/locked", bodyFails: true }));

		const flags = page.eval<boolean[]>(
			"(() => globalThis.__veyyonCmuxResponses.records.map(r => r.bodyUnreadable))()",
		);
		expect(flags).toEqual([false, true]);
		expect(page.loss().bodyUnreadable).toBe(1);
	});

	it("counts every record it evicts once the buffer is full", async () => {
		// 205 responses into a 200-entry buffer: 5 evicted, and the count has to
		// say 5 rather than the buffer quietly holding the last 200.
		const page = installedPage();

		for (let i = 0; i < 205; i++) {
			await page.fetch(stubResponse({ url: `https://example.test/${i}`, body: String(i) }));
		}

		expect(page.recordCount()).toBe(200);
		expect(page.loss().evicted).toBe(5);
		// The survivors are the newest ones, which is the intended policy; the fix
		// is about reporting the eviction, not about changing which records go.
		expect(page.eval<string>("(() => globalThis.__veyyonCmuxResponses.records[0].url)()")).toBe(
			"https://example.test/5",
		);
	});

	it("evicts XHR records on the same rule as fetch records, counting them too", async () => {
		// The XHR path had its own copy of the eviction line, without the counter.
		// Both go through one helper now, and this is what proves it.
		const page = installedPage();

		for (let i = 0; i < 203; i++) page.xhr({ url: `https://example.test/xhr/${i}` });

		expect(page.recordCount()).toBe(200);
		expect(page.loss().evicted).toBe(3);
	});

	it("records an XHR response with its headers parsed", async () => {
		const page = installedPage();

		page.xhr({ url: "https://example.test/xhr", rawHeaders: "Content-Type: application/json\r\nX-Trace: abc" });

		expect(
			page.eval<Record<string, string>>("(() => globalThis.__veyyonCmuxResponses.records[0].headers)()"),
		).toEqual({
			"content-type": "application/json",
			"x-trace": "abc",
		});
	});

	it("counts an XHR body that throws on read instead of letting the handler die", async () => {
		// Reading `responseText` throws when responseType is arraybuffer or blob.
		// That threw out of the event listener, losing the whole record silently.
		const page = installedPage();

		page.xhr({ url: "https://example.test/binary", throws: true });

		expect(page.recordCount()).toBe(1);
		expect(page.loss().bodyUnreadable).toBe(1);
		expect(page.loss().failed).toBe(0);
		expect(page.eval<boolean>("(() => globalThis.__veyyonCmuxResponses.records[0].bodyUnreadable)()")).toBe(true);
	});

	it("counts a non-string XHR body as unreadable rather than as empty", async () => {
		const page = installedPage();

		page.xhr({ url: "https://example.test/json-type", responseText: null });

		expect(page.loss().bodyUnreadable).toBe(1);
		expect(page.eval<string>("(() => globalThis.__veyyonCmuxResponses.records[0].body)()")).toBe("");
	});

	it("installs once, so a second install does not reset the counts it has accumulated", async () => {
		// `waitForResponse` installs the observer on every call. If installing
		// twice reset the state, the losses would be erased before anyone read them.
		const page = installedPage();

		await page.fetch(stubResponse({ url: "https://example.test/gone", cloneFails: true }));
		expect(page.loss().failed).toBe(1);

		expect(page.eval<boolean>(RESPONSE_OBSERVER_SCRIPT)).toBe(true);

		expect(page.loss().failed).toBe(1);
	});
});

/**
 * Drives the real `CmuxTab` against the real observer script.
 *
 * The client is narrowed to the one method the tab uses, so this stub is fully
 * type checked rather than forced through with a double cast. The eval result
 * is JSON round-tripped because the real transport is a socket carrying JSON,
 * and a value that does not survive that is a bug this stub should not hide.
 */
/**
 * Start a wait and let it arm before the caller fires the response.
 *
 * `waitForResponse` only matches responses that arrive after the call, so a
 * test that fires before the observer cursor is read is asserting the wrong
 * thing. Firing through a callback keeps the ordering explicit, and keeps the
 * pending wait out of a variable that an `await` would unwrap early.
 */
async function waitWhile(tab: CmuxTab, pattern: string, fire: () => Promise<void>) {
	const waiting = tab.waitForResponse(pattern, { timeout: 3_000 });
	await Bun.sleep(50);
	await fire();
	return await waiting;
}

function tabOverPage(page: ReturnType<typeof installedPage>): CmuxTab {
	const client: CmuxTabClient = {
		async request(method, params) {
			if (method !== "browser.eval") throw new Error(`unexpected method: ${method}`);
			const value = page.eval<unknown>(String(params.script));
			return { value: JSON.parse(JSON.stringify(value ?? null)) as unknown };
		},
	};
	return new CmuxTab({ client, surfaceId: "surface-1", url: "https://example.test/" });
}

describe("waitForResponse reports what the observer lost", () => {
	it("returns the matching response when one arrives", async () => {
		// Anti-vacuity for the timeout tests: the matching path has to work, or
		// every assertion about the timeout wording proves nothing.
		const page = installedPage();
		const tab = tabOverPage(page);

		const response = await waitWhile(tab, "/api/user", () =>
			page.fetch(stubResponse({ url: "https://example.test/api/user", body: '{"id":7}' })),
		);

		expect(response.url()).toBe("https://example.test/api/user");
		expect(response.status()).toBe(200);
		expect(await response.json()).toEqual({ id: 7 });
	});

	it("times out plainly when nothing was lost, so the message stays about the request", async () => {
		// With zero loss the operator should look at their own request, and the
		// message must not muddy that with talk of discarded responses.
		const page = installedPage();
		const tab = tabOverPage(page);

		await expect(tab.waitForResponse("/never", { timeout: 150 })).rejects.toThrow(
			/tab\.waitForResponse\(\) timed out after 150ms\.$/,
		);
	});

	it("names dropped records in the timeout, because the match may have been one of them", async () => {
		// THE symptom this whole fix is about. Before, this timed out with exactly
		// the same words as a request that was never made.
		const page = installedPage();
		const tab = tabOverPage(page);

		await page.fetch(stubResponse({ url: "https://example.test/api/user", cloneFails: true }));

		const error = await tab.waitForResponse("/api/user", { timeout: 150 }).catch((e: Error) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("1 could not be recorded");
		expect((error as Error).message).toContain("a matching response may have arrived and been discarded");
	});

	it("names evicted records in the timeout, with the buffer size that caused it", async () => {
		const page = installedPage();
		const tab = tabOverPage(page);

		for (let i = 0; i < 202; i++) {
			await page.fetch(stubResponse({ url: `https://example.test/noise/${i}` }));
		}

		const error = await tab.waitForResponse("/api/user", { timeout: 150 }).catch((e: Error) => e);

		expect((error as Error).message).toContain("2 were evicted from the 200-response buffer");
	});

	it("names unreadable bodies in the timeout, which a body-matching predicate would have missed", async () => {
		const page = installedPage();
		const tab = tabOverPage(page);

		await page.fetch(stubResponse({ url: "https://example.test/blob", bodyFails: true }));

		const error = await tab.waitForResponse("/api/user", { timeout: 150 }).catch((e: Error) => e);

		expect((error as Error).message).toContain("1 had an unreadable body");
	});

	it("lists every kind of loss at once rather than only the first", async () => {
		const page = installedPage();
		const tab = tabOverPage(page);

		await page.fetch(stubResponse({ url: "https://example.test/gone", cloneFails: true }));
		await page.fetch(stubResponse({ url: "https://example.test/blob", bodyFails: true }));

		const error = await tab.waitForResponse("/api/user", { timeout: 150 }).catch((e: Error) => e);

		expect((error as Error).message).toContain("1 could not be recorded");
		expect((error as Error).message).toContain("1 had an unreadable body");
	});

	it("refuses to hand back an unreadable body as an empty string", async () => {
		// The last place the loss leaked out. `text()` returning "" told the caller
		// the server sent nothing, which is a different thing entirely.
		const page = installedPage();
		const tab = tabOverPage(page);

		const response = await waitWhile(tab, "/blob", () =>
			page.fetch(stubResponse({ url: "https://example.test/blob", bodyFails: true })),
		);

		// The response itself is still useful, which is why the record is kept.
		expect(response.status()).toBe(200);
		await expect(response.text()).rejects.toThrow("could not be read as text");
		// And the error says what to do instead, rather than only what went wrong.
		await expect(response.text()).rejects.toThrow("tab.evaluate()");
	});

	it("fails json() on an unreadable body with the cause, not with a parse error", async () => {
		// `JSON.parse("")` throws "Unexpected end of JSON input", which sends the
		// reader after the server's response format instead of after the real cause.
		const page = installedPage();
		const tab = tabOverPage(page);

		const response = await waitWhile(tab, "/blob", () =>
			page.fetch(stubResponse({ url: "https://example.test/blob", bodyFails: true })),
		);

		await expect(response.json()).rejects.toThrow("could not be read as text");
	});

	it("still returns an empty body as an empty string", async () => {
		// The negative twin of the two tests above: a response that really was
		// empty must keep working, or the fix has traded one lie for another.
		const page = installedPage();
		const tab = tabOverPage(page);

		const response = await waitWhile(tab, "/empty", () =>
			page.fetch(stubResponse({ url: "https://example.test/empty", body: "" })),
		);

		expect(await response.text()).toBe("");
	});
});
