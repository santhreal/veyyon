import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Effort } from "@veyyon/catalog/effort";
import { loadBundledAgents } from "@veyyon/coding-agent/task/agents";
import { resolveEffectiveSubagentThinkingLevel } from "@veyyon/coding-agent/task/executor";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";

/**
 * The effort a dispatched subagent runs at. This pins the precedence the
 * `subagent.model` effort UI (FE-1) depends on: a `:level` suffix on the
 * resolved pattern beats the agent's own default, which beats the
 * pattern-derived level. Exact levels, not shape.
 */
describe("resolveEffectiveSubagentThinkingLevel", () => {
	it("uses the explicit `:level` suffix when the resolver marked it explicit", () => {
		// subagent.model = "provider/id:high" -> explicit High, agent default ignored.
		expect(resolveEffectiveSubagentThinkingLevel(true, Effort.High, Effort.Low)).toBe(Effort.High);
	});

	it("falls back to the agent-definition default when no explicit suffix was given", () => {
		// bare selector: explicit=false, resolver has no level, agent asked for Medium.
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, Effort.Medium)).toBe(Effort.Medium);
	});

	it("falls back to the pattern-derived level when there is no agent default", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, Effort.Low, undefined)).toBe(Effort.Low);
	});

	it("prefers the agent default over a pattern-derived level when not explicit", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, Effort.Low, Effort.High)).toBe(Effort.High);
	});

	it("leaves effort unresolved when no configuration layer supplies one", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, undefined)).toBeUndefined();
	});

	it("keeps the explicit level even when it resolves to undefined-free `auto`", () => {
		// An explicit suffix wins outright: the agent default never masks it.
		expect(resolveEffectiveSubagentThinkingLevel(true, Effort.Minimal, Effort.XHigh)).toBe(Effort.Minimal);
	});

	/**
	 * The built-in general worker advertises inheritance rather than auto, so a
	 * task without an effort override cannot silently reclassify its own effort.
	 */
	it("configures the bundled task agent to inherit effort", () => {
		const task = loadBundledAgents().find(agent => agent.name === "task");
		expect(task?.thinkingLevel).toBe(ThinkingLevel.Inherit);
	});

	/**
	 * Parent inheritance is applied by the executor after this resolver. The
	 * three-argument resolver must preserve the configured inherit sentinel.
	 */
	it("preserves agent-level inherit for parent-effort resolution", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, ThinkingLevel.Inherit)).toBe(
			ThinkingLevel.Inherit,
		);
	});

	/**
	 * Inherit on an explicit model selector remains authoritative here so the
	 * executor can resolve it against the parent's effective effort.
	 */
	it("preserves explicit inherit for parent-effort resolution", () => {
		expect(resolveEffectiveSubagentThinkingLevel(true, ThinkingLevel.Inherit, Effort.XHigh)).toBe(
			ThinkingLevel.Inherit,
		);
	});

	/**
	 * A caller-resolved off effort is concrete and must remain off.
	 */
	it("preserves a resolved off effort exactly", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
	});

	/**
	 * A parent configured as auto passes its concrete per-turn resolution. Once
	 * supplied by the caller, xhigh must remain concrete.
	 */
	it("preserves the concrete effort resolved by a parent in auto mode", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, Effort.XHigh)).toBe(Effort.XHigh);
	});

	/**
	 * A child that explicitly requests auto keeps that override over the
	 * caller-resolved parent effort.
	 */
	it("preserves an explicit child auto override", () => {
		expect(resolveEffectiveSubagentThinkingLevel(true, AUTO_THINKING, Effort.High)).toBe(AUTO_THINKING);
	});

	/**
	 * An omitted child level uses the effective effort already resolved by the
	 * caller rather than falling through to model defaults.
	 */
	it("uses the caller-resolved parent effort when the child level is omitted", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, Effort.Medium)).toBe(Effort.Medium);
	});

	/**
	 * If no concrete parent effort exists, the configured inherit sentinel must
	 * survive this resolver for the executor's inheritance step.
	 */
	it("preserves inherit when the parent effective effort is undefined", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, ThinkingLevel.Inherit)).toBe(
			ThinkingLevel.Inherit,
		);
	});
});
