import { describe, expect, it, spyOn } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import {
	ANY_MODEL_EFFORT_KEY,
	formatEffortRow,
	parseConfiguredEffortSetting,
	resolveEffort,
	withLegacyDefaultEffort,
	withPersistedEffort,
} from "@veyyon/coding-agent/config/effort-resolver";
import { AUTO_THINKING, CLI_THINKING_LEVELS } from "@veyyon/coding-agent/thinking";
import { logger } from "@veyyon/utils";

/**
 * The precedence table for thinking effort, asserted case by case.
 *
 * Effort used to live in three stores (a profile-wide `defaultThinkingLevel`
 * enum, a `:level` suffix on a model selector, and session state) with the
 * ordering written inline at `main.ts`, which is why nobody could say which one
 * was in effect. One
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

/**
 * WHY THIS SUITE EXISTS (A CONFIGURED EFFORT THAT DOES NOTHING SAYS SO).
 *
 * "Ignores a junk row" above is only half a contract. The other half is that
 * ignoring it is AUDIBLE, because "inherited" is exactly what an operator sees
 * when they set nothing: a typo left a row that looked configured and did
 * nothing, forever, with no way to notice. `resolveSubagentThinkingLevel` already
 * reported its own store that way, and `defaultEffort` — the ONE persisted effort
 * store the settings screen edits — did not, so the same mistake was loud in one
 * place and silent in the other.
 *
 * `parseConfiguredEffortSetting` is now the single owner both stores read, so the
 * accepted-values list cannot drift between them, and the assertions below derive
 * that list from the vocabulary rather than restating it.
 */
