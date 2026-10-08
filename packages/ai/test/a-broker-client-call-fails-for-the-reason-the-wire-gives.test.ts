/**
 * WHY: `AuthBrokerClient` turns every broker exchange into either a validated value or an
 * `AuthBrokerError` that states what went wrong: the transport, the caller's abort, the HTTP
 * status, the response shape, or the snapshot stream's framing. A refactor of the request and
 * stream paths can keep the happy path green while it retries a call the caller aborted, sends
 * one attempt fewer, drops the transport error it gave up on, accepts a body its schema rejects,
 * cuts a long poll at the plain request deadline, or reads a stream that does not open with a
 * snapshot. Each test here reaches the client through its public methods against a fake broker
 * transport and asserts the error, the attempt count on the wire, or the events yielded.
 *
 * The schema sweep enumerates the client's request methods from its prototype at run time, so a
 * new method fails the sweep until it is listed with a call. It does not cover what a broker
 * sends inside a schema-valid body, which the wire and remote-store suites drive end to end.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	AuthBrokerClient,
	type SnapshotStreamEvent,
	type SnapshotStreamRemovedEvent,
	type SnapshotStreamSnapshotEvent,
} from "@veyyon/ai/auth-broker";
import { AuthBrokerError, AuthBrokerStreamUnsupportedError } from "@veyyon/ai/error";

const BASE_URL = "http://broker.test";
const REFRESHER = { enabled: false, intervalMs: 60_000, skewMs: 300_000, nextSweepInMs: 0 };
const SNAPSHOT_EVENT: SnapshotStreamSnapshotEvent = {
	kind: "snapshot",
	generation: 1,
	generatedAt: 0,
	serverNowMs: 0,
	refresher: REFRESHER,
	credentials: [],
};
const REMOVED_EVENT: SnapshotStreamRemovedEvent = {
	kind: "removed",
	generation: 2,
	serverNowMs: 0,
	refresher: REFRESHER,
	id: 7,
};

interface FakeBroker {
	fetchImpl: typeof fetch;
	/** `METHOD /path` of every request that left the client. */
	requests: string[];
}

function fakeBroker(respond: (init: RequestInit) => Response | Promise<Response>): FakeBroker {
	const requests: string[] = [];
	const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
		// Like fetch, a request on an aborted signal never leaves the client.
		init.signal?.throwIfAborted();
		requests.push(`${init.method ?? "GET"} ${new URL(String(input)).pathname}`);
		return respond(init);
	}) as typeof fetch;
	return { fetchImpl, requests };
}

function brokerClient(fetchImpl: typeof fetch, opts: { maxRetries?: number; timeoutMs?: number } = {}) {
	return new AuthBrokerClient({ url: BASE_URL, token: "bearer", fetchImpl, ...opts });
}

async function rejection(pending: Promise<unknown>): Promise<AuthBrokerError> {
	try {
		await pending;
	} catch (error) {
		if (error instanceof AuthBrokerError) return error;
		throw error;
	}
	throw new Error("expected the call to reject");
}

