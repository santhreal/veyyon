// WHY: every completion route the auth gateway serves (the three foreign wire formats and the
// pi-native fast path) walks the same request: read the JSON body, bind it to a model, resolve the
// session's credential, then answer with the finished turn or an event stream. Each step has its
// own way to fail, and each failure has to come back in the envelope of the wire the client spoke,
// with the status the gateway's classifier assigns. The sweep drives every route through a real
// server and asserts every reachable outcome byte for byte against that route's own `formatError`,
// so a route that answers in another wire's envelope, swaps a status, drops the classifier, or loses
// a step fails here. A request without an accepted bearer never reaches the first step and gets the
// gateway's plain 401. The routes are read from the server's own table, so a new route turns this
// suite red until it has a fixture.
//
// Not caught: the 499 every step answers once the client has closed its connection, which no client
// can read back through a real server; the content of the success bodies beyond the reply text and
// a marker naming the wire, which the per-wire encoder suites own.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { AUTH_GATEWAY_COMPLETION_PATHS, type AuthGatewayServerHandle, startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { classifyGatewayError } from "@veyyon/ai/error/gateway";
import * as anthropicMessages from "@veyyon/ai/providers/anthropic-messages-server";
import { createMockModel, type MockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import * as openaiChat from "@veyyon/ai/providers/openai-chat-server";
import * as openaiResponses from "@veyyon/ai/providers/openai-responses-server";
import * as piNative from "@veyyon/ai/providers/pi-native-server";
import * as streamModule from "@veyyon/ai/stream";
import type { AssistantMessage, StopReason } from "@veyyon/ai/types";
import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage } from "@veyyon/utils/type-guards";

/** What a route reads and writes: its error envelope and the parser that decides a malformed request. */
interface Wire {
	formatError(status: number, type: string, message: string): Response;
	parseRequest(body: unknown, headers?: Headers): unknown;
}

interface RouteFixture {
	wire: Wire;
	/** A request this route accepts for `model`. */
	request(model: string, stream: boolean): Record<string, unknown>;
	/** A request naming a known model that this route's parser rejects. */
	malformed(model: string): Record<string, unknown>;
	/** The message a request without a model is rejected with. */
	missingModel: string;
	/** A fragment only this wire's finished-turn body contains. */
	responseMarker: string;
	/** A fragment only this wire's event stream contains. */
	streamMarker: string;
}

const userTurn = [{ role: "user", content: "hello gateway" }];

const ROUTES: Record<string, RouteFixture> = {
	"/v1/chat/completions": {
		wire: openaiChat,
		request: (model, stream) => ({ model, stream, messages: userTurn }),
		malformed: model => ({ model, messages: "not a list" }),
		missingModel: "Missing top-level `model` field",
		responseMarker: '"object":"chat.completion"',
		streamMarker: '"object":"chat.completion.chunk"',
	},
	"/v1/messages": {
		wire: anthropicMessages,
		request: (model, stream) => ({ model, stream, max_tokens: 64, messages: userTurn }),
		malformed: model => ({ model, max_tokens: 64, messages: "not a list" }),
		missingModel: "Missing top-level `model` field",
		responseMarker: '"type":"message"',
		streamMarker: "event: message_start",
	},
	"/v1/responses": {
		wire: openaiResponses,
		request: (model, stream) => ({ model, stream, input: "hello gateway" }),
		malformed: model => ({ model, input: 7 }),
		missingModel: "Missing top-level `model` field",
		responseMarker: '"object":"response"',
		streamMarker: "event: response.output_text.delta",
	},
	"/v1/pi/stream": {
		wire: piNative,
		request: (model, stream) => ({ model, stream, context: { messages: [{ ...userTurn[0], timestamp: 0 }] } }),
		malformed: model => ({ model, context: { messages: "not a list" } }),
		missingModel: "Missing `modelId` (or `model.id`) field",
		responseMarker: '{"message":{"role":"assistant"',
		streamMarker: '"type":"text_delta"',
	},
};

