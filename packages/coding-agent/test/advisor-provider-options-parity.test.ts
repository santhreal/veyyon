/**
 * Contract: when the SDK supplies provider-shaping options to AgentSession,
 * the advisor `Agent` constructed by `#buildAdvisorRuntime` inherits them so
 * its OpenRouter/OpenAI requests cache and route like the main turn.
 *
 * Regression for can1357/oh-my-pi#3639: before the fix, the advisor was built
 * with only `sessionId`/`getApiKey`/telemetry — it dropped the session's
 * `streamFn` wrapper (so `providers.openrouterVariant` and `loopGuard` never
 * landed on advisor requests), its `promptCacheKey` (so OpenAI Responses
 * fell back to a different cache shard), its shared `providerSessionState`,
 * and its explicit websocket preference.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { Context, Model, SimpleStreamOptions } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** Provider-facing advisor session ids must be UUIDv7 (issue #5040): Codex writes
 *  them verbatim onto `conversation_id`/`session_id` headers, so `-advisor`
 *  labels stay local-only (telemetry, transcripts). */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("AgentSession advisor provider-options parity", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-advisor-parity-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	const settings = () =>
		Settings.isolated({
			"compaction.enabled": false,
			"providers.openrouterVariant": "floor",
			"model.loopGuard.enabled": true,
		});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-parity-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("inherits streamFn, promptCacheKey, and providerSessionState from the session", async () => {
		let forwardedModel: Model | undefined;
		let forwardedContext: Context | undefined;
		let forwardedOptions: SimpleStreamOptions | undefined;
		const advisorStreamFn: StreamFn = (requestModel, requestContext, requestOptions) => {
			forwardedModel = requestModel;
			forwardedContext = requestContext;
			forwardedOptions = requestOptions;
			throw new Error("advisor-stream-reached");
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Exercise the leased wrapper rather than comparing closure identity. The
		// wrapper must remain in place so it can lease the current secret runtime
		// for every attempt before forwarding to the SDK-supplied stream function.
		const requestContext: Context = { systemPrompt: ["Forwarded"], messages: [] };
		const requestOptions: SimpleStreamOptions = { sessionId: "forwarded-session" };
		await expect(advisor.streamFn(model, requestContext, requestOptions)).rejects.toThrow("advisor-stream-reached");
		expect(forwardedModel).toBe(model);
		expect(forwardedContext).toBe(requestContext);
		expect(forwardedOptions?.sessionId).toBe("forwarded-session");

		// Shared transport / fast-mode state map keeps Codex websockets and
		// Anthropic fast-mode fallbacks consistent across the two agents.
		expect(advisor.providerSessionState).toBe(session.providerSessionState);

		// The advisor's session identity is its own provider-facing UUIDv7
		// (issue #5040), distinct from the parent's. Without a pinned parent
		// `promptCacheKey` the advisor caches on that same UUID so consecutive
		// advisor turns stay on one OpenAI Responses shard.
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(mainAgent.sessionId);
		expect(advisor.promptCacheKey).toBe(advisor.sessionId);
	});

	it("captures the SDK-provided onPayload, onResponse, onSseEvent, and transformProviderContext on the advisor's stream call", async () => {
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const capturedStreamContexts: Context[] = [];
		const attemptOrder: string[] = [];
		const payloadInput = { kind: "advisor-payload" };
		const payloadOutput = { kind: "advisor-payload", sessionHook: true };
		const responseInput = { status: 207 };
		const sseInput = { event: "message", data: "advisor-sse", raw: ["data: advisor-sse"] };
		let wrappedPayloadResult: unknown;
		const captureStreamFn: StreamFn = async (requestModel, requestContext, opts) => {
			capturedStreamOptions.push(opts);
			capturedStreamContexts.push(requestContext);

			// This is the provider's real per-attempt seam. Resolving the function-
			// valued key activates the attempt-time secret runtime before the
			// provider constructs and sanitizes its outbound payload.
			if (typeof opts?.apiKey !== "function") {
				throw new Error("Expected advisor API key to be resolved per attempt");
			}
			await opts.apiKey({ lastChance: false, error: undefined });
			attemptOrder.push("apiKey");
			wrappedPayloadResult = await opts.onPayload?.(payloadInput, requestModel);
			attemptOrder.push("payload");
			await opts.onResponse?.(responseInput as never, requestModel);
			await opts.onSseEvent?.(sseInput, requestModel);

			// Stop after exercising the provider hooks; no network transport is
			// needed for this provider-options contract.
			throw new Error("capture-stop");
		};
		const payloadCalls: Array<{ payload: unknown; payloadModel: unknown }> = [];
		const responseCalls: Array<{ response: unknown; responseModel: unknown }> = [];
		const sseCalls: Array<{ event: unknown; eventModel: unknown }> = [];
		const transformInputs: Context[] = [];
		const onPayload = async (payload: unknown, payloadModel?: Model) => {
			payloadCalls.push({ payload, payloadModel });
			return payloadOutput;
		};
		const onResponse = async (response: unknown, responseModel: unknown) => {
			responseCalls.push({ response, responseModel });
		};
		const onSseEvent = (event: { data: string }, eventModel: unknown) => {
			sseCalls.push({ event, eventModel });
		};
		const transformProviderContext = async (context: Context): Promise<Context> => {
			transformInputs.push(context);
			return { ...context, systemPrompt: ["provider-context-transformed"] };
		};

		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
			onPayload,
			onResponse,
			onSseEvent,
			transformProviderContext,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("ping").catch(() => {});

		expect(capturedStreamOptions.length).toBeGreaterThan(0);
		const opts = capturedStreamOptions[0];
		if (!opts) throw new Error("Expected captured advisor stream options");

		expect(typeof opts.onPayload).toBe("function");
		expect(typeof opts.onResponse).toBe("function");
		expect(typeof opts.onSseEvent).toBe("function");

		// Verify values through the leased/sanitizing callbacks rather than
		// requiring those security wrappers to preserve callback identity.
		expect(attemptOrder).toEqual(["apiKey", "payload"]);
		expect(payloadCalls).toEqual([{ payload: payloadInput, payloadModel: model }]);
		expect(wrappedPayloadResult).toEqual(payloadOutput);
		expect(responseCalls).toEqual([{ response: responseInput, responseModel: model }]);
		expect(sseCalls).toEqual([{ event: sseInput, eventModel: model }]);
		expect(transformInputs).toHaveLength(1);
		expect(capturedStreamContexts[0]?.systemPrompt).toEqual(["provider-context-transformed"]);

		// Cache routing identity threaded through into the actual stream call.
		// Without a parent `providerPromptCacheKey`, the advisor's effective key
		// is its own provider-facing UUIDv7 session id (issue #5040).
		expect(opts.sessionId).toBe(advisor.sessionId);
		expect(opts.promptCacheKey).toBe(advisor.sessionId);
		expect(opts.providerSessionState).toBe(session.providerSessionState);
		expect(opts.preferWebsockets).toBe(true);
	});

	it("reuses the main agent's providerPromptCacheKey unchanged so tan/shared sessions stay on the parent shard", () => {
		// Regression for codex-connector review on #3640: when the SDK pins
		// `agent.promptCacheKey` (tan/shared-session callers do this to share
		// the parent provider cache while keeping a distinct providerSessionId),
		// the advisor MUST pass that key through unchanged or it cannot read the
		// exact shard populated by the parent turn.
		const parentPromptCacheKey = "tan-parent-cache-key";
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: parentPromptCacheKey,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Explicit provider cache keys are shared byte-for-byte with the parent
		// live turn; only the provider session id stays advisor-scoped.
		expect(advisor.promptCacheKey).toBe(parentPromptCacheKey);
		// Session id remains a distinct provider-facing UUIDv7 (issue #5040) so
		// credential stickiness and session-keyed telemetry stay distinct from
		// the parent.
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(advisor.promptCacheKey);
	});
});
