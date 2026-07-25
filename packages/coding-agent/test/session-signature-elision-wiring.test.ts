/**
 * The wiring test for both thought-signature settings.
 *
 * WHY THIS SUITE EXISTS. `packages/ai` proves that `convertMessages` honours a
 * retention window and a size limit, and that suite is thorough. It proves
 * nothing about whether either setting ever REACHES `convertMessages` in a real
 * session, and that is the failure with no symptom: the setting appears in
 * `/settings`, `veyyon config set` accepts it, the docs describe it, and every
 * request goes out unchanged. Nothing fails, and the only evidence is a bill that
 * did not move.
 *
 * The path under test is `AgentSession`'s `transformProviderContext` hook, which
 * is the single point where session settings become request shape. These
 * assertions run the hook the session actually installs, feed it a transcript,
 * and check the payload a provider would receive. A change that reads the wrong
 * settings key, or drops the field while spreading the context, fails here.
 *
 * The byte counter is asserted against the same payload rather than against a
 * hand-computed constant. It is what the context panel shows an operator, and a
 * counter that agrees with arithmetic while disagreeing with the request is worse
 * than no counter: it reports a saving that was never made.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, Context, Message, Model, UserMessage } from "@veyyon/ai";
import { convertMessages } from "@veyyon/ai/providers/google-shared";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const SKIP = "skip_thought_signature_validator";

/** Valid base64: `resolveThoughtSignature` rejects anything else before either rule is consulted. */
function signature(quads: number): string {
	return "Zm9v".repeat(quads);
}

const SMALL = signature(10); // 40 characters
const LARGE = signature(1000); // 4000 characters

