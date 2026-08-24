/**
 * The GitLab Duo setup chain is bounded as a whole, not per request.
 *
 * WHY THIS SUITE EXISTS. A Duo turn reaches its first assistant event only after
 * a chain of REST calls: enable the namespace settings, discover or resolve the
 * project, exchange a direct-access token, create the workflow, list the
 * available models. Each had a 30s deadline of its own and the chain had none,
 * and the whole chain runs twice when a cached namespace turns out stale — so a
 * server that accepted every connection and answered none held a turn open for
 * minutes while its `start` event sat in the transcript. Nothing downstream can
 * see that: there is no stream yet, and this provider has no lazy registration,
 * so the idle-iterator watchdog never wraps it.
 *
 * THE CLASS IT CLOSES. "A pre-first-event phase made of several requests is
 * bounded per request and unbounded as a phase." The sibling sweep
 * (`no-api-outlives-the-budget-its-caller-declared.test.ts`) stops at the FIRST
 * call of the chain, namespace discovery, because with no namespace configured
 * that is where a silent endpoint ends the turn. This suite pins the namespace
 * so discovery answers, and the stall lands on the setup calls behind it — the
 * ones a real operator with `GITLAB_DUO_NAMESPACE_ID` set would hit.
 *
 * WHAT IT DOES NOT CATCH. The WebSocket phase after setup succeeds (that is
 * `GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS`'s job, exercised by the socket suites),
 * and the wording of the surfaced error. One guard of the same family is beyond
 * it: the available-models GraphQL query runs only after `direct_access` and
 * workflow creation both succeed, which needs a live-server fixture rather than
 * a silent one, so its "an abort ends the phase" branch is written to the same
 * rule as its three siblings here and proved by none of these cases.
 */
