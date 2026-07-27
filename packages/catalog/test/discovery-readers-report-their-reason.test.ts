/**
 * Every discovery reader in this package has to say WHY it produced no catalog.
 *
 * WHY THIS SUITE EXISTS. `fetchOpenAICompatibleModels` learned to report a reason first, and
 * `discovery-failure-reaches-the-caller.test.ts` pins the manager boundary that carries it. This suite pins
 * the readers that had NO channel at all and answered a bare `null` -- Codex, Cursor, Devin, Gemini,
 * Antigravity and GitLab Duo Workflow. Each of them lost the reason in a way that mattered:
 *
 *   - Codex and Antigravity walk a LIST (two routes, two endpoints) and `continue`d past every failure, so
 *     an expired token and a retired route ended in the same `null` naming neither attempt.
 *   - Cursor talks HTTP/2 directly and had five separate ways to resolve `null` with nothing recorded: the
 *     timeout, a connection error, a stream error, a non-2xx status, and an undecodable body.
 *   - Gemini paginates, so a failure on a later page was indistinguishable from a rejected key.
 *   - GitLab Duo reaches a model list through a namespace lookup, a project lookup, a paginated group walk
 *     and two GraphQL queries, and every one of them returned `null` silently.
 *
 * What the user saw in all of these was a model picker missing models they pay for, with nothing anywhere
 * explaining it. The tests below assert the STAGE and the DETAIL, not merely that something was reported,
 * because the stage is what decides where an operator looks: `request` at the network, `status` at
 * credentials, `body`/`payload` at whether the endpoint still speaks the protocol.
 *
 * Each reader also gets its silence pinned: a successful response reports NOTHING, including a success that
 * lists no models. A channel that fires on success is worse than no channel, because then every reason is
 * noise.
 */

import { describe, expect, it } from "bun:test";
import { fetchAntigravityDiscoveryModels } from "@veyyon/catalog/discovery/antigravity";
import { fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { fetchCursorUsableModels } from "@veyyon/catalog/discovery/cursor";
import { fetchDevinModels } from "@veyyon/catalog/discovery/devin";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import { fetchGeminiModels } from "@veyyon/catalog/discovery/gemini";
import { fetchGitLabDuoWorkflowModels } from "@veyyon/catalog/discovery/gitlab-duo-workflow";

/** A fetch stub that answers every request the same way, in the shape `discoveryFetch` expects. */
function respondWith(respond: (url: string) => Response | Promise<Response>): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request) =>
			respond(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url),
		{ preconnect() {} },
	) as unknown as typeof fetch;
}

/** A fetch stub that refuses the connection, which is what an unreachable host looks like from here. */
function refuseConnection(message = "connect ECONNREFUSED 127.0.0.1:443"): typeof fetch {
	return Object.assign(
		async () => {
			throw new Error(message);
		},
		{ preconnect() {} },
	) as unknown as typeof fetch;
}

/** Collect reported failures, which is exactly what a caller of these readers does. */
function collector(): { failures: DiscoveryFailure[]; onFailure: (failure: DiscoveryFailure) => void } {
	const failures: DiscoveryFailure[] = [];
	return { failures, onFailure: failure => failures.push(failure) };
}

