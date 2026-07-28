import { describe, expect, test } from "bun:test";
import { generateBranchSummary, type SessionEntry } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Model, Usage } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { buildModel } from "@veyyon/catalog/build";

const RAW_MARKER = "BOUNDARY_SECRET_7429";
const RAW_MARKER_FRAGMENT = RAW_MARKER.slice(0, 3);
const RAW_FILE = `src/${RAW_MARKER}.ts`;

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text = "summary"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function branchEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: `inspect ${RAW_MARKER}`, timestamp: 0 },
		},
		{
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date(1).toISOString(),
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-read",
						name: "read",
						arguments: { path: `${RAW_FILE}:1-2`, [RAW_MARKER]: RAW_MARKER },
					},
				],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "tool-1",
			parentId: "assistant-1",
			timestamp: new Date(2).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				// The marker straddles the 2,000-character summary cutoff. Sanitizing
				// after truncation would leave its raw prefix in the provider prompt.
				content: [{ type: "text", text: `${"x".repeat(1997)}${RAW_MARKER}:tail` }],
				isError: false,
				timestamp: 2,
			},
		},
	];
}

function contextText(context: Context): string {
	return JSON.stringify(context);
}
function nestedPayload(depth: number): unknown {
	let payload: unknown = RAW_MARKER;
	for (let level = 0; level < depth; level += 1) payload = { nested: payload };
	return payload;
}