import { describe, expect, it } from "bun:test";
import { stream } from "@veyyon/ai/stream";
import type { Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import type { CountingFetch } from "./helpers/silent-transport";

/** The caller's declared pre-first-event budget. */
const DECLARED_BUDGET_MS = 600;

/**
 * How long past the budget the turn may take to surface. The unguarded chain
 * spent 30s on its first setup call alone, so nothing that ignores the budget
 * fits here.
 */
const BOUND_MS = DECLARED_BUDGET_MS + 4_000;

const context: Context = { messages: [{ role: "user", content: "probe", timestamp: 1 }] };

function duoModel(baseUrl: string): Model<"gitlab-duo-agent"> {
	return buildModel({
		id: "claude_sonnet_4_6_vertex",
		name: "claude_sonnet_4_6_vertex",
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: null,
	});
}

/**
 * Requests that belong to namespace discovery rather than to the setup chain.
 *
 * Discovery is the group/project/GraphQL lookup the reader in `@veyyon/catalog`
 * performs to turn a configured namespace id into a selection; the chain under
 * test is everything the provider does afterwards (the settings PUT, project
 * discovery, `direct_access`, workflow create, model list). Answering the first
 * group immediately is what lets the stall land on the second phase — the
 * sibling sweep already covers a stall in the first.
 */
const DISCOVERY_URL = /\/api\/v4\/groups\/[^/]+$|\/api\/graphql$/;

interface ChainTransport extends CountingFetch {
	/** Requests that were NOT namespace discovery, i.e. the setup chain itself. */
	setupCalls: number;
}

/**
 * A transport that answers every request of the chain immediately except the one
 * `stallWhen` picks, which it accepts and never answers. `setupCalls` counts the
 * requests that were not namespace discovery, so a case can pin both that the
 * chain was entered and that it stopped dialing when its deadline fired.
 */
function fetchThatStallsAt(stallWhen: (url: string, method: string) => boolean): ChainTransport {
	const impl: ChainTransport = async (input, init) => {
		impl.calls += 1;
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? "GET";
		const discovery = method === "GET" && DISCOVERY_URL.test(url);
		if (!discovery) impl.setupCalls += 1;
		if (!stallWhen(url, method)) {
			// 404 for discovery is the reader's "no enrichment available", which
			// leaves the configured namespace id as the selection; `[]` for a list
			// endpoint is "nothing found", which is the shape each caller handles.
			return discovery ? new Response("{}", { status: 404 }) : new Response("[]", { status: 200 });
		}
		const stalled = Promise.withResolvers<Response>();
		// A real socket that accepts and says nothing. An already-aborted signal
		// rejects at once, exactly as `fetch` does, so a caller that keeps issuing
		// requests past its own deadline cannot look like a hang that isn't there.
		const abort = (): void => stalled.reject(new Error("aborted by caller"));
		if (init?.signal?.aborted) abort();
		else init?.signal?.addEventListener("abort", abort, { once: true });
		return stalled.promise;
	};
	impl.calls = 0;
	impl.setupCalls = 0;
	return impl;
}

interface ChainOutcome {
	setupCalls: number;
	elapsedMs: number;
	failed: boolean;
}

/**
 * `apiKey` is per case on purpose: the provider marks "settings already ensured"
 * in a process-wide map keyed by credential, base url and cwd, so two cases
 * sharing a key would see different chains and the exact request counts below
 * would depend on test order.
 */
async function runChainTurn(transport: ChainTransport, apiKey: string, projectId?: string): Promise<ChainOutcome> {
	const started = Date.now();
	const events = stream(duoModel("http://127.0.0.1:9"), context, {
		apiKey,
		fetch: transport,
		rootNamespaceId: "42",
		...(projectId ? { projectId } : {}),
		streamFirstEventTimeoutMs: DECLARED_BUDGET_MS,
		streamIdleTimeoutMs: DECLARED_BUDGET_MS,
	});
	let failed = false;
	try {
		for await (const event of events) failed = failed || event.type === "error";
		const message = await events.result();
		failed = failed || message.stopReason === "error" || message.stopReason === "aborted";
	} catch {
		failed = true;
	}
	return { setupCalls: transport.setupCalls, elapsedMs: Date.now() - started, failed };
}

describe("the GitLab Duo setup chain cannot outlive the declared budget", () => {
	it("ends the turn when the settings call goes silent", async () => {
		const transport = fetchThatStallsAt((_url, method) => method === "PUT");
		const outcome = await runChainTurn(transport, "probe-key-settings");

		// Exactly one setup request, which is two claims at once: the chain WAS
		// entered (a turn that died in discovery would show none, which is the
		// sibling sweep's case), and it stopped at the deadline instead of walking
		// the remaining calls against a signal that is already dead — each of those
		// used to be reported as "no project" / "no models" and the phase carried
		// on to open a socket it had no time left for.
		expect(outcome.setupCalls).toBe(1);
		expect(outcome.failed).toBe(true);
		expect(outcome.elapsedMs).toBeLessThan(BOUND_MS);
	}, 60_000);

	it("ends the turn when project auto-discovery goes silent", async () => {
		const transport = fetchThatStallsAt(url => url.includes("/projects?"));
		const outcome = await runChainTurn(transport, "probe-key-discovery");

		// The settings PUT answered, so the chain reached its second call and
		// stopped there: two setup requests, not the four that follow it. Project
		// discovery has two endpoints of its own and used to swallow a timeout on
		// each in turn, which is how a spent budget bought two more waits.
		expect(outcome.setupCalls).toBe(2);
		expect(outcome.failed).toBe(true);
		expect(outcome.elapsedMs).toBeLessThan(BOUND_MS);
	}, 60_000);

	it("ends the turn when the configured project's id lookup goes silent", async () => {
		// A configured project path skips auto-discovery and takes the numeric-id
		// lookup instead — the third of the chain's degrading helpers, and the one
		// whose fallback ("route by namespace only") reads most like success.
		const transport = fetchThatStallsAt(url => /\/api\/v4\/projects\/[^?]+$/.test(url));
		const outcome = await runChainTurn(transport, "probe-key-project-id", "group/project");

		expect(outcome.setupCalls).toBe(2);
		expect(outcome.failed).toBe(true);
		expect(outcome.elapsedMs).toBeLessThan(BOUND_MS);
	}, 60_000);
});