function sse(...frames: string[]): Response {
	return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

function dataFrame(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

async function drain(
	stream: AsyncGenerator<SnapshotStreamEvent>,
): Promise<{ events: readonly SnapshotStreamEvent[]; error: AuthBrokerError }> {
	const events: SnapshotStreamEvent[] = [];
	try {
		for await (const event of stream) events.push(event);
	} catch (error) {
		if (error instanceof AuthBrokerError) return { events, error };
		throw error;
	}
	throw new Error("expected the stream to end with an error");
}

describe("a transport failure", () => {
	test.each([0, 1, 2])("is sent maxRetries + 1 times with maxRetries=%d and ends as the cause", async maxRetries => {
		const transportError = new TypeError("fetch failed");
		const broker = fakeBroker(() => {
			throw transportError;
		});
		const error = await rejection(brokerClient(broker.fetchImpl, { maxRetries }).fetchUsage());
		expect(error.message).toBe(`Auth broker request failed after ${maxRetries + 1} attempt(s)`);
		expect(error.cause).toBe(transportError);
		expect(error.status).toBeUndefined();
		expect(broker.requests).toEqual(Array.from({ length: maxRetries + 1 }, () => "GET /v1/usage"));
	});

	test("followed by an answer returns the answer", async () => {
		let attempts = 0;
		const broker = fakeBroker(() => {
			attempts += 1;
			if (attempts === 1) throw new TypeError("fetch failed");
			return Response.json({ ok: true, version: "1.2.3" });
		});
		expect(await brokerClient(broker.fetchImpl, { maxRetries: 1 }).healthz()).toEqual({ ok: true, version: "1.2.3" });
		expect(broker.requests).toEqual(["GET /v1/healthz", "GET /v1/healthz"]);
	});
});

test("an HTTP error status is reported once with its status and body, not retried", async () => {
	const broker = fakeBroker(() => new Response("broker down", { status: 503, statusText: "Service Unavailable" }));
	const error = await rejection(brokerClient(broker.fetchImpl, { maxRetries: 3 }).fetchUsage());
	expect(error.message).toBe("Auth broker request failed: 503 Service Unavailable");
	expect(error.status).toBe(503);
	expect(error.body).toBe("broker down");
	expect(broker.requests).toEqual(["GET /v1/usage"]);
});

describe("the caller's abort", () => {
	test("during a failing attempt ends the call with no retry", async () => {
		const controller = new AbortController();
		const reason = new Error("caller stopped");
		const broker = fakeBroker(() => {
			controller.abort(reason);
			throw new TypeError("fetch failed");
		});
		const error = await rejection(brokerClient(broker.fetchImpl, { maxRetries: 3 }).fetchUsage(controller.signal));
		expect(error.message).toBe("Auth broker request aborted");
		expect(error.cause).toBe(reason);
		expect(broker.requests).toEqual(["GET /v1/usage"]);
	});

	const preAbortedCalls: {
		name: string;
		call: (client: AuthBrokerClient, signal: AbortSignal) => Promise<unknown>;
	}[] = [
		{ name: "a request", call: (client, signal) => client.fetchUsage(signal) },
		{ name: "the snapshot stream", call: (client, signal) => client.openSnapshotStream({ signal }).next() },
	];
	test.each(preAbortedCalls)("already taken sends no $name", async ({ call }) => {
		const reason = new Error("caller stopped");
		const broker = fakeBroker(() => Response.json({}));
		const error = await rejection(call(brokerClient(broker.fetchImpl), AbortSignal.abort(reason)));
		expect(error.message).toBe("Auth broker request aborted");
		expect(error.cause).toBe(reason);
		expect(broker.requests).toEqual([]);
	});
});

/** One call per request method; `openSnapshotStream` is the stream and has its own tests. */
const RESPONSE_CALLS: Record<string, (client: AuthBrokerClient) => Promise<unknown>> = {
	healthz: client => client.healthz(),
	fetchSnapshot: client => client.fetchSnapshot(),
	fetchUsage: client => client.fetchUsage(),
	notifyUsageStale: client => client.notifyUsageStale(),
	refreshCredential: client => client.refreshCredential(7),
	disableCredential: client => client.disableCredential(7, "revoked"),
	uploadCredential: client => client.uploadCredential("anthropic", { type: "api_key", key: "key" }),
	upsertCredentialBlock: client =>
		client.upsertCredentialBlock(7, { providerKey: "anthropic:oauth", blockScope: "", blockedUntilMs: 1 }),
	deleteCredentialBlocks: client => client.deleteCredentialBlocks(7),
};

describe("a response body its schema rejects", () => {
	test("is checked for every request method the client declares", () => {
		const methods = Object.getOwnPropertyNames(AuthBrokerClient.prototype).filter(
			name =>
				name !== "constructor" &&
				typeof Object.getOwnPropertyDescriptor(AuthBrokerClient.prototype, name)?.value === "function",
		);
		expect(methods.filter(name => !(name in RESPONSE_CALLS))).toEqual(["openSnapshotStream"]);
		expect(Object.keys(RESPONSE_CALLS).filter(name => !methods.includes(name))).toEqual([]);
	});

	test.each(Object.entries(RESPONSE_CALLS))("fails %s with the response status", async (_name, call) => {
		const broker = fakeBroker(() => Response.json(42));
		const error = await rejection(call(brokerClient(broker.fetchImpl)));
		expect(error.message).toBe("Auth broker response failed schema validation");
		expect(error.status).toBe(200);
	});
});

describe("a long poll", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test.each([
		{ timeoutMs: 1_000, waitMs: 5_000, deadlineMs: 6_000 },
		{ timeoutMs: 10_000, waitMs: 2_000, deadlineMs: 10_000 },
		{ timeoutMs: 3_000, waitMs: 0, deadlineMs: 3_000 },
		{ timeoutMs: 3_000, waitMs: undefined, deadlineMs: 3_000 },
	])(
		"is abandoned at $deadlineMs ms with timeoutMs=$timeoutMs and waitMs=$waitMs",
		async ({ timeoutMs, waitMs, deadlineMs }) => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			const broker = fakeBroker(init => {
				const { promise, reject } = Promise.withResolvers<Response>();
				signal = init.signal ?? undefined;
				signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
				return promise;
			});
			const pending = rejection(
				brokerClient(broker.fetchImpl, { timeoutMs, maxRetries: 0 }).fetchSnapshot({ waitMs }),
			);
			vi.advanceTimersByTime(deadlineMs - 1);
			expect(signal?.aborted).toBe(false);
			vi.advanceTimersByTime(1);
			expect(signal?.aborted).toBe(true);
			expect((await pending).message).toBe("Auth broker request failed after 1 attempt(s)");
		},
	);
});

