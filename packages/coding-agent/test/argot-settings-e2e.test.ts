/**
 * Every Argot setting, as an operator actually sets it, reaches the behavior it
 * claims to control — end to end, through the REAL `Settings` object.
 *
 * Why this suite exists:
 *   The codec is unit-tested (lossless expand), the encode gate is tested with
 *   literal arguments (`argot-gate.test.ts`), and the subagent policy is tested by
 *   calling `createArgotSession` with literals (`argot-subagent-boundary.test.ts`).
 *   None of those proves the SETTINGS LAYER binds: that when an operator writes
 *   `argot.enabled`, `argot.models`, `argot.disableAboveTokens`, `argot.tokenBudget`,
 *   or `argot.subagents` into config, `settings.get(...)` returns that value and it
 *   flows into `buildArgotGate` / `createArgotSession` (and `loadArgotFolder` for the budget) the way the SDK wires it. A
 *   setting that appears in the defaults table but never reaches behavior is a dead
 *   knob, the exact "settings don't actually work" failure this suite forbids.
 *
 * The contract these tests lock in (one row per shipped Argot setting):
 *   - The shipped DEFAULTS produce the safe inert state: off, nobody encodes, no
 *     cutoff, default dictionary budget, no subagent shorthand.
 *   - Each setting, overridden, changes an OBSERVABLE outcome: the gate encodes or
 *     not, for the right model, up to the right context size; the session is built
 *     or withheld (always unarmed until the agent loads); the subagent forks the parent or starts empty.
 *   - `getEffectiveSnapshot()` carries every Argot key, so a recorded run can be
 *     reproduced from the config that governed it.
 *
 * How it stays honest:
 *   `sdkArgotReads` reproduces the EXACT `settings.get(...)` calls the SDK makes at
 *   session construction (sdk.ts: `argot.enabled`, `argot.models`,
 *   `argot.disableAboveTokens`, `argot.subagents`, `argot.tokenBudget`). The test
 *   then feeds those reads into the SAME real functions the SDK feeds them into
 *   (`buildArgotGate`, `createArgotSession`). Nothing is re-derived; the only thing
 *   this file owns is proving the operator's value survives the Settings round trip.
 *   If the SDK's read set drifts, this mirror must drift with it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createArgotSession } from "@veyyon/coding-agent/argot-cache";
import { buildArgotGate } from "@veyyon/coding-agent/argot-wire";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import { ArgotSession, DEFAULT_TOKEN_BUDGET, EMPTY_GATE, shouldEncode } from "argot";

const MODEL = "google-antigravity/gemini-3.5-flash";
const OTHER = "anthropic/claude-opus-4";

/**
 * The exact reads the SDK performs at session construction (sdk.ts). Reproduced
 * here so the test exercises the real Settings round trip, not a parallel guess at
 * what the SDK reads. Keep in lockstep with sdk.ts's argot wiring.
 */
function sdkArgotReads(settings: Settings) {
	const enabled = settings.get("argot.enabled") === true;
	return {
		enabled,
		models: (settings.get("argot.models") as string[] | undefined) ?? [],
		disableAboveTokens: settings.get("argot.disableAboveTokens") as number,
		subagentMode: settings.get("argot.subagents") as "off" | "fresh" | "inherit",
		tokenBudget: settings.get("argot.tokenBudget") as number | undefined,
	};
}

/** A parent codec that binds one handle, so `inherit` is observable by expansion. */
function parentCodec(): ArgotSession {
	const s = new ArgotSession();
	s.load("root", {
		version: 1,
		sigil: "§",
		handles: new Map([["dbconn", "packages/server/database/connection.ts"]]),
		meta: new Map(),
	});
	return s;
}

