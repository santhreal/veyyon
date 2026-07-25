import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { resolveConfiguredModelPatterns, resolveModelOverride } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getBundledAgent } from "@veyyon/coding-agent/task/agents";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";

describe("bundled agent parsing", () => {
	/**
	 * The reviewer states no effort of its own, so an `:effort` suffix on whichever
	 * model the operator gave its subagents survives all the way to the request.
	 * A level here would silently outrank that suffix (see
	 * `resolveEffectiveSubagentThinkingLevel`).
	 */
	it("lets reviewer inherit thinking effort from the resolved subagent model", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.thinkingLevel).toBeUndefined();
	});

	/**
	 * No bundled agent pins a model.
	 *
	 * They used to: `task` carried `@task`, `scout`/`sonic` carried `@smol`,
	 * `reviewer` carried `@slow`, `designer` carried `@designer`. Those aliases
	 * resolved through role expansion before any subagent model setting was
	 * consulted, so a stock install fanned its subagents across several different
	 * models and changing the subagent model appeared to do nothing. The models now
	 * come from the Subagents settings area, which inherits the session model when
	 * unset — so a definition that names a model here is a regression of that bug.
	 * A thinking level is still fine: it is not a model choice.
	 */
	it("ships no model on any bundled agent, so the subagent settings decide", () => {
		const task = getBundledAgent("task");
		expect(task).toBeDefined();
		expect(task?.model).toBeUndefined();
		expect(task?.thinkingLevel).toBe(AUTO_THINKING);

		for (const name of ["scout", "reviewer", "designer", "librarian", "sonic"]) {
			expect(getBundledAgent(name)?.model, `${name} must not pin a model`).toBeUndefined();
		}
	});

	// Issue #4761: with `modelRoles.slow: ...:xhigh`, the role's explicit effort
	// suffix must survive agent-pattern expansion and model resolution for the
	// bundled agents routed at that role. The executor prefers an explicit
	// resolved suffix over the agent-definition default (task/executor.ts), so
	// the resolved level below is what the subagent runs at.
	it("resolves the configured slow-role effort suffix for reviewer", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({
			modelRoles: { slow: "openai-codex/gpt-5.5:xhigh" },
		});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		const agent = getBundledAgent("reviewer");
		expect(agent?.thinkingLevel).toBeUndefined();
		// The operator's subagent model is what a bundled specialist runs now, so the
		// role's `:xhigh` suffix has to survive expansion of THAT value. The bundled
		// definitions carry no `model:` of their own; see the test below.
		const patterns = resolveConfiguredModelPatterns("@slow", settings);
		const resolved = resolveModelOverride(patterns, registry, settings);
		expect(resolved.model?.provider).toBe("openai-codex");
		expect(resolved.model?.id).toBe("gpt-5.5");
		expect(resolved.thinkingLevel).toBe(Effort.XHigh);
		expect(resolved.explicitThinkingLevel).toBe(true);
	});
});