describe("Codex discovery", () => {
	/**
	 * Both routes answer 401, and BOTH are reported: "the token is rejected everywhere" is a different
	 * problem from "the first route moved", and a reader that reported only the last attempt could not
	 * distinguish them.
	 */
	it("reports the status of every route it tried", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchCodexModels({
			accessToken: "stale-token",
			baseUrl: "https://codex.example/backend-api",
			fetchFn: respondWith(() => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures.map(failure => failure.stage)).toEqual(["status", "status"]);
		expect(failures[0]?.detail).toBe("HTTP 401 Unauthorized");
		// The two default routes, in the order they are attempted, so the reason names WHICH route.
		expect(failures[0]?.url).toContain("/codex/models");
		expect(failures[1]?.url).toContain("/models");
		expect(failures[1]?.url).not.toContain("/codex/models");
	});

	/** A host that never answers is a `request` failure carrying the underlying message, not a status. */
	it("reports an unreachable backend as a request failure", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchCodexModels({
			accessToken: "t",
			baseUrl: "https://codex.example/backend-api",
			fetchFn: refuseConnection(),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures[0]?.stage).toBe("request");
		expect(failures[0]?.detail).toContain("ECONNREFUSED");
	});

	/** A 200 whose body is not JSON points at a proxy rather than at the backend, and says so as `body`. */
	it("reports a non-JSON body", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchCodexModels({
			accessToken: "t",
			baseUrl: "https://codex.example/backend-api",
			fetchFn: respondWith(() => new Response("<html>captive portal</html>", { status: 200 })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures[0]?.stage).toBe("body");
		expect(failures[0]?.detail).toContain("not JSON");
	});

	/** The silence half of the contract: a route that answers with an empty list is not a failure. */
	it("reports nothing when a route succeeds with no models", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchCodexModels({
			accessToken: "t",
			baseUrl: "https://codex.example/backend-api",
			fetchFn: respondWith(() => new Response(JSON.stringify({ models: [] }))),
			onFailure,
		});

		expect(result).toEqual({ models: [] });
		expect(failures).toEqual([]);
	});
});

describe("Antigravity discovery", () => {
	/**
	 * The endpoint list is walked in order and every attempt reports, which is what turns "no Antigravity
	 * models" into "both the primary and the sandbox endpoint refused the connection".
	 */
	it("reports every endpoint it tried when all of them are unreachable", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchAntigravityDiscoveryModels({
			token: "oauth-token",
			fetcher: refuseConnection("getaddrinfo ENOTFOUND daily-cloudcode-pa.googleapis.com"),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures).toHaveLength(2);
		expect(failures.every(failure => failure.stage === "request")).toBe(true);
		expect(failures[0]?.detail).toContain("ENOTFOUND");
		expect(failures.map(failure => failure.url)).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
		]);
	});

	/** A rejected token is a `status`, and the number is the reason an operator acts on. */
	it("reports a rejected token as a status failure", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchAntigravityDiscoveryModels({
			token: "expired",
			endpoint: "https://antigravity.example",
			fetcher: respondWith(() => new Response("nope", { status: 403, statusText: "Forbidden" })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures).toEqual([
			{
				stage: "status",
				url: "https://antigravity.example/v1internal:fetchAvailableModels",
				detail: "HTTP 403 Forbidden",
			},
		]);
	});

	/** A successful response with an empty model map is a real answer, so nothing is reported. */
	it("reports nothing for a successful empty response", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchAntigravityDiscoveryModels({
			token: "t",
			endpoint: "https://antigravity.example",
			fetcher: respondWith(() => new Response(JSON.stringify({ models: {} }))),
			onFailure,
		});

		expect(result).toEqual([]);
		expect(failures).toEqual([]);
	});
});