const REPLY = "gateway sweep reply";
const keyed = createMockModel({ provider: "openrouter", id: "mock/sweep-keyed" });
const keyless = createMockModel({ provider: "gateway-sweep-keyless", id: "mock/sweep-keyless" });
const models = new Map<string, MockModel>([
	[keyed.id, keyed],
	[keyless.id, keyless],
]);

let dir: string;
let storage: AuthStorage;
let gateway: AuthGatewayServerHandle;

beforeAll(async () => {
	registerMockApi();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-route-outcomes-"));
	storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: id => models.get(id),
		version: "test",
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	keyed.reset();
});

afterAll(async () => {
	await gateway.close();
	storage.close();
	await fs.rm(dir, { recursive: true, force: true });
	clearCustomApis();
});

function post(route: string, body: string): Promise<Response> {
	return fetch(`${gateway.url}${route}`, {
		method: "POST",
		headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
		body,
	});
}

/** The response must be byte-for-byte what the route's own wire writes for this failure. */
async function expectEnvelope(res: Response, wire: Wire, status: number, type: string, message: string) {
	const expected = wire.formatError(status, type, message);
	expect({ status: res.status, contentType: res.headers.get("content-type"), body: await res.text() }).toEqual({
		status: expected.status,
		contentType: expected.headers.get("content-type"),
		body: await expected.text(),
	});
}

function parseFailure(wire: Wire, body: unknown): string {
	try {
		wire.parseRequest(body, new Headers());
	} catch (error) {
		return errorMessage(error);
	}
	throw new Error("the malformed fixture is accepted by the parser it is meant to fail");
}

/** A finished turn the provider reports as failed, with or without its own message. */
function failedTurn(stopReason: StopReason, message?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: keyed.api,
		provider: keyed.provider,
		model: keyed.id,
		usage: emptyUsage(),
		stopReason,
		errorMessage: message,
		timestamp: 0,
	};
}

/** A failure carrying its own status, so the classifier's answer differs from its 502 default. */
function statusError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

it("every completion route the gateway serves has a fixture here", () => {
	expect(Object.keys(ROUTES).sort()).toEqual([...AUTH_GATEWAY_COMPLETION_PATHS].sort());
});