describe("branch summary provider boundary", () => {
	/**
	 * Regression: branch preparation used to truncate raw tool output before
	 * secrets spanning the cutoff were replaced, and static keys had no live
	 * attempt seam at which to rebuild the provider request.
	 */
	test("static credentials rebuild raw entries before truncation and sanitize the final shaped payload", async () => {
		const replacement = "#S#";
		let resolveCalls = 0;
		let capturedContext = "";
		let capturedPayload = "";

		const result = await generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			customInstructions: `Keep ${RAW_MARKER} private`,
			resolveObfuscateProviderText: () => {
				resolveCalls += 1;
				return text => text.replaceAll(RAW_MARKER, replacement);
			},
			onPayload: payload => {
				const mutable = payload as Record<string, unknown>;
				mutable[`${RAW_MARKER}-late-key`] = `${RAW_MARKER}-late-value`;
			},
			completeImpl: async (model, context, options) => {
				capturedContext = contextText(context);
				const shapedPayload = { [RAW_MARKER]: RAW_MARKER, context: capturedContext };
				capturedPayload = JSON.stringify(await options.onPayload?.(shapedPayload, model));
				return assistant();
			},
		});

		expect(resolveCalls).toBe(1);
		expect(capturedContext).toContain(replacement);
		expect(capturedContext).not.toContain(RAW_MARKER);
		expect(capturedContext).not.toContain(RAW_MARKER_FRAGMENT);
		expect(capturedPayload).toContain(replacement);
		expect(capturedPayload).not.toContain(RAW_MARKER);
		expect(capturedPayload).not.toContain(RAW_MARKER_FRAGMENT);
		expect(result.readFiles).toEqual([RAW_FILE]);
	});

	/**
	 * Regression: credential refresh can replace the active secret runtime, but
	 * retry attempts previously reused the lossy Context built for the first key.
	 */
	test("resolver auth retry rebuilds every Context from raw entries with the post-resolution transform", async () => {
		const initialReplacement = "#A#";
		const retryReplacement = "#B#";
		let currentTransform = (text: string): string => text;
		let transformResolutions = 0;
		const resolverCalls: Array<{ hasError: boolean; lastChance: boolean }> = [];
		const captures: Array<{ context: string; payload: string }> = [];

		await generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: resolveContext => {
				resolverCalls.push({ hasError: resolveContext.error !== undefined, lastChance: resolveContext.lastChance });
				const replacement = resolverCalls.length === 1 ? initialReplacement : retryReplacement;
				currentTransform = text => text.replaceAll(RAW_MARKER, replacement);
				return `attempt-key-${resolverCalls.length}`;
			},
			signal: new AbortController().signal,
			customInstructions: `Retry instruction ${RAW_MARKER}`,
			resolveObfuscateProviderText: () => {
				transformResolutions += 1;
				return currentTransform;
			},
			onPayload: payload => {
				const mutable = payload as Record<string, unknown>;
				mutable[`${RAW_MARKER}-late-key`] = `${RAW_MARKER}-late-value`;
			},
			completeImpl: async (model, context, options) =>
				withAuth(
					options.apiKey,
					async () => {
						const contextCapture = contextText(context);
						const shapedPayload = { [RAW_MARKER]: RAW_MARKER, context: contextCapture };
						const payloadCapture = JSON.stringify(await options.onPayload?.(shapedPayload, model));
						captures.push({ context: contextCapture, payload: payloadCapture });
						if (captures.length === 1) throw new Error("simulated auth failure");
						return assistant();
					},
					{ isAuthError: () => true, signal: options.signal },
				),
		});

		expect(resolverCalls).toEqual([
			{ hasError: false, lastChance: false },
			{ hasError: true, lastChance: false },
		]);
		expect(transformResolutions).toBe(2);
		expect(captures).toHaveLength(2);

		for (const [capture, currentReplacement, staleReplacement] of [
			[captures[0], initialReplacement, retryReplacement],
			[captures[1], retryReplacement, initialReplacement],
		] as const) {
			expect(capture.context).toContain(currentReplacement);
			expect(capture.context).not.toContain(staleReplacement);
			expect(capture.context).not.toContain(RAW_MARKER);
			expect(capture.context).not.toContain(RAW_MARKER_FRAGMENT);
			expect(capture.payload).toContain(currentReplacement);
			expect(capture.payload).not.toContain(staleReplacement);
			expect(capture.payload).not.toContain(RAW_MARKER);
			expect(capture.payload).not.toContain(RAW_MARKER_FRAGMENT);
		}
	});

	/**
	 * Regression: introducing an attempt-time builder must not turn the existing
	 * empty-branch fast path into credential/runtime resolution or a dispatch.
	 */
	test("empty branches do not resolve credentials or provider transforms", async () => {
		let credentialResolutions = 0;
		let transformResolutions = 0;
		let dispatches = 0;
		const result = await generateBranchSummary([], {
			model: MODEL,
			apiKey: () => {
				credentialResolutions += 1;
				return "unused-key";
			},
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => {
				transformResolutions += 1;
				return text => text;
			},
			completeImpl: async () => {
				dispatches += 1;
				return assistant();
			},
		});

		expect(result).toEqual({ summary: "No content to summarize" });
		expect({ credentialResolutions, transformResolutions, dispatches }).toEqual({
			credentialResolutions: 0,
			transformResolutions: 0,
			dispatches: 0,
		});
	});

	/**
	 * Regression: thrown runtime transforms could either leak their secret-bearing
	 * cause or allow a request to continue with unsanitized provider text.
	 */
	test("transform failures stop static and resolver-backed requests without exposing credentials", async () => {
		let staticDispatches = 0;
		const staticRequest = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-credential-should-not-escape",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => {
				throw new Error(`failed for ${RAW_MARKER} using static-credential-should-not-escape`);
			},
			completeImpl: async () => {
				staticDispatches += 1;
				return assistant();
			},
		});
		const staticError = await staticRequest.catch((error: unknown) => error);
		expect(staticError).toBeInstanceOf(Error);
		expect((staticError as Error).message).toBe("Branch summary provider text transformation failed.");
		expect((staticError as Error).message).not.toContain(RAW_MARKER);
		expect((staticError as Error).message).not.toContain("static-credential");
		expect(staticDispatches).toBe(0);

		let resolverDispatches = 0;
		let transformCalls = 0;
		const resolverRequest = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: () => "resolver-credential-should-not-escape",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => {
				transformCalls += 1;
				throw new Error(`failed for ${RAW_MARKER} using resolver-credential-should-not-escape`);
			},
			completeImpl: async (_model, _context, options) =>
				withAuth(
					options.apiKey,
					async () => {
						resolverDispatches += 1;
						return assistant();
					},
					{ signal: options.signal },
				),
		});
		const resolverError = await resolverRequest.catch((error: unknown) => error);
		expect(resolverError).toBeInstanceOf(Error);
		expect((resolverError as Error).message).not.toContain(RAW_MARKER);
		expect((resolverError as Error).message).not.toContain("resolver-credential");
		expect(transformCalls).toBe(1);
		expect(resolverDispatches).toBe(0);
	});

	/**
	 * Regression: wrapping the ApiKeyResolver must preserve a declined resolution
	 * as a missing-key outcome without resolving a transform or sending a request.
	 */
	test("a resolver that declines a credential does not resolve a transform or dispatch", async () => {
		let transformResolutions = 0;
		let dispatches = 0;
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: () => undefined,
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => {
				transformResolutions += 1;
				return text => text;
			},
			completeImpl: async (_model, _context, options) =>
				withAuth(
					options.apiKey,
					async () => {
						dispatches += 1;
						return assistant();
					},
					{ signal: options.signal },
				),
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect(transformResolutions).toBe(0);
		expect(dispatches).toBe(0);
	});
	/**
	 * Regression: a shared object is a valid acyclic provider payload; a global
	 * visited set would misclassify its second reference as a cycle. Binary views
	 * have no string surface and must pass through deliberately without cloning.
	 */
	test("accepts shared DAG payloads and deliberately preserves binary views", async () => {
		const replacement = "#DAG#";
		let transformedPayload: Record<string, unknown> | undefined;
		const binary = new Uint8Array([1, 2, 3]);

		await generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, replacement),
			completeImpl: async (model, _context, options) => {
				const shared = { [RAW_MARKER]: RAW_MARKER };
				transformedPayload = (await options.onPayload?.({ left: shared, right: shared, binary }, model)) as Record<
					string,
					unknown
				>;
				return assistant();
			},
		});

		expect(transformedPayload).toBeDefined();
		const payload = transformedPayload as Record<string, unknown>;
		const payloadText = JSON.stringify(payload);
		expect(payloadText).toContain(replacement);
		expect(payloadText).not.toContain(RAW_MARKER);
		expect((payload.left as Record<string, unknown>)[replacement]).toBe(replacement);
		expect((payload.right as Record<string, unknown>)[replacement]).toBe(replacement);
		expect(payload.binary).toBe(binary);
	});

	/**
	 * Regression: recursive payloads could drive an unbounded walk (or overflow
	 * the stack) instead of failing closed before the provider wire call.
	 */
	test("rejects cyclic provider payloads with the fixed credential-free error", async () => {
		let reachedWire = false;
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, "#CYCLE#"),
			completeImpl: async (model, _context, options) => {
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				await options.onPayload?.(cyclic, model);
				reachedWire = true;
				return assistant();
			},
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Branch summary provider text transformation failed.");
		expect(reachedWire).toBe(false);
	});

	/**
	 * Regression: two distinct provider keys can collapse to one redacted key;
	 * forwarding that object would silently overwrite a tool argument.
	 */
	test("rejects transformed key collisions with the fixed error", async () => {
		const replacement = "#COLLISION#";
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, replacement),
			completeImpl: async (model, _context, options) => {
				await options.onPayload?.({ [RAW_MARKER]: 1, [replacement]: 2 }, model);
				return assistant();
			},
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Branch summary provider text transformation failed.");
	});

	/**
	 * Regression: a defensive depth bound must be inclusive and stable; rejecting
	 * the documented boundary would break deeply nested but valid JSON payloads.
	 */
	test("transforms provider payloads exactly at the depth boundary", async () => {
		let payloadText = "";
		await generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, "#DEPTH#"),
			completeImpl: async (model, _context, options) => {
				payloadText = JSON.stringify(await options.onPayload?.(nestedPayload(64), model));
				return assistant();
			},
		});

		expect(payloadText).toContain("#DEPTH#");
		expect(payloadText).not.toContain(RAW_MARKER);
	});

	/**
	 * Regression: provider-controlled nesting beyond the traversal boundary could
	 * consume unbounded stack/work unless rejected before the wire call.
	 */
	test("rejects provider payloads beyond the depth boundary", async () => {
		let reachedWire = false;
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, "#DEPTH#"),
			completeImpl: async (model, _context, options) => {
				await options.onPayload?.(nestedPayload(65), model);
				reachedWire = true;
				return assistant();
			},
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Branch summary provider text transformation failed.");
		expect(reachedWire).toBe(false);
	});

	/**
	 * Regression: silently flattening class instances can corrupt provider
	 * semantics, so non-plain objects are explicitly rejected while binary views
	 * remain the only intentional pass-through above.
	 */
	test("rejects non-plain provider payload values", async () => {
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, "#PLAIN#"),
			completeImpl: async (model, _context, options) => {
				await options.onPayload?.({ createdAt: new Date(0) }, model);
				return assistant();
			},
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Branch summary provider text transformation failed.");
	});
	/**
	 * Regression: reflection traps on provider-controlled proxy values can throw
	 * secret-bearing errors; the boundary must collapse those failures too.
	 */
	test("normalizes provider reflection failures to the fixed error", async () => {
		const hostilePayload = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error(`proxy exposed ${RAW_MARKER}`);
				},
			},
		);
		const request = generateBranchSummary(branchEntries(), {
			model: MODEL,
			apiKey: "static-key",
			signal: new AbortController().signal,
			resolveObfuscateProviderText: () => text => text.replaceAll(RAW_MARKER, "#PROXY#"),
			completeImpl: async (model, _context, options) => {
				await options.onPayload?.(hostilePayload, model);
				return assistant();
			},
		});
		const error = await request.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Branch summary provider text transformation failed.");
		expect((error as Error).message).not.toContain(RAW_MARKER);
	});
});
