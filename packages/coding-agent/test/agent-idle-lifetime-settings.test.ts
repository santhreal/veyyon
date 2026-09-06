import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	DEFAULT_AGENT_IDLE_TTL_MS,
	DEFAULT_AGENT_PRUNE_MS,
	DEFAULT_AGENT_WAITING_PRUNE_MS,
} from "@veyyon/coding-agent/config/settings-domains/agents";
import { resolveAgentIdleTtlMs, resolveAgentPruneBudget } from "@veyyon/coding-agent/task/agent-settings";

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

/**
 * How the three prune settings become the two budgets the lifecycle manager
 * reads.
 *
 * WHY THIS EXISTS. The resolver is where an operator's intent either survives or
 * quietly turns into something else, and the something else is expensive in both
 * directions: a budget that fails open leaves every finished agent in the roster,
 * and a budget that fails pruned drops peers while they are still needed. So the off
 * switch, the defaults, and the relationship between the two budgets are each pinned
 * rather than assumed from the schema.
 */
describe("agent prune budget settings", () => {
	/** A fresh install prunes quiet agents after an hour and waiting ones after two. */
	it("defaults to a one-hour quiet prune and a two-hour waiting prune", () => {
		const settings = Settings.isolated();

		expect(resolveAgentPruneBudget(settings)).toEqual({
			afterMs: DEFAULT_AGENT_PRUNE_MS,
			waitingAfterMs: DEFAULT_AGENT_WAITING_PRUNE_MS,
		});
		expect(DEFAULT_AGENT_PRUNE_MS).toBe(60 * 60_000);
		expect(DEFAULT_AGENT_WAITING_PRUNE_MS).toBe(120 * 60_000);
	});

	/**
	 * The off switch must resolve to zero, which the manager reads as "never prune".
	 * Resolving to a large number instead would still eventually drop refs, which is
	 * exactly what an operator who turned the feature off did not ask for.
	 */
	it("resolves to zero budgets when disabled", () => {
		const settings = Settings.isolated({ "agent.prune.enabled": false });

		expect(resolveAgentPruneBudget(settings)).toEqual({ afterMs: 0, waitingAfterMs: 0 });
	});

	/**
	 * Disabling must beat leftover budget values. An operator who turns the feature
	 * off after tuning the timers still has those timers on disk, and honouring them
	 * would make the off switch a no-op.
	 */
	it("ignores configured budgets while disabled", () => {
		const settings = Settings.isolated({
			"agent.prune.enabled": false,
			"agent.prune.afterMs": 60_000,
			"agent.prune.waitingAfterMs": 120_000,
		});

		expect(resolveAgentPruneBudget(settings)).toEqual({ afterMs: 0, waitingAfterMs: 0 });
	});

	/** Explicit budgets pass through unchanged when they are ordered sensibly. */
	it("preserves explicit budgets", () => {
		const settings = Settings.isolated({
			"agent.prune.afterMs": 15 * 60_000,
			"agent.prune.waitingAfterMs": 60 * 60_000,
		});

		expect(resolveAgentPruneBudget(settings)).toEqual({
			afterMs: 15 * 60_000,
			waitingAfterMs: 60 * 60_000,
		});
	});

	/**
	 * A waiting budget below the quiet one is a misconfiguration that would invert
	 * the whole point: the agent that stopped to let a peer finish would be dropped
	 * SOONER than an agent that simply ran out of work. Floored to the quiet budget so
	 * the mistake can only lengthen a waiting grace.
	 */
	it("floors the waiting budget at the quiet budget", () => {
		const settings = Settings.isolated({
			"agent.prune.afterMs": 30 * 60_000,
			"agent.prune.waitingAfterMs": 60_000,
		});

		expect(resolveAgentPruneBudget(settings)).toEqual({
			afterMs: 30 * 60_000,
			waitingAfterMs: 30 * 60_000,
		});
	});

	/**
	 * A zero quiet budget is the second spelling of "never prune" (it arrives from
	 * the same schema the UI writes) and it must not leave the waiting budget armed,
	 * which would prune only waiting agents and nothing else.
	 */
	it("treats a zero quiet budget as never pruning, even with a waiting budget set", () => {
		const settings = Settings.isolated({
			"agent.prune.afterMs": 0,
			"agent.prune.waitingAfterMs": 30 * 60_000,
		});

		expect(resolveAgentPruneBudget(settings)).toEqual({ afterMs: 0, waitingAfterMs: 0 });
	});

	/**
	 * Garbage on disk falls back to the defaults rather than to NaN deadlines, which
	 * would make every comparison false and silently disable pruning.
	 */
	it("falls back to defaults for unusable values", () => {
		const settings = Settings.isolated({
			"agent.prune.afterMs": "soon" as unknown as number,
			"agent.prune.waitingAfterMs": Number.NaN,
		});

		expect(resolveAgentPruneBudget(settings)).toEqual({
			afterMs: DEFAULT_AGENT_PRUNE_MS,
			waitingAfterMs: DEFAULT_AGENT_WAITING_PRUNE_MS,
		});
	});

	/** A negative budget is clamped, not passed through as an always-expired deadline. */
	it("clamps a negative budget to never pruning", () => {
		const settings = Settings.isolated({ "agent.prune.afterMs": -60_000 });

		expect(resolveAgentPruneBudget(settings)).toEqual({ afterMs: 0, waitingAfterMs: 0 });
	});
});