describe("AgentSession wires the signature settings into the request", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-signature-wiring-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	/** A Gemini 3 model from the bundled registry, since the sentinel is only substituted there. */
	function gemini3(): Model {
		const model = modelRegistry.getAll().find(candidate => candidate.id.startsWith("gemini-3"));
		if (!model) throw new Error("Expected a bundled gemini-3 model");
		return model;
	}

	function assistantWithSignature(model: Model, id: string, sig: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` }, thoughtSignature: sig }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as AssistantMessage;
	}

	/**
	 * Build a session on the given settings and hand back the transform it
	 * installed, along with the transcript it will be run against.
	 *
	 * The transform is captured by intercepting `setTransformProviderContext` on the
	 * agent, which is how the session publishes it. Reaching for the private field
	 * instead would let the test pass while the session never installed the hook at
	 * all, which is one of the two failures this suite exists to catch.
	 */
	async function transformFor(settings: Record<string, unknown>): Promise<{
		transform: (context: Context, model: Model) => Context | Promise<Context>;
		model: Model;
		messages: Message[];
		agentSession: AgentSession;
	}> {
		const model = gemini3();
		const user: UserMessage = { role: "user", content: "go", timestamp: Date.now() };
		const messages: Message[] = [
			user,
			assistantWithSignature(model, "a", LARGE),
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
			assistantWithSignature(model, "b", SMALL),
			{ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "ok" }] } as Message,
			assistantWithSignature(model, "c", LARGE),
		];
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [user] } });
		let captured: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
		const install = agent.setTransformProviderContext.bind(agent);
		agent.setTransformProviderContext = fn => {
			captured = fn ?? undefined;
			install(fn);
		};
		const agentSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
			modelRegistry,
		});
		session = agentSession;
		if (!captured) throw new Error("AgentSession installed no transformProviderContext hook");
		return { transform: captured, model, messages, agentSession };
	}

	/** Every `functionCall` part's signature in wire order, `undefined` when the key is absent. */
	function emitted(context: Context, model: Model): (string | undefined)[] {
		return convertMessages(model as never, context as never)
			.flatMap(content => content.parts ?? [])
			.filter(part => part.functionCall)
			.map(part => part.thoughtSignature);
	}

	/**
	 * THE DEFAULT, which matters most. A stock install must send every signature
	 * exactly as it did before either setting existed. If this ever fails, every
	 * user silently lost reasoning context to a knob they never touched.
	 */
	it("changes nothing on a stock install", async () => {
		const { transform, model, messages } = await transformFor({});
		const context = await transform({ messages }, model);
		expect(context.thoughtSignatureMaxLength).toBe(-1);
		expect(context.thoughtSignatureRetention).toBe(-1);
		expect(emitted(context, model)).toEqual([LARGE, SMALL, LARGE]);
	});

	/**
	 * THE SIZE LEVER, end to end. The setting is read from the session's settings,
	 * survives onto the context, and the payload a provider would receive carries
	 * the sentinel where the large signatures were. Each intermediate step is
	 * asserted, so a break says which link failed rather than only that the bytes
	 * did not move.
	 */
	it("carries a size limit from settings through to the payload", async () => {
		const { transform, model, messages } = await transformFor({ "context.thoughtSignatureMaxLength": 100 });
		const context = await transform({ messages }, model);
		expect(context.thoughtSignatureMaxLength).toBe(100);
		expect(emitted(context, model)).toEqual([SKIP, SMALL, SKIP]);
	});

	/**
	 * THE RECENCY LEVER, end to end, and the twin that proves the two settings are
	 * read separately. If the session read one key for both, this and the case above
	 * would produce the same payload, and they must not: a window keeps the newest
	 * signature whatever its size, a cap drops it whatever its age.
	 */
	it("carries a retention window through to the payload, selecting differently", async () => {
		const { transform, model, messages } = await transformFor({ "context.thoughtSignatureRetention": 1 });
		const context = await transform({ messages }, model);
		expect(context.thoughtSignatureRetention).toBe(1);
		expect(emitted(context, model)).toEqual([SKIP, SKIP, LARGE]);
	});

	/**
	 * Both at once intersect. A signature survives only if it is recent enough AND
	 * small enough, so the newest one still goes because the cap is generous, while
	 * the older small one is dropped for age. Setting both must not make one win
	 * outright, which is the shape a careless refactor produces.
	 */
	it("intersects the two rules rather than letting one win", async () => {
		const { transform, model, messages } = await transformFor({
			"context.thoughtSignatureRetention": 1,
			"context.thoughtSignatureMaxLength": 8000,
		});
		const context = await transform({ messages }, model);
		expect(emitted(context, model)).toEqual([SKIP, SKIP, LARGE]);
	});

	/**
	 * The counter the context panel shows must equal the bytes the request actually
	 * dropped. Asserting it against the payload rather than against a constant is
	 * the point: a counter that is internally consistent but disagrees with the wire
	 * tells an operator a saving happened that did not.
	 */
	it("reports elided bytes that match the payload it produced", async () => {
		const { transform, model, messages, agentSession } = await transformFor({
			"context.thoughtSignatureMaxLength": 100,
		});
		expect(agentSession.thoughtSignatureBytesSaved).toBe(0);
		const context = await transform({ messages }, model);
		const full = JSON.stringify(convertMessages(model as never, { messages } as never));
		const capped = JSON.stringify(convertMessages(model as never, context as never));
		expect(agentSession.thoughtSignatureBytesSaved).toBe(2 * (LARGE.length - SKIP.length));
		expect(full.length - capped.length).toBe(agentSession.thoughtSignatureBytesSaved);
	});

	/**
	 * The counter accumulates across requests, because the same historical signature
	 * is elided again on every turn and that repetition IS the saving. A counter
	 * that reported only the newest request would understate a long session by the
	 * number of turns in it, which is the whole quantity being optimised.
	 */
	it("accumulates the saving across requests rather than reporting only the latest", async () => {
		const { transform, model, messages, agentSession } = await transformFor({
			"context.thoughtSignatureMaxLength": 100,
		});
		await transform({ messages }, model);
		const afterOne = agentSession.thoughtSignatureBytesSaved;
		await transform({ messages }, model);
		expect(agentSession.thoughtSignatureBytesSaved).toBe(afterOne * 2);
	});

	/**
	 * A signature from a different model is dropped before either rule is consulted,
	 * so neither rule saved those bytes and the counter must not claim them.
	 * Over-claiming here would make an unrelated model switch look like the setting
	 * working.
	 */
	it("does not claim bytes from another model's signatures", async () => {
		const { transform, model, agentSession } = await transformFor({ "context.thoughtSignatureMaxLength": 100 });
		const foreign = { ...assistantWithSignature(model, "x", LARGE), model: "some-other-model" } as AssistantMessage;
		await transform({ messages: [{ role: "user", content: "go" } as Message, foreign] }, model);
		expect(agentSession.thoughtSignatureBytesSaved).toBe(0);
	});
});
