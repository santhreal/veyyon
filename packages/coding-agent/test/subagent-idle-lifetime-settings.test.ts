import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	DEFAULT_SUBAGENT_IDLE_TTL_MS,
	DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
	DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
} from "@veyyon/coding-agent/config/settings-domains/subagents";
import { resolveSubagentAutoCloseBudget, resolveSubagentIdleTtlMs } from "@veyyon/coding-agent/task/subagent-settings";

describe("subagent idle lifetime settings", () => {
	/**
	 * A fresh install must use one predictable lifecycle budget, regardless of
	 * which provider or model the subagent ran.
	 */
	it("defaults every idle subagent to five minutes", () => {
		const settings = Settings.isolated();

		expect(settings.get("subagent.idleTtlMs")).toBe(DEFAULT_SUBAGENT_IDLE_TTL_MS);
		expect(settings.isConfigured("subagent.idleTtlMs")).toBe(false);
		expect(resolveSubagentIdleTtlMs(settings)).toBe(5 * 60_000);
	});

	/** A positive override must replace the five-minute lifecycle budget exactly. */
	it("preserves an explicit positive idle TTL override", () => {
		const settings = Settings.isolated({ "subagent.idleTtlMs": 12_345 });

		expect(settings.get("subagent.idleTtlMs")).toBe(12_345);
		expect(settings.isConfigured("subagent.idleTtlMs")).toBe(true);
		expect(resolveSubagentIdleTtlMs(settings)).toBe(12_345);
	});

	/** Zero is an intentional keep-live policy, not another spelling for the default. */
	it("preserves an explicit zero idle TTL override", () => {
		const settings = Settings.isolated({ "subagent.idleTtlMs": 0 });

		expect(settings.get("subagent.idleTtlMs")).toBe(0);
		expect(settings.isConfigured("subagent.idleTtlMs")).toBe(true);
		expect(resolveSubagentIdleTtlMs(settings)).toBe(0);
	});
});

/**
 * How the three auto-close settings become the two budgets the lifecycle manager
 * reads.
 *
 * WHY THIS EXISTS. The resolver is where an operator's intent either survives or
 * quietly turns into something else, and the something else is expensive in both
 * directions: a budget that fails open leaves every finished agent in the roster,
 * and a budget that fails closed drops peers while they are still needed. So the off
 * switch, the defaults, and the relationship between the two budgets are each pinned
 * rather than assumed from the schema.
 */
describe("subagent auto-close budget settings", () => {
	/** A fresh install closes quiet agents after 5 minutes and waiting ones after 30. */
	it("defaults to a five-minute quiet close and a thirty-minute waiting close", () => {
		const settings = Settings.isolated();

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({
			parkedMs: DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
			waitingMs: DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
		});
		expect(DEFAULT_SUBAGENT_PARKED_CLOSE_MS).toBe(5 * 60_000);
		expect(DEFAULT_SUBAGENT_WAITING_CLOSE_MS).toBe(30 * 60_000);
	});

	/**
	 * The off switch must resolve to zero, which the manager reads as "never close".
	 * Resolving to a large number instead would still eventually drop refs, which is
	 * exactly what an operator who turned the feature off did not ask for.
	 */
	it("resolves to zero budgets when disabled", () => {
		const settings = Settings.isolated({ "subagent.autoClose.enabled": false });

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({ parkedMs: 0, waitingMs: 0 });
	});

	/**
	 * Disabling must beat leftover budget values. An operator who turns the feature
	 * off after tuning the timers still has those timers on disk, and honouring them
	 * would make the off switch a no-op.
	 */
	it("ignores configured budgets while disabled", () => {
		const settings = Settings.isolated({
			"subagent.autoClose.enabled": false,
			"subagent.autoClose.parkedMs": 60_000,
			"subagent.autoClose.waitingMs": 120_000,
		});

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({ parkedMs: 0, waitingMs: 0 });
	});

	/** Explicit budgets pass through unchanged when they are ordered sensibly. */
	it("preserves explicit budgets", () => {
		const settings = Settings.isolated({
			"subagent.autoClose.parkedMs": 15 * 60_000,
			"subagent.autoClose.waitingMs": 60 * 60_000,
		});

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({
			parkedMs: 15 * 60_000,
			waitingMs: 60 * 60_000,
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
			"subagent.autoClose.parkedMs": 30 * 60_000,
			"subagent.autoClose.waitingMs": 60_000,
		});

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({
			parkedMs: 30 * 60_000,
			waitingMs: 30 * 60_000,
		});
	});

	/**
	 * A zero quiet budget is the second spelling of "never close" (it arrives from
	 * the same schema the UI writes) and it must not leave the waiting budget armed,
	 * which would close only waiting agents and nothing else.
	 */
	it("treats a zero quiet budget as never closing, even with a waiting budget set", () => {
		const settings = Settings.isolated({
			"subagent.autoClose.parkedMs": 0,
			"subagent.autoClose.waitingMs": 30 * 60_000,
		});

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({ parkedMs: 0, waitingMs: 0 });
	});

	/**
	 * Garbage on disk falls back to the defaults rather than to NaN deadlines, which
	 * would make every comparison false and silently disable closing.
	 */
	it("falls back to defaults for unusable values", () => {
		const settings = Settings.isolated({
			"subagent.autoClose.parkedMs": "soon" as unknown as number,
			"subagent.autoClose.waitingMs": Number.NaN,
		});

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({
			parkedMs: DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
			waitingMs: DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
		});
	});

	/** A negative budget is clamped, not passed through as an always-expired deadline. */
	it("clamps a negative budget to never closing", () => {
		const settings = Settings.isolated({ "subagent.autoClose.parkedMs": -60_000 });

		expect(resolveSubagentAutoCloseBudget(settings)).toEqual({ parkedMs: 0, waitingMs: 0 });
	});
});
