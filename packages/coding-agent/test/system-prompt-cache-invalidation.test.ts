/**
 * Mid-session system-prompt changes must be recorded, with the reason.
 *
 * WHY THIS SUITE EXISTS. Changing the system prompt after a session has started
 * invalidates the provider's prefix cache, and the next request re-reads the
 * ENTIRE conversation as fresh input instead of at the cached rate. On a
 * measured 66-turn trace, five turns came back with `cacheRead: 0` while
 * resending 46-72k tokens each, roughly 8% of that session's bill, and nothing
 * in the transcript explained why. The invalidation was already being detected
 * in `refreshBaseSystemPrompt` (it clears the inherited provider cache key
 * right there) and simply never recorded, so every attempt to explain the
 * misses was guesswork.
 *
 * The contract these tests pin: a change is recorded with the caller's reason,
 * and a refresh that produces an identical prompt records nothing. The second
 * half matters as much as the first. A refresh that rebuilds the same bytes does
 * NOT invalidate the cache, so counting it would send the next investigation
 * after phantom misses.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { type } from "arktype";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

/**
 * A session whose prompt rebuild returns whatever the test currently wants,
 * which is the only way to drive the change/no-change branches directly.
 */
function makeSession(prompts: () => string[]): AgentSession {
	const readTool: AgentTool = {
		name: "read",
		label: "Read",
		description: "read tool",
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: "read executed" }] };
		},
	};
	const agent = new Agent({
		initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		toolRegistry: new Map<string, AgentTool>([[readTool.name, readTool]]),
		rebuildSystemPrompt: async () => ({ systemPrompt: prompts() }),
	});
	sessions.push(session);
	return session;
}

describe("system prompt cache invalidation is recorded", () => {
	/**
	 * A session that never changes its prompt is the cheap case: the provider
	 * serves the whole prefix from cache for the entire run. It must report no
	 * invalidations at all, so a clean session is distinguishable from an
	 * uninstrumented one.
	 */
	it("records nothing for a session that never refreshes", () => {
		const session = makeSession(() => ["base"]);
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	/**
	 * The expensive event, with the attribution that makes it actionable. Without
	 * the reason the record says only "something invalidated the cache five
	 * times", which is exactly the state that made the original misses
	 * unexplainable.
	 */
	it("records a change under the reason its caller gave", async () => {
		let current = ["base"];
		const session = makeSession(() => current);
		await session.refreshBaseSystemPrompt("first-build");
		current = ["base", "and more"];
		await session.refreshBaseSystemPrompt("argot-arm");
		expect(session.systemPromptInvalidations()).toContain("argot-arm");
	});

	/**
	 * A rebuild producing identical bytes does NOT invalidate the provider cache,
	 * so it must not be recorded. Recording it would inflate the count and send
	 * the next cost investigation chasing misses that never happened.
	 */
	it("records nothing when a refresh rebuilds an identical prompt", async () => {
		const session = makeSession(() => ["stable"]);
		await session.refreshBaseSystemPrompt("first-build");
		const afterFirst = session.systemPromptInvalidations().length;
		await session.refreshBaseSystemPrompt("no-op-refresh");
		await session.refreshBaseSystemPrompt("no-op-refresh");
		expect(session.systemPromptInvalidations().length).toBe(afterFirst);
	});

	/**
	 * Order and multiplicity are preserved, because the sequence is the evidence.
	 * Two invalidations from the same subsystem on consecutive turns is a
	 * different bug from one each from two subsystems, and the trace showed
	 * exactly that shape (turns 22 and 23 both missed).
	 */
	it("preserves every invalidation in order, including repeats", async () => {
		let n = 0;
		const session = makeSession(() => [`prompt-${n}`]);
		for (const reason of ["hindsight:recall", "hindsight:MM TTL reload", "hindsight:MM TTL reload"]) {
			n++;
			await session.refreshBaseSystemPrompt(reason);
		}
		expect(session.systemPromptInvalidations()).toEqual([
			"hindsight:recall",
			"hindsight:MM TTL reload",
			"hindsight:MM TTL reload",
		]);
	});

	/**
	 * The record is read-only to callers. Handing out the live array would let a
	 * reader mutate the session's cost evidence, and a bench that trimmed it
	 * while reporting would silently under-report invalidations.
	 */
	it("does not let a caller mutate the record", async () => {
		let n = 0;
		const session = makeSession(() => [`prompt-${n}`]);
		n++;
		await session.refreshBaseSystemPrompt("argot-arm");
		const record = session.systemPromptInvalidations();
		expect(() => (record as string[]).push("forged")).toThrow();
	});
});
