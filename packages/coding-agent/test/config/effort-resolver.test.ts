import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import {
	ANY_MODEL_EFFORT_KEY,
	formatEffortRow,
	resolveEffort,
	withAnyModelEffort,
	withLegacyDefaultEffort,
} from "@veyyon/coding-agent/config/effort-resolver";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";

/**
 * The precedence table for thinking effort, asserted case by case.
 *
 * Effort used to live in three stores (a profile-wide `defaultThinkingLevel`
 * enum, a `:level` suffix on a model selector, and session state) with the
 * ordering written inline at `main.ts`, which is why nobody could say which one
 * was in effect: "effort level is very muddled" (operator, 2026-07-24). One
 * owner now answers it, and every rung of the ladder is pinned here — including
 * both places `auto` may appear, since `auto` not fitting in a selector suffix
 * is the reason the extra store existed at all.
 */

const OPUS = "anthropic/claude-opus-5";
const HAIKU = "anthropic/claude-haiku-4-5";

describe("resolving which effort applies", () => {
	it("prefers the session override over everything stored", () => {
		// What you just asked for beats what was saved; this is the case the old
		// code got wrong in the other direction, where `/thinking` wrote the
		// profile default and there was no way to try an effort without keeping it.
		const resolved = resolveEffort({
			sessionOverride: ThinkingLevel.Low,
			selectorLevel: ThinkingLevel.High,
			modelSelector: OPUS,
			defaultEffort: { [OPUS]: ThinkingLevel.Minimal, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Medium },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.Low, source: "session" });
	});

	it("prefers an explicit selector level over the stored rows", () => {
		// `role: provider/id:high` is a deliberate per-role pin and must outrank a
		// list entry, or a role configured for deep work would silently drop to the
		// list's value.
		const resolved = resolveEffort({
			selectorLevel: ThinkingLevel.High,
			modelSelector: OPUS,
			defaultEffort: { [OPUS]: ThinkingLevel.Minimal },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.High, source: "selector" });
	});

	it("uses the model's own row before the any-model row", () => {
		const resolved = resolveEffort({
			modelSelector: HAIKU,
			defaultEffort: { [HAIKU]: ThinkingLevel.Minimal, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.Minimal, source: "model-row" });
	});

	it("falls back to the any-model row for a model with no row", () => {
		// The `*` row is what the retired global enum meant, which is why it lives
		// in the same list instead of a second setting.
		const resolved = resolveEffort({
			modelSelector: OPUS,
			defaultEffort: { [HAIKU]: ThinkingLevel.Minimal, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.High, source: "any-row" });
	});

	it("reports the model default when nothing is configured", () => {
		// `undefined` means "let the model decide", which is NOT the same as `off`.
		// Collapsing the two would silently disable thinking on a fresh install.
		const resolved = resolveEffort({ modelSelector: OPUS, defaultEffort: {} });
		expect(resolved).toEqual({ level: undefined, source: "model-default" });
	});

	it("accepts auto as a row value, which the selector suffix never could", () => {
		// This is the whole reason the third store existed: `model:auto` cannot
		// round-trip through a selector string, so `auto` needed a home of its own.
		// A structured list gives it one.
		expect(resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: AUTO_THINKING } })).toEqual({
			level: AUTO_THINKING,
			source: "model-row",
		});
		expect(resolveEffort({ modelSelector: OPUS, defaultEffort: { [ANY_MODEL_EFFORT_KEY]: AUTO_THINKING } })).toEqual({
			level: AUTO_THINKING,
			source: "any-row",
		});
	});

	it("accepts auto as a session override", () => {
		expect(resolveEffort({ sessionOverride: AUTO_THINKING, modelSelector: OPUS })).toEqual({
			level: AUTO_THINKING,
			source: "session",
		});
	});

	it("keeps off distinct from unset", () => {
		// `off` is a real choice (no thinking) a user can pin per model, so it must
		// win over the any-model row rather than reading as "nothing set".
		const resolved = resolveEffort({
			modelSelector: OPUS,
			defaultEffort: { [OPUS]: ThinkingLevel.Off, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.Off, source: "model-row" });
	});

	it("ignores a junk row instead of trusting it", () => {
		// `settings.json` is hand-editable. A typo must fall through to the next
		// rung, never become `off` (silently no thinking) and never throw mid-turn.
		const resolved = resolveEffort({
			modelSelector: OPUS,
			defaultEffort: { [OPUS]: "hgih", [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Medium },
		});
		expect(resolved).toEqual({ level: ThinkingLevel.Medium, source: "any-row" });
	});

	it("tolerates surrounding whitespace in a hand-written row", () => {
		const resolved = resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: "  high  " } });
		expect(resolved).toEqual({ level: ThinkingLevel.High, source: "model-row" });
	});

	it("resolves with no model selector at all", () => {
		// Callers ask before a model is chosen (startup, SDK), so the any-model row
		// still has to answer rather than the lookup throwing on `undefined`.
		const resolved = resolveEffort({ defaultEffort: { [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High } });
		expect(resolved).toEqual({ level: ThinkingLevel.High, source: "any-row" });
	});
});