describe("the snapshot stream", () => {
	test.each([
		{
			name: "yields every event after the opening snapshot and skips empty keepalive frames",
			frames: [dataFrame(SNAPSHOT_EVENT), ": keepalive\n\n", "data:\n\n", dataFrame(REMOVED_EVENT)],
			events: [SNAPSHOT_EVENT, REMOVED_EVENT],
			message: "Auth broker stream ended unexpectedly",
		},
		{
			name: "rejects a first event that is not a snapshot",
			frames: [dataFrame(REMOVED_EVENT), dataFrame(SNAPSHOT_EVENT)],
			events: [],
			message: "Auth broker stream did not start with snapshot",
		},
		{
			name: "reports an end before any snapshot",
			frames: [": keepalive\n\n"],
			events: [],
			message: "Auth broker stream ended before initial snapshot",
		},
		{
			name: "rejects an event that is not JSON",
			frames: [dataFrame(SNAPSHOT_EVENT), "data: {not json\n\n"],
			events: [SNAPSHOT_EVENT],
			message: "Auth broker stream returned malformed JSON",
		},
		{
			name: "rejects an event its schema does not accept",
			frames: [dataFrame(SNAPSHOT_EVENT), dataFrame({ ...REMOVED_EVENT, id: "seven" })],
			events: [SNAPSHOT_EVENT],
			message: "Auth broker stream event failed schema validation",
		},
	])("$name", async ({ frames, events, message }) => {
		const broker = fakeBroker(() => sse(...frames));
		const result = await drain(brokerClient(broker.fetchImpl).openSnapshotStream());
		expect(result.events).toEqual(events);
		expect(result.error.message).toBe(message);
		expect(broker.requests).toEqual(["GET /v1/snapshot/stream"]);
	});

	test("ends quietly when the caller aborts after the opening snapshot", async () => {
		const controller = new AbortController();
		const broker = fakeBroker(() => sse(dataFrame(SNAPSHOT_EVENT)));
		const events: SnapshotStreamEvent[] = [];
		for await (const event of brokerClient(broker.fetchImpl).openSnapshotStream({ signal: controller.signal })) {
			events.push(event);
			controller.abort();
		}
		expect(events).toEqual([SNAPSHOT_EVENT]);
	});

	test.each([
		{
			name: "a 404 as unsupported",
			response: () => new Response("not found", { status: 404 }),
			status: 404,
			message: new AuthBrokerStreamUnsupportedError().message,
		},
		{
			name: "another failing status with its body",
			response: () => new Response("upstream", { status: 502, statusText: "Bad Gateway" }),
			status: 502,
			message: "Auth broker stream failed: 502 Bad Gateway",
		},
		{
			name: "a body that is not an event stream",
			response: () => Response.json(SNAPSHOT_EVENT),
			status: 200,
			message: "Auth broker stream returned non-SSE response",
		},
	])("reports $name", async ({ response, status, message }) => {
		const broker = fakeBroker(response);
		const error = await rejection(brokerClient(broker.fetchImpl).openSnapshotStream().next());
		expect(error.message).toBe(message);
		expect(error.status).toBe(status);
	});
});
