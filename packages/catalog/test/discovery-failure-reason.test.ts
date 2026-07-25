/**
 * OpenAI-compatible discovery: `null` must be able to say WHY.
 *
 * WHY THIS SUITE EXISTS. `fetchOpenAICompatibleModels` answers a transport or protocol failure with
 * `null` and an empty catalog with `[]`, and it swallowed every underlying error on the way. The caller
 * that turns this into a model list keeps a per-provider discovery state and already reports a reason
 * when discovery THROWS, but a swallowed failure never reached it, so a provider whose endpoint refused
 * the connection recorded the same "no models" state as one that answered with an empty list. What the
 * user sees is a picker missing models they pay for, with nothing anywhere explaining it.
 *
 * The reason now travels back through `onFailure`, as a value rather than a log line: this package is a
 * data library, no source file in it logs, and its callers already own the state they report from.
 * Adding a logger here would have put the explanation somewhere the caller cannot reach and would have
 * given the same failure two owners.
 *
 * `stage` is the part worth having, so each stage is pinned separately: an operator reading
 * `request` goes to DNS and firewalls, `status` to credentials, and `payload` to whether the endpoint is
 * OpenAI-compatible at all. A single "discovery failed" would send all three to the same wrong place.
 */

import { describe, expect, it } from "bun:test";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleDiscoveryFailure,
} from "../src/discovery/openai-compatible";

/** Run discovery against a stub fetch, collecting whatever reasons it reports. */
async function discover(
	fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
	baseUrl = "https://models.example.com",
): Promise<{ models: unknown[] | null; failures: OpenAICompatibleDiscoveryFailure[] }> {
	const failures: OpenAICompatibleDiscoveryFailure[] = [];
	const models = await fetchOpenAICompatibleModels({
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		fetch: fetchImpl as never,
		onFailure: failure => failures.push(failure),
	});
	return { models, failures };
}

/** A `/models` response body, as an ok JSON response. */
function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("an endpoint that answers with models", () => {
	/** The ordinary case: models come back and nothing is reported. */
	it("returns the models and reports no failure", async () => {
		const { models, failures } = await discover(async () => jsonResponse({ data: [{ id: "gpt-4o" }] }));

		expect(models?.map(model => (model as { id: string }).id)).toEqual(["gpt-4o"]);
		expect(failures).toEqual([]);
	});

	/**
	 * An endpoint that answers with an EMPTY list is not a failure, and this is the distinction the whole
	 * change rests on: `[]` means "asked and told nothing", which must stay silent, while `null` means
	 * "could not ask" and must carry a reason.
	 */
	it("returns an empty list and reports no failure", async () => {
		const { models, failures } = await discover(async () => jsonResponse({ data: [] }));

		expect(models).toEqual([]);
		expect(failures).toEqual([]);
	});
});

describe("a request that never completes", () => {
	/**
	 * Connection refused, DNS failure, TLS failure, timeout. The reason names the URL that was attempted
	 * and carries the underlying message, which is what points an operator at their network rather than at
	 * their credentials.
	 */
	it("reports the request stage with the URL and the error", async () => {
		const { models, failures } = await discover(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:443");
		});

		expect(models).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("request");
		expect(failures[0]?.url).toBe("https://models.example.com/models");
		expect(failures[0]?.detail).toContain("ECONNREFUSED");
	});
});

describe("an endpoint that answers with an error status", () => {
	/**
	 * A 401 is the single most common real cause, and it is a CREDENTIAL problem, not a network one. The
	 * status has to appear in the reason or the operator cannot tell those apart.
	 */
	it("reports the status stage with the status line", async () => {
		const { models, failures } = await discover(async () => new Response("no", { status: 401 }));

		expect(models).toBeNull();
		expect(failures[0]?.stage).toBe("status");
		expect(failures[0]?.detail).toContain("401");
	});

	/** A 5xx is the same stage and must also carry its status, so the reason is never just "not ok". */
	it("reports a server error with its status", async () => {
		const { failures } = await discover(async () => new Response("boom", { status: 503 }));

		expect(failures[0]?.stage).toBe("status");
		expect(failures[0]?.detail).toContain("503");
	});
});

describe("a response whose body is not JSON", () => {
	/**
	 * An HTML error page or a proxy interstitial with a 200 status. Distinguished from the payload stage
	 * below because the fix differs: this one means something in front of the endpoint answered instead.
	 */
	it("reports the body stage", async () => {
		const { models, failures } = await discover(
			async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
		);

		expect(models).toBeNull();
		expect(failures[0]?.stage).toBe("body");
		expect(failures[0]?.detail).not.toBe("");
	});
});

describe("a response whose JSON holds no model list", () => {
	/**
	 * Valid JSON in a shape this reader does not understand. It must be a FAILURE and not an empty list,
	 * because "this endpoint is not OpenAI-compatible" and "this endpoint has no models" call for entirely
	 * different responses from whoever configured it.
	 */
	it("reports the payload stage rather than returning an empty list", async () => {
		const { models, failures } = await discover(async () => jsonResponse({ unexpected: "shape" }));

		expect(models).toBeNull();
		expect(failures[0]?.stage).toBe("payload");
		expect(failures[0]?.url).toBe("https://models.example.com/models");
	});
});

describe("a base URL that cannot be used", () => {
	/**
	 * Nothing is requested at all, so this is its own stage: the URL in the reason is the CONFIGURED value
	 * rather than a `/models` URL, which is what tells the operator to look at their config instead of the
	 * network.
	 */
	it("reports the base-url stage without attempting a request", async () => {
		let requests = 0;
		const { models, failures } = await discover(async () => {
			requests++;
			return jsonResponse({ data: [] });
		}, "   ");

		expect(models).toBeNull();
		expect(requests).toBe(0);
		expect(failures[0]?.stage).toBe("base-url");
	});
});

describe("how many times a failure is reported", () => {
	/**
	 * Once per discovery attempt. The caller is expected to put this into a per-provider state it shows to
	 * the user, so a single attempt reporting twice would look like two separate providers failing.
	 */
	it("reports exactly one reason per attempt", async () => {
		const { failures } = await discover(async () => new Response("no", { status: 500 }));

		expect(failures).toHaveLength(1);
	});

	/** And a caller that supplies no callback still gets the documented `null`, with nothing thrown. */
	it("works without a callback at all", async () => {
		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://models.example.com",
			fetch: (async () => new Response("no", { status: 500 })) as never,
		});

		expect(models).toBeNull();
	});
});