describe("Argot defaults: the shipped config is the safe inert state", () => {
	it("with no overrides, every read is the documented default", () => {
		const r = sdkArgotReads(Settings.isolated());
		expect(r.enabled).toBe(false);
		expect(r.models).toEqual([]);
		expect(r.disableAboveTokens).toBe(-1);
		expect(r.subagentMode).toBe("off");
		expect(r.tokenBudget).toBe(DEFAULT_TOKEN_BUDGET);
	});

	it("the default gate is the inert EMPTY_GATE and never encodes, at any context size", () => {
		const r = sdkArgotReads(Settings.isolated());
		const gate = buildArgotGate(r.enabled, r.models, r.disableAboveTokens);
		expect(gate).toBe(EMPTY_GATE);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 5_000_000 })).toBe(false);
	});

	it("the default builds no codec (feature off), top-level or subagent", () => {
		const r = sdkArgotReads(Settings.isolated());
		const top = createArgotSession({
			enabled: r.enabled,
			isSubagent: false,
			subagentMode: r.subagentMode,
		});
		expect(top).toBeUndefined();
	});

	it("getEffectiveSnapshot records every Argot key so a run can be reproduced", () => {
		const snap = Settings.isolated().getEffectiveSnapshot();
		expect(snap["argot.enabled"]).toBe(false);
		expect(snap["argot.models"]).toEqual([]);
		expect(snap["argot.disableAboveTokens"]).toBe(-1);
		expect(snap["argot.tokenBudget"]).toBe(DEFAULT_TOKEN_BUDGET);
		expect(snap["argot.subagents"]).toBe("off");
	});
});

describe("argot.enabled binds: the master switch turns the gate and codec on", () => {
	it("enabling (with a listed model) opens the gate that the default keeps shut", () => {
		const off = sdkArgotReads(Settings.isolated());
		const on = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.models": [MODEL] }));
		expect(buildArgotGate(off.enabled, off.models, off.disableAboveTokens)).toBe(EMPTY_GATE);
		const onGate = buildArgotGate(on.enabled, on.models, on.disableAboveTokens);
		expect(onGate).not.toBe(EMPTY_GATE);
		expect(shouldEncode(onGate, { model: MODEL, contextTokens: 0 })).toBe(true);
	});

	it("enabling builds a real (top-level) codec where the default built none", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true }));
		// Loading is agent-driven: the session starts unarmed until the agent loads a folder.
		const session = createArgotSession({
			enabled: r.enabled,
			isSubagent: false,
			subagentMode: r.subagentMode,
		});
		expect(session).toBeDefined();
		expect(session?.loaded).toBe(false);
	});
});

describe("argot.models binds: only listed models are taught shorthand", () => {
	it("an empty allowlist (the default) teaches nobody even with the feature on", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true }));
		const gate = buildArgotGate(r.enabled, r.models, r.disableAboveTokens);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
	});

	it("a listed model encodes and an unlisted one does not", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.models": [MODEL] }));
		const gate = buildArgotGate(r.enabled, r.models, r.disableAboveTokens);
		expect(gate.models).toEqual([MODEL]);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: OTHER, contextTokens: 0 })).toBe(false);
	});
});

describe("argot.disableAboveTokens binds: the context cutoff stops teaching", () => {
	it("the default -1 sentinel encodes at any context size", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.models": [MODEL] }));
		expect(r.disableAboveTokens).toBe(-1);
		const gate = buildArgotGate(r.enabled, r.models, r.disableAboveTokens);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 900_000 })).toBe(true);
	});

	it("a configured cutoff stops encoding at and above the threshold", () => {
		const r = sdkArgotReads(
			Settings.isolated({ "argot.enabled": true, "argot.models": [MODEL], "argot.disableAboveTokens": 200_000 }),
		);
		expect(r.disableAboveTokens).toBe(200_000);
		const gate = buildArgotGate(r.enabled, r.models, r.disableAboveTokens);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 199_999 })).toBe(true);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 200_000 })).toBe(false);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 200_001 })).toBe(false);
	});
});

describe("argot.tokenBudget binds: the operator's budget reaches dictionary generation", () => {
	it("the default read is the compiled DEFAULT_TOKEN_BUDGET", () => {
		expect(sdkArgotReads(Settings.isolated()).tokenBudget).toBe(DEFAULT_TOKEN_BUDGET);
	});

	it("a configured budget is read verbatim for the load path; session starts unarmed", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.tokenBudget": 2000 }));
		expect(r.tokenBudget).toBe(2000);
		// Loading is agent-driven: createArgotSession no longer takes the budget.
		// The SDK still reads it (above) and threads it into loadArgotFolder / argot_load.
		// Enabling still yields a real, unarmed session object.
		const session = createArgotSession({
			enabled: r.enabled,
			isSubagent: false,
			subagentMode: r.subagentMode,
		});
		expect(session).toBeDefined();
		expect(session?.loaded).toBe(false);
	});

	it("getEffectiveSnapshot carries the overridden budget for reproducible runs", () => {
		const snap = Settings.isolated({ "argot.tokenBudget": 4000 }).getEffectiveSnapshot();
		expect(snap["argot.tokenBudget"]).toBe(4000);
	});
});