describe.each(Object.entries(ROUTES))("completion route %s", (route, fixture) => {
	const { wire } = fixture;

	it("rejects a body that is not JSON with the parser's own words", async () => {
		const parseError = await new Response("{").json().catch((error: unknown) => error);
		const res = await post(route, "{");
		await expectEnvelope(res, wire, 400, "invalid_request_error", `Invalid JSON body: ${String(parseError)}`);
	});

	it("rejects a request that names no model", async () => {
		const res = await post(route, JSON.stringify({ stream: false }));
		await expectEnvelope(res, wire, 400, "invalid_request_error", fixture.missingModel);
	});

	it("answers 404 for a model the registry does not know", async () => {
		const res = await post(route, JSON.stringify(fixture.request("mock/never-registered", false)));
		await expectEnvelope(res, wire, 404, "invalid_request_error", "Unknown model: mock/never-registered");
	});

	it("rejects a malformed request for a known model with the parser's message", async () => {
		const body = fixture.malformed(keyed.id);
		const res = await post(route, JSON.stringify(body));
		await expectEnvelope(res, wire, 400, "invalid_request_error", parseFailure(wire, body));
	});

	it("turns away a request without an accepted bearer before reading it", async () => {
		for (const authorization of [undefined, "Bearer x", "Basic t"]) {
			const headers = new Headers({ "Content-Type": "application/json" });
			if (authorization !== undefined) headers.set("authorization", authorization);
			const body = JSON.stringify(fixture.request(keyed.id, false));
			const res = await fetch(`${gateway.url}${route}`, { method: "POST", headers, body });
			expect({ authorization, status: res.status, body: await res.json() }).toEqual({
				authorization,
				status: 401,
				body: { error: "unauthorized" },
			});
		}
	});

	it("answers a credential lookup that throws with the classifier's verdict", async () => {
		const failure = statusError(503, "credential broker unreachable");
		vi.spyOn(storage, "getApiKey").mockRejectedValue(failure);
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		const verdict = classifyGatewayError(failure);
		expect(verdict.status).toBe(503);
		await expectEnvelope(res, wire, verdict.status, verdict.type, verdict.message);
	});

	it("answers 401 when the provider has no credential", async () => {
		const res = await post(route, JSON.stringify(fixture.request(keyless.id, false)));
		await expectEnvelope(
			res,
			wire,
			401,
			"authentication_error",
			"No credential available for provider gateway-sweep-keyless",
		);
	});

	it("answers a turn the provider failed with the classifier's verdict on its message", async () => {
		keyed.push({ stopReason: "error", errorMessage: "rate limit exceeded" });
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		const verdict = classifyGatewayError("rate limit exceeded");
		expect(verdict.status).toBe(429);
		await expectEnvelope(res, wire, verdict.status, verdict.type, "rate limit exceeded");
	});

	it("answers a turn the provider aborted with 499 and the provider's message", async () => {
		keyed.push({ stopReason: "aborted", errorMessage: "provider hung up" });
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		await expectEnvelope(res, wire, 499, "request_aborted", "provider hung up");
	});

	it("names a failed turn that carries no message", async () => {
		vi.spyOn(streamModule, "completeSimple").mockResolvedValue(failedTurn("error"));
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		const verdict = classifyGatewayError("Upstream request failed");
		await expectEnvelope(res, wire, verdict.status, verdict.type, "Upstream request failed");
	});

	it("names an aborted turn that carries no message", async () => {
		vi.spyOn(streamModule, "completeSimple").mockResolvedValue(failedTurn("aborted"));
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		await expectEnvelope(res, wire, 499, "request_aborted", "Request was aborted");
	});

	it("answers a whole-turn call that throws with the classifier's verdict", async () => {
		const failure = statusError(429, "upstream rate limited");
		vi.spyOn(streamModule, "completeSimple").mockRejectedValue(failure);
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		const verdict = classifyGatewayError(failure);
		expect(verdict.status).toBe(429);
		await expectEnvelope(res, wire, verdict.status, verdict.type, verdict.message);
	});

	it("answers a stream that fails to start with the classifier's verdict", async () => {
		const failure = statusError(504, "upstream never answered");
		vi.spyOn(streamModule, "streamSimple").mockImplementation(() => {
			throw failure;
		});
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, true)));
		const verdict = classifyGatewayError(failure);
		expect(verdict.status).toBe(504);
		await expectEnvelope(res, wire, verdict.status, verdict.type, verdict.message);
	});

	it("answers a finished turn in its own wire", async () => {
		keyed.push({ content: [REPLY] });
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, false)));
		const body = await res.text();
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("application/json");
		expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(res.headers.get("x-litellm-response-duration-ms")).toMatch(/^\d+$/);
		expect(res.headers.get("x-litellm-response-cost")).toBe("0");
		expect(body).toContain(fixture.responseMarker);
		expect(body).toContain(REPLY);
		expect(keyed.calls.map(call => call.options?.apiKey)).toEqual(["test-key"]);
	});

	it("answers a streamed turn as an unbuffered event stream in its own wire", async () => {
		keyed.push({ content: [REPLY] });
		const res = await post(route, JSON.stringify(fixture.request(keyed.id, true)));
		const body = await res.text();
		expect(res.status).toBe(200);
		expect({
			contentType: res.headers.get("content-type"),
			cacheControl: res.headers.get("cache-control"),
			buffering: res.headers.get("x-accel-buffering"),
		}).toEqual({ contentType: "text/event-stream; charset=utf-8", cacheControl: "no-cache", buffering: "no" });
		expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(res.headers.get("x-litellm-response-duration-ms")).toBeNull();
		expect(res.headers.get("x-litellm-response-cost")).toBeNull();
		expect(body).toContain(fixture.streamMarker);
		expect(body).toContain(REPLY);
		expect(keyed.calls.map(call => call.options?.apiKey)).toEqual(["test-key"]);
	});
});
