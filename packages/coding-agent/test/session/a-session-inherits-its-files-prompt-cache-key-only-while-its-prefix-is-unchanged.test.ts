/**
 * WHY THIS SUITE EXISTS. `session/startup-identity.ts` decides two things a session is known by before
 * it sends anything: the provider prompt cache key its requests route on, and the id, display name and
 * kind it registers under. A wrong cache key is invisible: the request succeeds and pays an uncached
 * prefill of the whole transcript. A wrong agent id is the defect where a second top-level conversation
 * overwrote the first in the registry.
 *
 * THE CLASS. A key inherited across a change that alters the cached prefix (model, thinking level,
 * system prompt, tools), which routes requests to a shard holding a different prefix; a key dropped when
 * nothing changed, which cold-misses every turn; an explicit key that loses to the recorded one; and an
 * agent id that ignores the caller's id, the parent's task prefix, or the conversation it starts.
 *
 * WHAT IT DOES NOT CATCH. A new `CreateAgentSessionOptions` field that changes the prefix and is missing
 * from the inheritance check: the option set below is the one the function reads, not one derived from
 * the request a provider receives. `prompt-cache-key-survives-session-transitions.test.ts` asserts the key
 * a provider receives across branch, fork and side requests.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { MAIN_AGENT_ID, mainAgentIdFor } from "@veyyon/coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import { resolveAgentIdentity, resolveProviderPromptCache } from "@veyyon/coding-agent/session/startup-identity";

const RECORDED = "recorded-cache-key";

/** Each caller option that changes the cached prefix, set to a value the function must notice. */
const PREFIX_CHANGES: Record<string, CreateAgentSessionOptions> = {
	model: { model: createMockModel() },
	modelPattern: { modelPattern: "openai/*" },
	thinkingLevel: { thinkingLevel: ThinkingLevel.High },
	systemPrompt: { systemPrompt: ["You are terse."] },
	customSystemPrompt: { customSystemPrompt: "custom" },
	appendSystemPrompt: { appendSystemPrompt: "appended" },
	toolNames: { toolNames: ["read"] },
	customTools: { customTools: [] },
};

describe("the provider prompt cache key a session starts with", () => {
	it("inherits the key its file records while the caller changed nothing in the prefix", () => {
		expect(resolveProviderPromptCache({}, RECORDED)).toEqual({ key: RECORDED, source: "fork" });
	});

	it("has no key and no source when the file records none", () => {
		expect(resolveProviderPromptCache({}, undefined)).toEqual({ key: undefined, source: undefined });
	});

	for (const [option, options] of Object.entries(PREFIX_CHANGES)) {
		it(`drops the recorded key when the caller sets ${option}`, () => {
			expect(resolveProviderPromptCache(options, RECORDED)).toEqual({ key: undefined, source: undefined });
		});
	}

	it("uses an explicit key over the recorded one, sourced as explicit by default", () => {
		expect(resolveProviderPromptCache({ providerPromptCacheKey: "explicit-key" }, RECORDED)).toEqual({
			key: "explicit-key",
			source: "explicit",
		});
	});

	it("keeps the source the caller states for an explicit key, even across a prefix change", () => {
		expect(
			resolveProviderPromptCache(
				{
					providerPromptCacheKey: "parent-key",
					providerPromptCacheKeySource: "fork",
					thinkingLevel: ThinkingLevel.Low,
				},
				RECORDED,
			),
		).toEqual({ key: "parent-key", source: "fork" });
	});
});

describe("the identity a session registers under", () => {
	it("names a driving agent for the conversation it starts", () => {
		expect(resolveAgentIdentity({}, false, "conversation-1")).toEqual({
			id: mainAgentIdFor("conversation-1"),
			displayName: "main",
			kind: "main",
		});
		expect(mainAgentIdFor("conversation-1")).not.toBe(mainAgentIdFor("conversation-2"));
	});

	it("takes the bare main alias only while there is no conversation id", () => {
		expect(resolveAgentIdentity({}, false, undefined).id).toBe(MAIN_AGENT_ID);
	});

	it("never names a spawned agent for the conversation, and marks it a sub-agent", () => {
		expect(resolveAgentIdentity({}, true, "conversation-1")).toEqual({
			id: MAIN_AGENT_ID,
			displayName: "sub",
			kind: "sub",
		});
	});

	it("prefers the caller's id, then the parent's task prefix, over the derived id", () => {
		expect(resolveAgentIdentity({ agentId: "Explorer", parentTaskPrefix: "T1" }, true, "c").id).toBe("Explorer");
		expect(resolveAgentIdentity({ parentTaskPrefix: "T1" }, true, "c").id).toBe("T1");
	});

	it("uses the caller's display name when one is given", () => {
		expect(resolveAgentIdentity({ agentDisplayName: "Reviewer" }, true, undefined).displayName).toBe("Reviewer");
	});
});
