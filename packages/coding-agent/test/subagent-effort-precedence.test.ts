import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { resolveEffectiveSubagentThinkingLevel } from "@veyyon/coding-agent/task/executor";

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

	it("returns undefined when nothing supplies a level", () => {
		expect(resolveEffectiveSubagentThinkingLevel(false, undefined, undefined)).toBeUndefined();
	});

	it("keeps the explicit level even when it resolves to undefined-free `auto`", () => {
		// An explicit suffix wins outright: the agent default never masks it.
		expect(resolveEffectiveSubagentThinkingLevel(true, Effort.Minimal, Effort.XHigh)).toBe(Effort.Minimal);
	});
});