describe("Devin discovery", () => {
	/** The session-token endpoint rejecting the token is a `status`, carried with its number. */
	it("reports a rejected session token as a status failure", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchDevinModels({
			apiKey: "stale",
			baseUrl: "https://devin.example",
			fetch: respondWith(() => new Response("no", { status: 401, statusText: "Unauthorized" })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures).toEqual([
			{
				stage: "status",
				url: "https://devin.example/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
				detail: "HTTP 401 Unauthorized",
			},
		]);
	});

	/**
	 * A 200 whose body is not a protobuf message at all -- a proxy login page is the usual culprit -- is a
	 * `body` failure, and the detail names BOTH decode attempts, because the direct decode and the gunzip
	 * retry failing for different reasons is what distinguishes a wrong body from a changed schema.
	 */
	it("reports an undecodable body naming both decode attempts", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchDevinModels({
			apiKey: "t",
			baseUrl: "https://devin.example",
			fetch: respondWith(() => new Response("<html>login</html>", { status: 200 })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures[0]?.stage).toBe("body");
		expect(failures[0]?.detail).toContain("not a GetCliModelConfigsResponse");
		expect(failures[0]?.detail).toContain("after gunzip:");
	});

	/** An unreachable host is a `request` failure, distinct from a token the endpoint rejected. */
	it("reports an unreachable host as a request failure", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchDevinModels({
			apiKey: "t",
			baseUrl: "https://devin.example",
			fetch: refuseConnection(),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures[0]?.stage).toBe("request");
		expect(failures[0]?.detail).toContain("ECONNREFUSED");
	});
});

describe("Gemini discovery", () => {
	/**
	 * An empty key is a configuration mistake, and it used to look exactly like an endpoint that is down.
	 * It reports `base-url`, and the reported URL is the keyless one -- see the leak test below.
	 */
	it("reports a missing API key rather than returning a bare null", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGeminiModels({ apiKey: "   ", onFailure });

		expect(result).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("base-url");
		expect(failures[0]?.detail).toBe("no API key is configured");
	});

	/**
	 * The page number is part of the reason. This reader paginates, so a failure on page 1 after a good page
	 * 0 is a listing that broke partway through, while a failure on page 0 is a rejected key: the same status
	 * means different things, and without the page an operator cannot tell which happened.
	 */
	it("reports which page failed", async () => {
		const { failures, onFailure } = collector();
		let call = 0;

		const result = await fetchGeminiModels({
			apiKey: "real-key",
			baseUrl: "https://gemini.example/v1beta",
			fetch: respondWith(() => {
				call += 1;
				if (call === 1) {
					return new Response(JSON.stringify({ models: [], nextPageToken: "page-two" }));
				}
				return new Response("boom", { status: 500, statusText: "Internal Server Error" });
			}),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("status");
		expect(failures[0]?.detail).toBe("page 1: HTTP 500 Internal Server Error");
	});

	/**
	 * The reported URL must NOT carry the API key, even though the REQUEST does: this reader passes the key
	 * as a `?key=` query parameter, and a reason travels into logs and bug reports. Pinned as its own test
	 * because it is the one way this channel could turn a diagnostic improvement into a credential leak.
	 */
	it("never puts the API key in the reported URL", async () => {
		const { failures, onFailure } = collector();

		await fetchGeminiModels({
			apiKey: "SECRET-KEY-VALUE",
			baseUrl: "https://gemini.example/v1beta",
			fetch: refuseConnection(),
			onFailure,
		});

		expect(failures).toHaveLength(1);
		expect(failures[0]?.url).toBe("https://gemini.example/v1beta/models");
		expect(JSON.stringify(failures)).not.toContain("SECRET-KEY-VALUE");
	});

	/** A body that is not JSON is `body`, so the operator looks at what answered rather than at the key. */
	it("reports a non-JSON body", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGeminiModels({
			apiKey: "k",
			baseUrl: "https://gemini.example/v1beta",
			fetch: respondWith(() => new Response("not json", { status: 200 })),
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures[0]?.stage).toBe("body");
		expect(failures[0]?.detail).toContain("page 0: response is not JSON");
	});

	/** A successful listing reports nothing, including one that yields no usable models. */
	it("reports nothing for a successful listing", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGeminiModels({
			apiKey: "k",
			baseUrl: "https://gemini.example/v1beta",
			fetch: respondWith(() => new Response(JSON.stringify({ models: [] }))),
			onFailure,
		});

		expect(result).toEqual([]);
		expect(failures).toEqual([]);
	});
});

describe("Cursor discovery", () => {
	/**
	 * Cursor speaks HTTP/2 to a real socket, so an unresolvable host is the failure this suite can provoke
	 * without a server: it exercises the `client.on("error")` path, which resolved `null` with no record at
	 * all. The detail says HTTP/2 so the reason distinguishes the transport from a status.
	 */
	it("reports a connection failure through its HTTP/2 transport", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchCursorUsableModels({
			apiKey: "token",
			// A reserved-for-documentation host that resolves nowhere, so no request escapes the test host.
			baseUrl: "https://cursor.invalid",
			timeoutMs: 2_000,
			onFailure,
		});

		expect(result).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("request");
		expect(failures[0]?.url).toBe("https://cursor.invalid/agent.v1.AgentService/GetUsableModels");
		expect(failures[0]?.detail).toMatch(/HTTP\/2 connection failed|no response within/);
	});
});

describe("GitLab Duo Workflow discovery", () => {
	/**
	 * The handshake tries the configured namespace first and then walks the token's groups, and EVERY step
	 * used to answer `null` silently. With a token GitLab rejects, the reasons name each request that was
	 * refused, which is what turns "no Duo models" into "this token is not accepted".
	 */
	it("reports each rejected request of the namespace handshake", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGitLabDuoWorkflowModels({
			apiKey: "stale-token",
			baseUrl: "https://gitlab.example",
			namespaceId: "42",
			fetch: respondWith(() => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })),
			onFailure,
		});

		expect(result).toBeNull();
		const statusFailures = failures.filter(failure => failure.stage === "status");
		expect(statusFailures.length).toBeGreaterThan(0);
		expect(statusFailures.every(failure => failure.detail === "HTTP 401 Unauthorized")).toBe(true);
		// The GraphQL availability query for the configured namespace is among the reported attempts, which
		// is the request whose silence made a rejected token look like a namespace without Duo access.
		expect(statusFailures.some(failure => failure.url === "https://gitlab.example/api/graphql")).toBe(true);
	});

	/**
	 * The conclusion is reported as well as the individual refusals, and it is reported as a `payload`
	 * failure rather than escaping as a throw.
	 *
	 * This reader is the one that ENDS by throwing when no candidate namespace has Duo access, which is
	 * correct for the runtime entry point that must stop, and wrong for a discovery reader: the manager
	 * catches a throw and labels it `unhandled`, which claims a bug in this reader when what actually
	 * happened is that the token sees no namespace with Duo models. The reader answers `null` like every
	 * other one now, and the operator gets the actionable sentence -- which env var to set -- as the reason.
	 */
	it("reports the unresolved namespace as a payload failure instead of throwing", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGitLabDuoWorkflowModels({
			apiKey: "token-without-duo",
			baseUrl: "https://gitlab.example",
			namespaceId: "42",
			fetch: respondWith(() => new Response("unauthorized", { status: 401, statusText: "Unauthorized" })),
			onFailure,
		});

		expect(result).toBeNull();
		const conclusion = failures.find(failure => failure.stage === "payload");
		expect(conclusion?.url).toBe("https://gitlab.example/api/graphql");
		expect(conclusion?.detail).toContain("GITLAB_DUO_NAMESPACE_ID");
	});

	/**
	 * A group listing that answers a JSON object where an array belongs is a `payload` failure naming what
	 * arrived. GitLab returns an object for an error envelope, and reading it as "no groups" is how the walk
	 * used to end without a word.
	 */
	it("reports a group listing that is not an array", async () => {
		const { failures, onFailure } = collector();

		const result = await fetchGitLabDuoWorkflowModels({
			apiKey: "token",
			baseUrl: "https://gitlab.example",
			fetch: respondWith(url =>
				url.includes("/api/v4/groups")
					? new Response(JSON.stringify({ message: "403 Forbidden" }), { status: 200 })
					: new Response("nope", { status: 404, statusText: "Not Found" }),
			),
			onFailure,
		});

		expect(result).toBeNull();
		const payloadFailure = failures.find(failure => failure.stage === "payload");
		expect(payloadFailure?.detail).toBe("expected an array of groups, received object");
	});
});