describe("migrating the retired global default", () => {
	it("turns a legacy defaultThinkingLevel into the any-model row", () => {
		expect(withLegacyDefaultEffort(undefined, ThinkingLevel.High)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High,
		});
	});

	it("treats a present per-model list as authoritative over the legacy enum", () => {
		// The replacement setting's presence is the migration marker. Filling a
		// missing `*` row here would resurrect a legacy value after the operator
		// deliberately chose model-only defaults.
		expect(withLegacyDefaultEffort({ [OPUS]: ThinkingLevel.XHigh }, ThinkingLevel.Medium)).toEqual({
			[OPUS]: ThinkingLevel.XHigh,
		});
	});

	it("lets an existing any-model row win over the legacy enum", () => {
		// The list is the surface the user now edits. If both exist, the enum is
		// the stale one, and overwriting the edited row would undo their change on
		// every read.
		expect(withLegacyDefaultEffort({ [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low }, ThinkingLevel.High)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low,
		});
	});

	it("treats an explicitly stored empty list as a deliberate cleared default", () => {
		// Deleting the Any Model row persists `{}`. It must stay empty on the very
		// next settings render instead of synthesizing stale legacy `auto` again.
		expect(withLegacyDefaultEffort({}, AUTO_THINKING)).toEqual({});
	});

	it("adds nothing when the legacy value is absent or junk", () => {
		expect(withLegacyDefaultEffort({}, undefined)).toEqual({});
		expect(withLegacyDefaultEffort({}, null)).toEqual({});
		expect(withLegacyDefaultEffort({}, "nonsense")).toEqual({});
	});

	it("does not mutate the rows it was handed", () => {
		// The caller's object is settings-owned; a mutating migration would write
		// the migrated row back into settings as a side effect of reading.
		const rows = { [OPUS]: ThinkingLevel.High };
		withLegacyDefaultEffort(rows, ThinkingLevel.Low);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.High });
	});
});

describe("persisting a durable default effort", () => {
	it("writes the any-model row into the setting the resolver reads", () => {
		// The whole point of this helper. Persisting used to write the retired
		// `defaultThinkingLevel` enum, which `withLegacyDefaultEffort` consults
		// only when `defaultEffort` is absent, so the write was discarded on the
		// next read for any profile that had ever opened the settings screen.
		const rows = withAnyModelEffort({ [OPUS]: ThinkingLevel.XHigh }, undefined, ThinkingLevel.Medium);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.XHigh, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Medium });
		expect(resolveEffort({ defaultEffort: rows })).toEqual({ level: ThinkingLevel.Medium, source: "any-row" });
	});

	it("replaces an existing any-model row rather than keeping the older one", () => {
		expect(withAnyModelEffort({ [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low }, undefined, ThinkingLevel.High)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High,
		});
	});

	it("carries a legacy-only profile forward instead of dropping its per-model rows", () => {
		// A profile still on the retired enum has no `defaultEffort` object, so the
		// first persist is also the migration. Ignoring the legacy value here would
		// silently discard the level that operator had saved.
		expect(withAnyModelEffort(undefined, ThinkingLevel.XHigh, AUTO_THINKING)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: AUTO_THINKING,
		});
	});

	it("does not resurrect the legacy enum into a list the operator cleared", () => {
		// `{}` is a deliberate cleared default. The persist adds the one row asked
		// for and nothing else.
		expect(withAnyModelEffort({}, ThinkingLevel.High, ThinkingLevel.Low)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low,
		});
	});

	it("does not mutate the rows it was handed", () => {
		// Settings owns the object; mutating it would edit stored state before the
		// write, defeating any comparison the caller makes.
		const rows = { [OPUS]: ThinkingLevel.High };
		withAnyModelEffort(rows, undefined, ThinkingLevel.Low);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.High });
	});
});

describe("rendering a row for the settings list", () => {
	it("names the any-model row in words rather than showing a bare asterisk", () => {
		expect(formatEffortRow(ANY_MODEL_EFFORT_KEY, ThinkingLevel.High)).toBe("any model · high");
	});

	it("shows the selector and its effort for a per-model row", () => {
		expect(formatEffortRow(OPUS, ThinkingLevel.XHigh)).toBe(`${OPUS} · xhigh`);
	});

	it("shows a junk value as stored so a typo is visible instead of hidden", () => {
		// The resolver ignores it; the list must still SHOW it, or the user cannot
		// see why their setting is not taking effect.
		expect(formatEffortRow(OPUS, "hgih")).toBe(`${OPUS} · hgih`);
	});
});