describe("a defaultEffort row that names no level is reported, not swallowed", () => {
	/**
	 * Collect `logger.warn` messages while a block runs, and restore the logger after.
	 *
	 * The reports under test are said once per process per key, so every case that
	 * asserts one uses a value no other case uses — otherwise a later case sees
	 * nothing and passes for the wrong reason.
	 */
	function captureLoggerWarnings(into: string[]): () => void {
		const spy = spyOn(logger, "warn").mockImplementation((message: unknown) => {
			into.push(String(message));
		});
		return () => spy.mockRestore();
	}

	it("names the row key, the value, and every level that would have worked", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			// A value no other case in this file uses: the report fires once per process.
			const resolved = resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: "hihg" } });
			expect(resolved).toEqual({ level: undefined, source: "model-default" });
		} finally {
			restore();
		}

		const reported = warnings.find(message => message.includes("hihg"));
		expect(reported).toBeDefined();
		expect(reported).toContain(`defaultEffort["${OPUS}"]`);
		expect(reported).toContain("inherited");
		for (const level of CLI_THINKING_LEVELS) expect(reported).toContain(level);
	});

	it("names the any-model row when that is the value at fault", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			resolveEffort({ modelSelector: HAIKU, defaultEffort: { [ANY_MODEL_EFFORT_KEY]: "ludicrous" } });
		} finally {
			restore();
		}

		const reported = warnings.find(message => message.includes("ludicrous"));
		expect(reported).toBeDefined();
		expect(reported).toContain(`defaultEffort["${ANY_MODEL_EFFORT_KEY}"]`);
		expect(reported).not.toContain(HAIKU);
	});

	/**
	 * A row that resolves cleanly, an absent row, and a blank row are the ordinary
	 * states of this setting. Warning on any of them would fire on every status-line
	 * render, which is the failure mode that makes a report worth ignoring.
	 */
	it("says nothing about a row that resolves, is absent, or is blank", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: ThinkingLevel.High } });
			resolveEffort({ modelSelector: OPUS, defaultEffort: {} });
			resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: "   ", [ANY_MODEL_EFFORT_KEY]: "" } });
			resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: `  ${AUTO_THINKING}  ` } });
		} finally {
			restore();
		}

		expect(warnings).toEqual([]);
	});

	/**
	 * One store, one sentence. Both persisted effort settings go through the shared
	 * parser, so an operator who mistypes either one is told the same thing with the
	 * same accepted list — the drift this replaced had two copies of the message.
	 */
	it("reports the subagent effort setting through the same owner", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			expect(parseConfiguredEffortSetting("subagent.thinkingLevel", "sideways")).toBeUndefined();
			expect(parseConfiguredEffortSetting('defaultEffort["*"]', "sideways")).toBeUndefined();
		} finally {
			restore();
		}

		expect(warnings).toHaveLength(2);
		for (const message of warnings) {
			expect(message).toContain("sideways");
			expect(message).toContain("inherited");
			for (const level of CLI_THINKING_LEVELS) expect(message).toContain(level);
		}
	});

	/** Said once per process per key, or `resolveEffort` would flood the log from the status line. */
	it("reports one bad value once, however many reads follow", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			for (let read = 0; read < 5; read++) {
				resolveEffort({ modelSelector: OPUS, defaultEffort: { [OPUS]: "furious" } });
			}
		} finally {
			restore();
		}

		expect(warnings.filter(message => message.includes("furious"))).toHaveLength(1);
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
		const rows = withPersistedEffort({ [OPUS]: ThinkingLevel.XHigh }, undefined, ThinkingLevel.Medium);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.XHigh, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Medium });
		expect(resolveEffort({ defaultEffort: rows })).toEqual({ level: ThinkingLevel.Medium, source: "any-row" });
	});

	it("replaces an existing any-model row rather than keeping the older one", () => {
		expect(withPersistedEffort({ [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low }, undefined, ThinkingLevel.High)).toEqual(
			{
				[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High,
			},
		);
	});

	it("carries a legacy-only profile forward instead of dropping its per-model rows", () => {
		// A profile still on the retired enum has no `defaultEffort` object, so the
		// first persist is also the migration. Ignoring the legacy value here would
		// silently discard the level that operator had saved.
		expect(withPersistedEffort(undefined, ThinkingLevel.XHigh, AUTO_THINKING)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: AUTO_THINKING,
		});
	});

	it("does not resurrect the legacy enum into a list the operator cleared", () => {
		// `{}` is a deliberate cleared default. The persist adds the one row asked
		// for and nothing else.
		expect(withPersistedEffort({}, ThinkingLevel.High, ThinkingLevel.Low)).toEqual({
			[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Low,
		});
	});

	it("does not mutate the rows it was handed", () => {
		// Settings owns the object; mutating it would edit stored state before the
		// write, defeating any comparison the caller makes.
		const rows = { [OPUS]: ThinkingLevel.High };
		withPersistedEffort(rows, undefined, ThinkingLevel.Low);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.High });
	});

	it("updates the model's own row when that row is what governs it", () => {
		// The same defect as the retired key, one precedence step later: a
		// per-model row outranks `*`, so writing `*` while sitting on a model that
		// has its own row stores a value the resolver never reaches. The pin has to
		// be observable for the model it was made on.
		const rows = withPersistedEffort({ [OPUS]: ThinkingLevel.Low }, undefined, ThinkingLevel.High, OPUS);
		expect(rows).toEqual({ [OPUS]: ThinkingLevel.High });
		expect(resolveEffort({ modelSelector: OPUS, defaultEffort: rows })).toEqual({
			level: ThinkingLevel.High,
			source: "model-row",
		});
	});

	it("leaves other models alone when it updates one model's row", () => {
		// Persisting on one model must not redefine what every other model does,
		// which is what writing `*` as well would mean.
		const rows = withPersistedEffort(
			{ [OPUS]: ThinkingLevel.Low, [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.Minimal },
			undefined,
			ThinkingLevel.High,
			OPUS,
		);
		expect(rows[ANY_MODEL_EFFORT_KEY]).toBe(ThinkingLevel.Minimal);
	});

	it("writes the any-model row for a model that has none of its own", () => {
		// Nothing more specific governs, so `*` is both the row that answers for this
		// model and the profile-wide default being set.
		expect(withPersistedEffort({ [OPUS]: ThinkingLevel.Low }, undefined, ThinkingLevel.High, "openai/gpt-5")).toEqual(
			{
				[OPUS]: ThinkingLevel.Low,
				[ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High,
			},
		);
	});

	it("writes the any-model row when the model's own row is unreadable", () => {
		// A row holding a typo does not govern -- `resolveEffort` skips it and falls
		// through to `*` -- so `*` is the row that has to change. Writing the junk
		// row instead would leave the pin as invisible as before, which is why the
		// question is asked of the resolver rather than of `rows[selector]`.
		const rows = withPersistedEffort({ [OPUS]: "hgih" }, undefined, ThinkingLevel.High, OPUS);
		expect(rows).toEqual({ [OPUS]: "hgih", [ANY_MODEL_EFFORT_KEY]: ThinkingLevel.High });
		expect(resolveEffort({ modelSelector: OPUS, defaultEffort: rows })).toEqual({
			level: ThinkingLevel.High,
			source: "any-row",
		});
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