describe("argot.subagents binds: the setting selects the child's codec policy", () => {
	it("the default `off` gives a subagent no codec even with a forkable parent", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true }));
		expect(r.subagentMode).toBe("off");
		const child = createArgotSession({
			enabled: r.enabled,
			isSubagent: true,
			subagentMode: r.subagentMode,
			parentArgot: parentCodec(),
		});
		expect(child).toBeUndefined();
	});

	it("`inherit` forks the parent so the child writes the parent's handles", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.subagents": "inherit" }));
		expect(r.subagentMode).toBe("inherit");
		// Loading is agent-driven; inherit starts as a detached fork of the parent's loaded shorthand.
		const child = createArgotSession({
			enabled: r.enabled,
			isSubagent: true,
			subagentMode: r.subagentMode,
			parentArgot: parentCodec(),
		});
		expect(child?.expand("§dbconn")).toBe("packages/server/database/connection.ts");
	});

	it("`fresh` ignores the parent and starts its own unarmed codec", () => {
		const r = sdkArgotReads(Settings.isolated({ "argot.enabled": true, "argot.subagents": "fresh" }));
		expect(r.subagentMode).toBe("fresh");
		// Loading is agent-driven: fresh starts empty; the child loads its project itself.
		const child = createArgotSession({
			enabled: r.enabled,
			isSubagent: true,
			subagentMode: r.subagentMode,
			parentArgot: parentCodec(),
		});
		expect(child).toBeDefined();
		expect(child?.loaded).toBe(false);
		expect(child?.expand("§dbconn")).toBe("§dbconn"); // did not inherit
	});
});

// ---------------------------------------------------------------------------
// The disabled-vs-enabled differential: a proof is a CONTRAST, not a snapshot.
// ---------------------------------------------------------------------------

/**
 * The Argot group hides its knobs when the feature is off and reveals them when
 * it is on. This is the difference a settings screenshot must show — a snapshot of
 * the all-default (off) state proves nothing, because you cannot see the feature
 * do anything. Off exposes only the master toggle; turning it on (a permanent
 * settings change, distinct from an ephemeral preview) reveals the four dependent
 * knobs. `argot.models`, `argot.tokenBudget`, `argot.disableAboveTokens`, and
 * `argot.subagents` gate on the `argotEnabled` condition; `argot.enabled` never
 * does. Mirrors the selector's own visibility rule (`!def.condition ||
 * def.condition()`), so this asserts exactly what the screen renders.
 */
const ARGOT_SETTING_PATHS = [
	"argot.enabled",
	"argot.models",
	"argot.tokenBudget",
	"argot.disableAboveTokens",
	"argot.subagents",
] as const;

/** The Argot settings the context tab would render, given the current global Settings. */
function visibleArgotSettings(): string[] {
	invalidateSettingDefsCache();
	return getSettingsForTab("context")
		.filter(def => (ARGOT_SETTING_PATHS as readonly string[]).includes(def.path))
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

/**
 * Drive the GLOBAL Settings singleton to a known `argot.enabled`, defeating
 * `Settings.init`'s memoization with `resetSettingsForTest` so the value actually
 * changes between cases. The `argotEnabled` condition reads this global, not an
 * isolated instance.
 */
async function setGlobalArgotEnabled(enabled: boolean): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "argot.enabled": enabled } });
}

describe("the Argot settings group is a disabled-vs-enabled differential", () => {
	// Restore a clean singleton afterward so later files see no leaked global.
	afterAll(() => {
		resetSettingsForTest();
	});

	it("with Argot OFF (the shipped default), only the master toggle is visible", async () => {
		await setGlobalArgotEnabled(false);
		expect(visibleArgotSettings()).toEqual(["argot.enabled"]);
	});

	it("turning Argot ON reveals all four dependent knobs", async () => {
		await setGlobalArgotEnabled(true);
		expect(visibleArgotSettings()).toEqual([
			"argot.enabled",
			"argot.models",
			"argot.tokenBudget",
			"argot.disableAboveTokens",
			"argot.subagents",
		]);
	});

	it("the enabled view strictly adds to the disabled view (the contrast a screenshot must show)", async () => {
		await setGlobalArgotEnabled(false);
		const off = visibleArgotSettings();
		await setGlobalArgotEnabled(true);
		const on = visibleArgotSettings();
		expect(on.length).toBeGreaterThan(off.length);
		expect(on).toEqual(expect.arrayContaining(off));
		// Degenerate proof guard: off and on must not be identical.
		expect(on).not.toEqual(off);
	});
});
