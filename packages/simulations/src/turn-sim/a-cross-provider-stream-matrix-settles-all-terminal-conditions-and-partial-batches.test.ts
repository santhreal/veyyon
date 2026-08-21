/**
 * Cross-provider stream terminal condition matrix and partial tool batch emulation.
 *
 * WHY THIS SUITE EXISTS.
 * Provider streaming in `@veyyon/ai` routes each API family (`anthropic-messages`,
 * `openai-completions`, `openai-responses`, `google-generative-ai`, `ollama-chat`,
 * `bedrock-converse-stream`, `cursor-agent`, `devin-agent`) through production API option
 * mapping (`mapOptionsForApi`), lazy stream dispatchers, and watchdog wrappers
 * (`forwardStream` in `register-builtins.ts`).
 *
 * Previously, turn-sim only routed through `bedrock-converse-stream`. Provider
 * module override seams now let this suite exercise production API routing,
 * watchdog wrappers, and option projection across every built-in API backed by
 * a lazy provider module while replacing only the vendor SDK clients.
 *
 * WHAT THIS SUITE CLOSES:
 * - Exercises production API routing and lazy watchdog wrappers for every lazy
 *   provider API. The case table is exhaustive over `KnownApi` except GitLab Duo,
 *   whose workflow client is imported directly rather than through a lazy module.
 * - Drives `AgentSession` across terminal conditions (stop, toolUse, length,
 *   content-blocked, incomplete-stream, empty-body, envelope) through these distinct API families.
 * - Tests malformed and partial tool batches (single open call, head-valid/tail-truncated batch,
 *   invalid argument schema, server-side exec-resolved tool calls).
 * - Verifies transcript persistence roundtrip via `sim.reopen()`, ensuring serialized stores
 *   do not resurrect transient deaths or leave orphan placeholders.
 * - Asserts the core turn invariants (`turnViolations` and `pairingViolations` from `invariants.ts`):
 *   every call answered, no orphan results, unique call IDs, and no stuck latches.
 *
 * REMAINING GAP:
 * Module overrides replace provider SDK network clients; this suite exercises the production
 * routing, option mapping, lazy stream forwarding, watchdog budgets, and turn-loop integration,
 * but does not execute upstream vendor wire parsers or make live network requests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import type { KnownApi } from "@veyyon/catalog";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { type } from "arktype";
import { createSimulation, lastAssistantText, type Simulation, scriptTurns, simTool, toolResultTexts } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

interface TargetProviderCase {
	readonly name: string;
	readonly provider: string;
}

type SimulatedLazyApi = Exclude<KnownApi, "gitlab-duo-agent">;

const TARGET_PROVIDER_CASES = {
	"anthropic-messages": { name: "Anthropic Messages", provider: "anthropic" },
	"openai-completions": { name: "OpenAI Completions", provider: "openai" },
	"openai-responses": { name: "OpenAI Responses", provider: "openai" },
	openrouter: { name: "OpenRouter", provider: "openrouter" },
	"azure-openai-responses": { name: "Azure OpenAI Responses", provider: "azure" },
	"openai-codex-responses": { name: "OpenAI Codex Responses", provider: "openai-codex" },
	"google-generative-ai": { name: "Google Generative AI", provider: "google" },
	"google-gemini-cli": { name: "Google Gemini CLI", provider: "google-gemini-cli" },
	"google-vertex": { name: "Google Vertex", provider: "google-vertex" },
	"ollama-chat": { name: "Ollama Chat", provider: "ollama" },
	"bedrock-converse-stream": { name: "Amazon Bedrock", provider: "amazon-bedrock" },
	"cursor-agent": { name: "Cursor Agent", provider: "cursor" },
	"devin-agent": { name: "Devin Agent", provider: "devin" },
} as const satisfies Record<SimulatedLazyApi, TargetProviderCase>;

const TARGET_APIS = Object.keys(TARGET_PROVIDER_CASES) as SimulatedLazyApi[];

// ---------------------------------------------------------------------------
// 1. Cross-Provider API Routing & Watchdog Forwarding
// ---------------------------------------------------------------------------

describe("cross-provider API routing and lazy stream execution", () => {
	for (const api of TARGET_APIS) {
		const target = TARGET_PROVIDER_CASES[api];
		it(`drives text completion through production routing: ${target.name} (${api})`, async () => {
			sim = await createSimulation({
				model: { api, provider: target.provider },
				script: turn => {
					expect(turn.model.api).toBe(api);
					expect(turn.model.provider).toBe(target.provider);
					turn.text(`Answer from ${target.name}`);
					turn.finish("stop");
				},
			});

			await sim.session.prompt("say hello");

			expect(sim.session.isStreaming).toBe(false);
			expect(lastAssistantText(sim.session)).toBe(`Answer from ${target.name}`);
			const requests = sim.sessionRequests();
			expect(requests.length).toBe(1);
			expect(requests[0]?.provider).toBe(target.provider);

			const violations = turnViolations(sim);
			expect(describeViolations(`${api}-text`, violations)).toEqual([]);
		});

		it(`drives tool calling through production routing: ${target.name} (${api})`, async () => {
			let ranTool = false;
			sim = await createSimulation({
				model: { api, provider: target.provider },
				tools: [
					simTool(TOOL.read, async () => {
						ranTool = true;
						return { content: [{ type: "text", text: "file content" }] };
					}),
				],
				script: scriptTurns(
					turn => {
						turn.toolCall(TOOL.read, { path: "test.txt" }, "call-read-1");
						turn.finish("toolUse");
					},
					turn => {
						turn.text(`Read complete via ${target.name}.`);
						turn.finish("stop");
					},
				),
			});

			await sim.session.prompt("read the file");

			expect(ranTool).toBe(true);
			expect(sim.session.isStreaming).toBe(false);
			expect(lastAssistantText(sim.session)).toBe(`Read complete via ${target.name}.`);
			expect(toolResultTexts(sim.session)).toEqual(["file content"]);
			const violations = turnViolations(sim);
			expect(describeViolations(`${api}-tool-use`, violations)).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// 2. Provider Terminal Error & Transient Recovery Conditions
// ---------------------------------------------------------------------------

describe("cross-provider terminal and transient error conditions", () => {
	it("handles context/maxTokens length truncation without wedging the session", async () => {
		sim = await createSimulation({
			model: { api: "openai-completions", provider: "openai" },
			script: turn => {
				turn.text("Partial response cut off due to length");
				turn.finish("length");
			},
		});

		await sim.session.prompt("write a very long answer");

		expect(sim.session.isStreaming).toBe(false);
		const lastMsg = sim.session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("length");
		}
		const violations = turnViolations(sim);
		expect(describeViolations("length-truncation", violations)).toEqual([]);
	});

	it("handles content-blocked safety filters as terminal non-retryable failures on Google API", async () => {
		const contentBlockedError = new AIError.ProviderResponseError("blocked by provider safety filter", {
			provider: "google",
			kind: "content-blocked",
		});
		const errorId = AIError.classify(contentBlockedError);

		sim = await createSimulation({
			model: { api: "google-generative-ai", provider: "google" },
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			script: turn => {
				turn.fail(contentBlockedError.message, errorId);
			},
		});

		await sim.session.prompt("generate dangerous text");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests().length).toBe(1); // non-retryable, exactly 1 call
		const lastMsg = sim.session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("error");
			expect(lastMsg.errorMessage).toContain("safety filter");
		}
		const violations = turnViolations(sim);
		expect(describeViolations("content-blocked", violations)).toEqual([]);
	});

	it("retries transient incomplete-stream on Anthropic API and succeeds on replay", async () => {
		const incompleteError = new AIError.ProviderResponseError("stream closed before terminal finish reason", {
			provider: "anthropic",
			kind: "incomplete-stream",
		});
		const errorId = AIError.classify(incompleteError);

		sim = await createSimulation({
			model: { api: "anthropic-messages", provider: "anthropic" },
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			script: scriptTurns(
				turn => {
					turn.text("partial text before drop");
					turn.fail(incompleteError.message, errorId);
				},
				turn => {
					turn.text("recovered on retry via anthropic");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("send stream");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests().length).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("recovered on retry via anthropic");
		const violations = turnViolations(sim);
		expect(describeViolations("transient-incomplete-stream", violations)).toEqual([]);
	});

	it("retries transient empty-body failure on OpenAI responses API and succeeds on replay", async () => {
		const emptyBodyError = new AIError.ProviderResponseError("response body was empty", {
			provider: "openai",
			kind: "empty-body",
		});
		const errorId = AIError.classify(emptyBodyError);

		sim = await createSimulation({
			model: { api: "openai-responses", provider: "openai" },
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			script: scriptTurns(
				turn => {
					turn.fail(emptyBodyError.message, errorId);
				},
				turn => {
					turn.text("answered after empty body on openai-responses");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("execute command");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests().length).toBe(2);
		expect(lastAssistantText(sim.session)).toBe("answered after empty body on openai-responses");
		const violations = turnViolations(sim);
		expect(describeViolations("transient-empty-body", violations)).toEqual([]);
	});

	it("handles malformed envelope error as terminal non-retryable error on Ollama API", async () => {
		const envelopeError = new AIError.ProviderResponseError("malformed envelope ordering", {
			provider: "ollama",
			kind: "envelope",
		});
		const errorId = AIError.classify(envelopeError);

		sim = await createSimulation({
			model: { api: "ollama-chat", provider: "ollama" },
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			script: turn => {
				turn.fail(envelopeError.message, errorId);
			},
		});

		await sim.session.prompt("invoke prompt");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests().length).toBe(1);
		const lastMsg = sim.session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
		if (lastMsg?.role === "assistant") {
			expect(lastMsg.stopReason).toBe("error");
		}
		const violations = turnViolations(sim);
		expect(describeViolations("envelope-error", violations)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. Malformed & Partial Tool Batches Across Provider Archetypes
// ---------------------------------------------------------------------------

describe("malformed and partial tool batches across provider APIs", () => {
	it("retries when OpenAI completions ends with a tool call still open", async () => {
		const incompleteError = new AIError.ProviderResponseError("stream ended during tool arguments", {
			provider: "openai",
			kind: "incomplete-stream",
		});
		const errorId = AIError.classify(incompleteError);
		let toolRuns = 0;
		sim = await createSimulation({
			model: { api: "openai-completions", provider: "openai" },
			settings: { "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			tools: [
				simTool(TOOL.bash, async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "bash ok" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.openToolCall(TOOL.bash, '{"command":"echo \'half a comm');
					turn.fail(incompleteError.message, errorId);
				},
				turn => {
					turn.text("recovered from unclosed tool call");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("run the bash command");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests()).toHaveLength(2);
		expect(toolRuns).toBe(0);
		expect(lastAssistantText(sim.session)).toBe("recovered from unclosed tool call");
		const violations = turnViolations(sim);
		expect(describeViolations("unclosed-tool-call-delta", violations)).toEqual([]);
	});

	it("does not dispatch a head-valid, tail-truncated Anthropic batch before retry", async () => {
		const incompleteError = new AIError.ProviderResponseError("stream ended during the second tool call", {
			provider: "anthropic",
			kind: "incomplete-stream",
		});
		const errorId = AIError.classify(incompleteError);
		const ran: string[] = [];
		sim = await createSimulation({
			model: { api: "anthropic-messages", provider: "anthropic" },
			settings: { "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			tools: [
				simTool(TOOL.bash, async () => {
					ran.push("bash");
					return { content: [{ type: "text", text: "bash result" }] };
				}),
				simTool(TOOL.read, async () => {
					ran.push("read");
					return { content: [{ type: "text", text: "read result" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall(TOOL.bash, { command: "echo valid" }, "call-1");
					turn.openToolCall(TOOL.read, '{"path":"/var/log/', "call-2");
					turn.fail(incompleteError.message, errorId);
				},
				turn => {
					turn.text("handled batch completion");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("run multi-step operation");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.sessionRequests()).toHaveLength(2);
		expect(ran).toEqual([]);
		expect(lastAssistantText(sim.session)).toBe("handled batch completion");
		const pairing = pairingViolations(sim.session.messages);
		expect(describeViolations("head-valid-tail-truncated-batch", pairing)).toEqual([]);
		const violations = turnViolations(sim);
		expect(describeViolations("head-valid-tail-truncated-turn", violations)).toEqual([]);
	});

	it("rejects one schema-invalid call without blocking a valid Google API batch sibling", async () => {
		const ran: string[] = [];
		sim = await createSimulation({
			model: { api: "google-generative-ai", provider: "google" },
			settings: { "retry.enabled": false },
			tools: [
				simTool(TOOL.bash, async () => {
					ran.push("bash");
					return { content: [{ type: "text", text: "bash executed" }] };
				}),
				simTool(
					TOOL.read,
					async () => {
						ran.push("read");
						return { content: [{ type: "text", text: "read executed" }] };
					},
					{ parameters: type({ path: "string" }) },
				),
			],
			script: scriptTurns(
				turn => {
					turn.toolCall(TOOL.bash, { command: "echo ok" }, "call-valid");
					turn.toolCall(TOOL.read, { nonExistentField: 123 }, "call-schema-mismatch");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("loop continued after schema error");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("run batch with one malformed call");

		expect(sim.session.isStreaming).toBe(false);
		expect(ran).toEqual(["bash"]);
		const violations = turnViolations(sim);
		expect(describeViolations("malformed-args-in-batch", violations)).toEqual([]);
	});

	it("prevents blind replay on server-side exec-resolved tool batch failure on Cursor API", async () => {
		let editRuns = 0;
		let readRuns = 0;

		const incompleteError = new AIError.ProviderResponseError("stream disconnected mid-batch", {
			provider: "cursor",
			kind: "incomplete-stream",
		});
		const errorId = AIError.classify(incompleteError);

		sim = await createSimulation({
			model: { api: "cursor-agent", provider: "cursor" },
			settings: { "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			tools: [
				simTool(TOOL.edit, async () => {
					editRuns += 1;
					return { content: [{ type: "text", text: "edit completed" }] };
				}),
				simTool(TOOL.read, async () => {
					readRuns += 1;
					return { content: [{ type: "text", text: "read completed" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.execResolvedToolCall(TOOL.edit, { path: "main.ts" }, "call-exec-1");
					turn.toolCall(TOOL.read, { path: "main.ts" }, "call-read-2");
					turn.fail(incompleteError.message, errorId);
				},
				turn => {
					turn.text("finished after unreplayable batch error");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("run server-exec batch");

		expect(sim.session.isStreaming).toBe(false);
		expect(editRuns).toBe(0); // execResolved represents provider-dispatched execution
		expect(readRuns).toBe(0); // read was unexecuted in the dead turn, model continued with text
		expect(lastAssistantText(sim.session)).toBe("finished after unreplayable batch error");
	});
});

// ---------------------------------------------------------------------------
// 4. Persistence & Transcript Reopen Integrity Across Providers
// ---------------------------------------------------------------------------

describe("persistence and reopen integrity across cross-provider failures", () => {
	it("preserves exact invariants and pairings across reopen after transient error recovery on OpenAI completions", async () => {
		const incompleteError = new AIError.ProviderResponseError("transient reset", {
			provider: "openai",
			kind: "incomplete-stream",
		});
		const errorId = AIError.classify(incompleteError);

		sim = await createSimulation({
			model: { api: "openai-completions", provider: "openai" },
			persist: true,
			settings: { "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 2 },
			tools: [simTool(TOOL.bash, async () => ({ content: [{ type: "text", text: "bash output" }] }))],
			script: scriptTurns(
				turn => {
					turn.toolCall(TOOL.bash, { command: "uptime" }, "call-uptime-1");
					turn.fail(incompleteError.message, errorId);
				},
				turn => {
					turn.toolCall(TOOL.bash, { command: "uptime" }, "call-uptime-1");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("system uptime reported");
					turn.finish("stop");
				},
			),
		});

		await sim.session.prompt("check uptime");
		expect(sim.session.isStreaming).toBe(false);

		const beforeViolations = turnViolations(sim);
		expect(describeViolations("before-reopen", beforeViolations)).toEqual([]);

		// Reopen the stored transcript
		const reopened = await sim.reopen();
		try {
			expect(reopened.session.isStreaming).toBe(false);
			const afterPairing = pairingViolations(reopened.session.messages);
			expect(describeViolations("after-reopen-pairing", afterPairing)).toEqual([]);
			const afterViolations = turnViolations(reopened);
			expect(describeViolations("after-reopen-turn", afterViolations)).toEqual([]);
		} finally {
			await reopened.dispose();
		}
	});

	it("preserves exact invariants and placeholders across reopen after permanent terminal failure on Anthropic", async () => {
		const permanentError = new AIError.ProviderResponseError("fatal envelope breakdown", {
			provider: "anthropic",
			kind: "envelope",
		});
		const errorId = AIError.classify(permanentError);

		sim = await createSimulation({
			model: { api: "anthropic-messages", provider: "anthropic" },
			persist: true,
			settings: { "retry.enabled": false },
			tools: [simTool(TOOL.read, async () => ({ content: [{ type: "text", text: "content" }] }))],
			script: turn => {
				turn.toolCall(TOOL.read, { path: "config.json" }, "call-cfg-1");
				turn.fail(permanentError.message, errorId);
			},
		});

		await sim.session.prompt("read config");
		expect(sim.session.isStreaming).toBe(false);

		const beforeViolations = turnViolations(sim);
		expect(describeViolations("perm-fail-before-reopen", beforeViolations)).toEqual([]);

		const reopened = await sim.reopen();
		try {
			expect(reopened.session.isStreaming).toBe(false);
			const afterPairing = pairingViolations(reopened.session.messages);
			expect(describeViolations("perm-fail-after-reopen-pairing", afterPairing)).toEqual([]);
			const afterViolations = turnViolations(reopened);
			expect(describeViolations("perm-fail-after-reopen-turn", afterViolations)).toEqual([]);
		} finally {
			await reopened.dispose();
		}
	});
});
