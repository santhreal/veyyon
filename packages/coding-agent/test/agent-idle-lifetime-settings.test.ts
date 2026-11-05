import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { DEFAULT_AGENT_IDLE_TTL_MS } from "@veyyon/coding-agent/config/settings-domains/agents";
import { resolveAgentIdleTtlMs } from "@veyyon/coding-agent/task/agent-settings";

describe("agent idle lifetime settings", () => {
	/**
	 * A fresh install must use one predictable lifecycle budget, regardless of
	 * which provider or model the agent ran.
	 */
	it("defaults every idle agent to five minutes", () => {
		const settings = Settings.isolated();

		expect(settings.get("agent.idleTtlMs")).toBe(DEFAULT_AGENT_IDLE_TTL_MS);
		expect(settings.isConfigured("agent.idleTtlMs")).toBe(false);
		expect(resolveAgentIdleTtlMs(settings)).toBe(5 * 60_000);
	});

	/** A positive override must replace the five-minute lifecycle budget exactly. */
	it("preserves an explicit positive idle TTL override", () => {
		const settings = Settings.isolated({ "agent.idleTtlMs": 12_345 });

		expect(settings.get("agent.idleTtlMs")).toBe(12_345);
		expect(settings.isConfigured("agent.idleTtlMs")).toBe(true);
		expect(resolveAgentIdleTtlMs(settings)).toBe(12_345);
	});

	/** Zero is an intentional keep-live policy, not another spelling for the default. */
	it("preserves an explicit zero idle TTL override", () => {
		const settings = Settings.isolated({ "agent.idleTtlMs": 0 });

		expect(settings.get("agent.idleTtlMs")).toBe(0);
		expect(settings.isConfigured("agent.idleTtlMs")).toBe(true);
		expect(resolveAgentIdleTtlMs(settings)).toBe(0);
	});
});
