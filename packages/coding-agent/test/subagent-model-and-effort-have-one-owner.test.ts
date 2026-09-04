/**
 * WHY THIS SUITE EXISTS (SUBAGENT-MODEL-AND-EFFORT-HAVE-ONE-OWNER — THE WHOLE CLASS).
 *
 * The defect: Settings → Subagents → Agents → <agent> carried its own Model and Effort rows, and both
 * outranked the blanket Subagent Model and Subagent Effort settings. Two screens answered one question
 * and disagreed on screen — the per-agent Model row printed an inherited value with an effort suffix
 * while the Effort row under it said inherit.
 *
 * The fix is two EXCLUSIVE scopes rather than a precedence ladder. `subagent.sharedModel` selects
 * which one is in force: off, each agent's lane decides and the blanket pair is inert; on, the
 * blanket pair decides for every agent, every lane is inert, and the per-agent rows are not drawn.
 * A lane keeps its value across the switch and decides again when it goes off.
 *
 * The class is: what a subagent RUNS has exactly one owner per axis IN EACH SCOPE, and neither scope
 * may read a setting the other owns. A test that pins the two field names closes the incident and
 * nothing else — the next `subagent.agents.<name>.effort`, or a fourth precedence layer under a new
 * name, lands green. So every case here derives its variant space at run time and fails by default:
 *
 *  1. WHICH SETTINGS DECIDE, PER SCOPE. Every `subagent.*` path in `SETTINGS_SCHEMA` is probed against
 *     the real resolvers in both scopes, and the set that changes the answer is pinned by equality for
 *     each: `subagent.agents` plus the switch while it is off, the blanket pair plus the switch while
 *     it is on. A new setting that reaches either resolver turns this RED, and so does a lane that
 *     keeps deciding under an on switch.
 *  2. WHAT A PER-AGENT ROW MAY DECIDE. Row field names are derived from the schema's own `subagent.*`
 *     leaf names, so the sweep grows with the settings area rather than with someone's memory. Exactly
 *     three fields may move the resolved model or effort, exactly one enablement and exactly one the
 *     nested spawn depth, pinned by equality in both directions.
 *  3. WHICH LAYER ANSWERED. The `SubagentModelSource` values a combinatorial sweep can actually produce
 *     must be exactly shared, lane, frontmatter and default. A fifth layer under any name produces a
 *     member this list does not name.
 *  4. WHAT THE SCREEN OFFERS. The real Agents editor is driven and its editable rows are pinned by
 *     exact equality, so a row that shows a value the scope in force does not read turns this RED.
 *     The shared-scope half of that screen — the rows replaced by a signpost — is driven in
 *     `modes/components/subagent-agents-surface.test.ts`.
 *  5. THE STALE COPY. A config already carrying the retired fields is loaded through the real loader,
 *     resolved, reloaded, and edited, because a persisted shape is how a fixed bug comes back after the
 *     fix ships. `subagent.modelByDepth` is swept in BOTH scopes, since a scope switch is exactly where
 *     a retired key gets read again.
 *
 * WHAT THIS DOES NOT CATCH: a precedence layer that reaches the executor without going through
 * `resolveSubagentModel` / `resolveSubagentThinkingLevel`. Those two functions are the choke point every
 * spawn passes through today, and a caller that computed its own model would be invisible here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { SubagentAgentSettings } from "@veyyon/coding-agent/config/settings-domains/subagents";
import { isSettingPath, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { resolveEffectiveSubagentThinkingLevel } from "@veyyon/coding-agent/task/executor";
import {
	AGENT_DEFAULT_EFFORT,
	configuredSubagentModelChains,
	isSubagentEnabled,
	resetSupersededAgentRowReports,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUPERSEDED_AGENT_ROW_FIELDS,
	type SubagentModelSource,
	subagentModelSourceLabel,
} from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { CONFIGURED_THINKING_LEVELS, type ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";
import { logger, removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { stubStdoutGeometry } from "./helpers/stdout-geometry";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const AGENT = "scout";
const BLANKET_MODEL = "anthropic/claude-sonnet-4-5";
const FRONTMATTER_MODEL = "google/gemini-2.5-pro";
const SESSION_MODEL = "anthropic/claude-opus-4-5";
const FALLBACK_MODEL = "openai/gpt-5";
const DEPTH_MODEL = "openai/gpt-5-mini";

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	resetSupersededAgentRowReports();
	geometryStub = stubStdoutGeometry({ columns: 200, rows: 60 });
});

afterEach(() => {
	resetSettingsForTest();
	resetSupersededAgentRowReports();
	geometryStub?.restore();
	geometryStub = undefined;
});

// ─────────────────────────────────────────────────────────────────────────────
// The choke point, read the way a spawn reads it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the two resolvers answer, for several agent shapes at once.
 *
 * One string rather than a handful of assertions because the sweeps below ask "did ANY part of the
 * answer move", and a fingerprint that covered only the blanket case would miss a layer that only
 * appears when frontmatter is present.
 */
function resolutionFingerprint(store: Settings): string {
	const contexts: Array<{
		agentName: string;
		agentModel?: string;
		agentThinkingLevel?: ThinkingLevel;
		taskDepth?: number;
	}> = [
		{ agentName: AGENT },
		{ agentName: AGENT, agentModel: FRONTMATTER_MODEL, agentThinkingLevel: ThinkingLevel.High },
		{ agentName: "reviewer", agentModel: FRONTMATTER_MODEL },
		// Depths a spawn actually runs at, so a nested lane level only moves the
		// answer when the resolution asks at the depth it governs.
		{ agentName: AGENT, agentModel: FRONTMATTER_MODEL, taskDepth: 1 },
		{ agentName: AGENT, taskDepth: 2 },
	];
	return contexts
		.map(context => {
			const model = resolveSubagentModel({
				settings: store,
				agentName: context.agentName,
				agentModel: context.agentModel,
				fallbackModelPattern: FALLBACK_MODEL,
				taskDepth: context.taskDepth,
			});
			const effort = resolveSubagentThinkingLevel({
				settings: store,
				agentName: context.agentName,
				agentThinkingLevel: context.agentThinkingLevel,
				taskDepth: context.taskDepth,
			});
			return [
				context.agentName,
				String(context.taskDepth ?? ""),
				model.source,
				model.patterns.join("+"),
				model.unresolved?.value ?? "",
				effort ?? "",
			].join("|");
		})
		.join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Enumeration: the `subagent.*` settings area, read from the schema.
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaEntry {
	type: string;
	default?: unknown;
	values?: readonly string[];
}

const SUBAGENT_PATHS: SettingPath[] = Object.keys(SETTINGS_SCHEMA)
	.filter(isSettingPath)
	.filter(candidate => candidate.startsWith("subagent."))
	.sort();

/**
 * Values worth writing at a `subagent.*` path, chosen by its declared type.
 *
 * Derived from the schema so a new setting is probed with something meaningful the day it lands. The
 * model and effort candidates are deliberately REAL ones: a probe of `"xyz"` would be rejected as junk
 * and a resolver that honored the path would still look inert.
 */
function probeValuesFor(entry: SchemaEntry): unknown[] {
	switch (entry.type) {
		case "boolean":
			return [true, false];
		case "number":
			return [0, 7];
		case "string":
			return ["high", FALLBACK_MODEL];
		case "modelChain":
			return [FALLBACK_MODEL, [FALLBACK_MODEL, BLANKET_MODEL]];
		case "enum":
			return [...(entry.values ?? [])];
		case "array":
			return [[FALLBACK_MODEL]];
		case "record":
			// Every field a lane can carry, so a table that starts deciding on some OTHER
			// field name is caught the day it does. `effort` is not a lane field and must
			// stay inert; `model` and `thinkingLevel` are, and must not.
			return [
				{
					[AGENT]: {
						model: FALLBACK_MODEL,
						thinkingLevel: "high",
						effort: "high",
						enabled: true,
						maxNestedSpawnDepth: 5,
					},
				},
			];
		default:
			return [];
	}
}

/**
 * Paths whose probe moves the resolved model or effort, from a given starting store.
 *
 * `base` is the scope the sweep runs in, because which paths decide is exactly
 * what the scope switch changes. A path outside the set its scope owns is a
 * second owner by definition, and a path that decides in BOTH scopes is the
 * layering this suite exists to keep out.
 */
function pathsThatDecideWhatASubagentRuns(base: Readonly<Record<string, unknown>> = {}): SettingPath[] {
	const baseline = resolutionFingerprint(Settings.isolated({ ...base }));
	return SUBAGENT_PATHS.filter(candidate => {
		const entry: SchemaEntry = SETTINGS_SCHEMA[candidate];
		return probeValuesFor(entry).some(
			value => resolutionFingerprint(Settings.isolated({ ...base, [candidate]: value })) !== baseline,
		);
	});
}

describe("exactly one setting decides what a subagent runs, in each scope", () => {
	/**
	 * The ownership ratchet, stated as a set per scope rather than as positive cases.
	 *
	 * Per agent is the default scope, and `subagent.agents` is its only owner: the scope of every
	 * value in it is one agent. `subagent.sharedModel` appears because flipping it is what moves
	 * the roster to the other scope — that is the switch working, not a second owner, and the case
	 * below pins what it switches TO. Any other `subagent.*` path reaching either resolver here
	 * turns this RED.
	 */
	it("names one owner for the per-agent scope, and finds no second", () => {
		expect(pathsThatDecideWhatASubagentRuns()).toEqual(["subagent.agents", "subagent.sharedModel"]);
	});

	/**
	 * The other half of the ratchet, and the whole reason the switch could come back.
	 *
	 * On shared scope the blanket pair owns both axes and `subagent.agents` decides NOTHING. A lane
	 * that kept deciding here is the original defect exactly: two surfaces answering for one agent,
	 * with the roster showing a model no spawn uses. Pinned by equality in both directions, so a
	 * lane creeping back into the chain turns this RED rather than merely losing a race.
	 */
	it("names the blanket pair for the shared scope, and no lane", () => {
		expect(pathsThatDecideWhatASubagentRuns({ "subagent.sharedModel": true })).toEqual([
			"subagent.model",
			"subagent.sharedModel",
			"subagent.thinkingLevel",
		]);
	});

	/**
	 * The sweep's own control. Without it a fingerprint that never changes — a resolver call that threw
	 * and was swallowed, a probe generator that produced nothing — passes the case above by finding
	 * nothing at all.
	 */
	it("has a fingerprint that actually moves", () => {
		const baseline = resolutionFingerprint(Settings.isolated());

		expect(
			resolutionFingerprint(Settings.isolated({ "subagent.agents": { [AGENT]: { model: BLANKET_MODEL } } })),
		).not.toBe(baseline);
		expect(
			resolutionFingerprint(Settings.isolated({ "subagent.agents": { [AGENT]: { thinkingLevel: "low" } } })),
		).not.toBe(baseline);
		expect(SUBAGENT_PATHS.length).toBeGreaterThan(10);
		expect(SUBAGENT_PATHS).toContain("subagent.agents");
	});

	/**
	 * `subagent.modelByDepth` keyed a chain to a spawn depth rather than to an agent, so it decided
	 * for whatever agent happened to run there. Neither scope has a reading of that, so a value left
	 * in it from an earlier release must reach no layer in either.
	 */
	it("ignores the depth-keyed chain in both scopes", () => {
		for (const sharedModel of [false, true]) {
			const stale = Settings.isolated({
				"subagent.sharedModel": sharedModel,
				"subagent.modelByDepth": { "1": DEPTH_MODEL },
			});
			const clean = Settings.isolated({ "subagent.sharedModel": sharedModel });
			for (const taskDepth of [undefined, 1, 2]) {
				const a = resolveSubagentModel({
					settings: clean,
					agentName: AGENT,
					agentModel: FRONTMATTER_MODEL,
					taskDepth,
				});
				const b = resolveSubagentModel({
					settings: stale,
					agentName: AGENT,
					agentModel: FRONTMATTER_MODEL,
					taskDepth,
				});
				expect(b.patterns, `shared ${sharedModel} depth ${taskDepth}`).toEqual(a.patterns);
				expect(b.source, `shared ${sharedModel} depth ${taskDepth}`).toBe(a.source);
			}
		}
	});

	/**
	 * The switch is EXCLUSIVE, not a layer above the lane. While it is on, a lane that names a model
	 * and an effort decides neither — which is what lets the roster stop drawing those rows without
	 * hiding a value that still wins. The same lane is read back out of the shared-scope store to
	 * prove the value was kept rather than cleared on the way in, and the off-scope store proves it
	 * decides again.
	 */
	it("puts a lane back in charge when the switch is off, having kept its value", () => {
		const lane = { [AGENT]: { model: BLANKET_MODEL, thinkingLevel: ThinkingLevel.Low } };
		const on = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.model": DEPTH_MODEL,
			"subagent.agents": lane,
		});
		const off = Settings.isolated({
			"subagent.sharedModel": false,
			"subagent.model": DEPTH_MODEL,
			"subagent.agents": lane,
		});

		const shared = resolveSubagentModel({ settings: on, agentName: AGENT, taskDepth: 1 });
		expect(shared.patterns).toEqual([DEPTH_MODEL]);
		expect(shared.source).toBe("shared");
		// Kept, not cleared: turning the switch on must not cost the operator the
		// per-agent choices they made before it.
		expect(on.get("subagent.agents")).toEqual(lane);

		const perAgent = resolveSubagentModel({ settings: off, agentName: AGENT, taskDepth: 1 });
		expect(perAgent.patterns).toEqual([BLANKET_MODEL]);
		expect(perAgent.source).toBe("lane");
		expect(resolveSubagentThinkingLevel({ settings: off, agentName: AGENT, taskDepth: 1 })).toBe(ThinkingLevel.Low);
	});

	/**
	 * The scope is off, not empty. A shared scope whose chain names nothing runs every agent on the
	 * default model role at the documented effort — it does NOT reach past the switch for a lane or
	 * a definition, which is the fall-through that reopens the ladder the switch replaced. Asserted
	 * at every depth the lane chain can answer at, and against a definition too, because a
	 * fall-through would show up as `lane` at one depth and `frontmatter` at another.
	 */
	it("runs the documented default when the shared scope names nothing", () => {
		const store = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.agents": {
				[AGENT]: { model: BLANKET_MODEL, thinkingLevel: ThinkingLevel.High, subagents: { model: DEPTH_MODEL } },
			},
		});
		store.setModelRole("default", SESSION_MODEL);

		for (const taskDepth of [undefined, 1, 2]) {
			const resolved = resolveSubagentModel({
				settings: store,
				agentName: AGENT,
				agentModel: FRONTMATTER_MODEL,
				taskDepth,
			});
			expect(resolved.source, `depth ${taskDepth}`).toBe("default");
			expect(resolved.patterns, `depth ${taskDepth}`).toEqual([SESSION_MODEL]);
			expect(
				resolveSubagentThinkingLevel({ settings: store, agentName: AGENT, taskDepth }),
				`depth ${taskDepth}`,
			).toBe(AGENT_DEFAULT_EFFORT);
		}
	});

	/**
	 * The shared scope carries a CHAIN, not one model, and keeps its order. A build that read only a
	 * single string would silently drop every fallback under the first entry while still answering
	 * `shared`, so the resolved patterns are pinned rather than the source alone.
	 */
	it("keeps the shared chain in order, and says the shared scope decided", () => {
		const store = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.model": [FALLBACK_MODEL, FRONTMATTER_MODEL],
			"subagent.agents": { [AGENT]: { model: BLANKET_MODEL } },
		});

		const resolved = resolveSubagentModel({ settings: store, agentName: AGENT, taskDepth: 1 });

		expect(resolved.source).toBe("shared");
		expect(resolved.patterns).toEqual([FALLBACK_MODEL, FRONTMATTER_MODEL]);
	});

	/**
	 * The union a provider surface reads names every chain a spawn can land on WITHOUT anyone
	 * editing a setting: the default model role, the shared chain, and each lane at every level.
	 * Both scopes are in it deliberately — the switch is one keystroke, and re-annotating providers
	 * on it would make the badges flicker — so a chain missing from the union is a provider
	 * `/account status` never mentions. Pinned by equality, in both scope states.
	 */
	it("names every chain a spawn can land on, in both scopes", () => {
		for (const sharedModel of [false, true]) {
			const store = Settings.isolated({
				"subagent.sharedModel": sharedModel,
				"subagent.model": [FALLBACK_MODEL, FRONTMATTER_MODEL],
				"subagent.agents": { [AGENT]: { model: BLANKET_MODEL, subagents: { model: DEPTH_MODEL } } },
			});
			store.setModelRole("default", SESSION_MODEL);

			expect(configuredSubagentModelChains(store), `shared ${sharedModel}`).toEqual([
				SESSION_MODEL,
				[FALLBACK_MODEL, FRONTMATTER_MODEL],
				BLANKET_MODEL,
				DEPTH_MODEL,
			]);
		}
	});

	/**
	 * Effort follows the model's scope rather than its own. A switch that moved every agent's model
	 * and left each agent's effort behind would run the shared model at whatever level the hidden
	 * per-agent row named, which is a value on nobody's screen deciding what a spawn costs.
	 */
	it("moves effort with the model when the scope changes", () => {
		const agents = { [AGENT]: { thinkingLevel: ThinkingLevel.High } };
		const on = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.thinkingLevel": ThinkingLevel.Low,
			"subagent.agents": agents,
		});
		const off = Settings.isolated({
			"subagent.sharedModel": false,
			"subagent.thinkingLevel": ThinkingLevel.Low,
			"subagent.agents": agents,
		});

		expect(resolveSubagentThinkingLevel({ settings: on, agentName: AGENT, taskDepth: 1 })).toBe(ThinkingLevel.Low);
		expect(resolveSubagentThinkingLevel({ settings: off, agentName: AGENT, taskDepth: 1 })).toBe(ThinkingLevel.High);
	});

	/**
	 * Precedence is total and stated once. Two layers being right in isolation says nothing about
	 * which wins when both are set, which is the exact question the deleted table got wrong.
	 */
	it("orders the lane over frontmatter, and frontmatter over the default", () => {
		const lane = Settings.isolated({ "subagent.agents": { [AGENT]: { model: BLANKET_MODEL } } });
		const nothing = Settings.isolated();
		nothing.setModelRole("default", SESSION_MODEL);

		expect(
			resolveSubagentModel({ settings: lane, agentName: AGENT, agentModel: FRONTMATTER_MODEL }).patterns,
		).toEqual([BLANKET_MODEL]);
		expect(
			resolveSubagentModel({ settings: nothing, agentName: AGENT, agentModel: FRONTMATTER_MODEL }).patterns,
		).toEqual([FRONTMATTER_MODEL]);
		expect(resolveSubagentModel({ settings: nothing, agentName: AGENT }).patterns).toEqual([SESSION_MODEL]);
	});

	/**
	 * A lane changes ONE agent. This is the contract the scope change exists for, so it is asserted
	 * against a second agent in the same store rather than inferred from the layer name.
	 */
	it("leaves every other agent where it was", () => {
		const store = Settings.isolated({ "subagent.agents": { [AGENT]: { model: BLANKET_MODEL } } });
		store.setModelRole("default", SESSION_MODEL);

		expect(resolveSubagentModel({ settings: store, agentName: AGENT }).patterns).toEqual([BLANKET_MODEL]);
		const other = resolveSubagentModel({ settings: store, agentName: "reviewer" });
		expect(other.patterns).toEqual([SESSION_MODEL]);
		expect(other.source).toBe("default");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-agent table: which fields a lane owns, and no others.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field names a per-agent row could plausibly carry, derived from the schema's own `subagent.*` leaf
 * names plus the lane's own three and one name it must NOT answer to.
 *
 * Derived rather than listed so that adding `subagent.somethingNew` also probes
 * `subagent.agents.<name>.somethingNew`, which is how an unowned second layer would arrive: as the
 * row twin of a blanket setting someone just added, with no page showing it.
 */
const ROW_FIELDS: string[] = [
	...new Set([
		...SUBAGENT_PATHS.map(candidate => candidate.slice(candidate.lastIndexOf(".") + 1)),
		"model",
		"thinkingLevel",
		// The recursion, which is a lane field and no `subagent.*` path's leaf name.
		"subagents",
		// A plausible synonym nothing may answer to: one page, one spelling.
		"effort",
	]),
].sort();

/**
 * Every probe value any `subagent.*` type produces, plus a lane-shaped one.
 *
 * The lane shape is what makes `subagents` a real probe rather than an empty object: a nested lane
 * decides for the depth below, so a value with nothing in it would report the recursion inert.
 */
const ROW_VALUES: unknown[] = [
	...new Set(SUBAGENT_PATHS.flatMap(candidate => probeValuesFor(SETTINGS_SCHEMA[candidate]))),
	{ enabled: true, model: FALLBACK_MODEL, thinkingLevel: "high" },
];

function rowSettings(field: string, value: unknown): Settings {
	return Settings.isolated({ "subagent.agents": { [AGENT]: { [field]: value } } });
}

/**
 * Row fields that move `read`'s answer for the probed agent.
 *
 * A throw counts as a moved answer, not as a crashed sweep: refusing a junk depth is an observable
 * behaviour of that field, and swallowing it would let a resolver that started throwing on a retired
 * model field look inert.
 */
function rowFieldsThatChange(read: (store: Settings) => string): string[] {
	const answer = (store: Settings): string => {
		try {
			return read(store);
		} catch (error) {
			return `threw: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	const baseline = answer(Settings.isolated());
	return ROW_FIELDS.filter(field => ROW_VALUES.some(value => answer(rowSettings(field, value)) !== baseline));
}

describe("a per-agent row decides exactly what its own page shows", () => {
	const scout: AgentDefinition = { name: AGENT, source: "bundled" } as AgentDefinition;

	/**
	 * The headline, inverted from what it was and pinned in both directions.
	 *
	 * A lane owns four things because its page shows four rows: Enabled, Model, Effort, Subagents.
	 * Equality is the whole point — a fifth field that moves the answer is a layer with no page,
	 * which is the defect this suite was written for, and a missing one is a page that shows a
	 * value it cannot change.
	 */
	it("moves the resolved answer for exactly the fields its page edits", () => {
		expect(rowFieldsThatChange(resolutionFingerprint)).toEqual(["model", "subagents", "thinkingLevel"]);
		// The sweep is only worth anything if it is actually writing rows the reader can see.
		expect(ROW_FIELDS).toContain("effort");
		expect(ROW_FIELDS).toContain("maxNestedSpawnDepth");
		expect(ROW_VALUES.length).toBeGreaterThan(5);
	});

	/**
	 * `enabled` and the depth ceiling are the other two axes, and they are separate from what the
	 * lane RUNS: a row that started changing the model through its enablement field would pass the
	 * case above by accident.
	 */
	it("owns enablement and the spawn ceiling on their own axes", () => {
		expect(rowFieldsThatChange(store => String(isSubagentEnabled(store, scout)))).toEqual(["enabled"]);
		expect(rowFieldsThatChange(store => String(resolveSubagentMaxNestedSpawnDepth(store, AGENT)))).toEqual([
			"maxNestedSpawnDepth",
			"subagents",
		]);
	});

	/**
	 * A lane REPLACES the blanket chain rather than truncating it, and the whole lane chain is
	 * kept in order. The failure this guards is the one the layer had before it was removed: a
	 * single-model row silently stripping every fallback beneath it while claiming the blanket
	 * source.
	 */
	it("keeps a lane's own chain in order, and says the lane decided", () => {
		const store = Settings.isolated({
			"subagent.agents": { [AGENT]: { model: [FALLBACK_MODEL, FRONTMATTER_MODEL] } },
		});

		const resolved = resolveSubagentModel({ settings: store, agentName: AGENT });

		expect(resolved.source).toBe("lane");
		expect(resolved.patterns).toEqual([FALLBACK_MODEL, FRONTMATTER_MODEL]);
		expect(subagentModelSourceLabel(resolved.source, AGENT, resolved.depth)).toBe(`subagent.agents.${AGENT}`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Which layer answered.
// ─────────────────────────────────────────────────────────────────────────────

describe("the layer that chose a subagent's model is one of exactly four", () => {
	/**
	 * Enumerated by driving the resolver over every combination rather than by reading the union: a
	 * fourth member added to the type is only a defect once something can produce it, and a fourth
	 * member produced without being added to the type is the same defect with no type error.
	 *
	 * The retired keys are swept alongside the live ones so a resolver that started reading one
	 * again produces a layer this list does not name.
	 */
	function producedSources(): SubagentModelSource[] {
		const produced = new Set<SubagentModelSource>();
		for (const blanket of [undefined, BLANKET_MODEL, "@no-such-role"]) {
			for (const row of [undefined, { enabled: true }, { model: FALLBACK_MODEL, thinkingLevel: "high" }]) {
				for (const nested of [undefined, DEPTH_MODEL]) {
					for (const frontmatter of [undefined, FRONTMATTER_MODEL]) {
						for (const defaultRole of [undefined, SESSION_MODEL]) {
							for (const taskDepth of [undefined, 1, 2]) {
								const store = Settings.isolated({
									...(blanket ? { "subagent.sharedModel": true, "subagent.model": blanket } : {}),
									...(row || nested
										? {
												"subagent.agents": {
													[AGENT]: { ...(row ?? {}), ...(nested ? { subagents: { model: nested } } : {}) },
												},
											}
										: {}),
								});
								if (defaultRole) store.setModelRole("default", defaultRole);
								produced.add(
									resolveSubagentModel({
										settings: store,
										agentName: AGENT,
										agentModel: frontmatter,
										taskDepth,
									}).source,
								);
							}
						}
					}
				}
			}
		}
		return [...produced].sort();
	}

	it("produces shared, lane, frontmatter and default, and nothing else", () => {
		expect(producedSources()).toEqual(["default", "frontmatter", "lane", "shared"]);
	});

	/**
	 * The depth-keyed chain must reach NO layer. Without this, a regression that let
	 * `subagent.modelByDepth` back into the chain still produces only members the list above names,
	 * because it would answer as one of them, and the sweep stays green.
	 */
	it("resolves the same with and without the depth-keyed chain set", () => {
		const clean = Settings.isolated();
		clean.setModelRole("default", SESSION_MODEL);
		const stale = Settings.isolated({ "subagent.modelByDepth": { "1": DEPTH_MODEL } });
		stale.setModelRole("default", SESSION_MODEL);

		for (const taskDepth of [undefined, 1, 2]) {
			const a = resolveSubagentModel({ settings: clean, agentName: AGENT, taskDepth });
			const b = resolveSubagentModel({ settings: stale, agentName: AGENT, taskDepth });
			expect(b.source, `depth ${taskDepth}`).toBe(a.source);
			expect(b.patterns, `depth ${taskDepth}`).toEqual(a.patterns);
		}
	});

	/**
	 * Each layer is named by the setting an operator can go and change. The lane's label is the path
	 * through the pages that set it — `subagent.agents.<name>`, then one `.subagents` per level down
	 * — because a lane refusal has to point at the page that decided rather than at the table.
	 */
	it("names a real setting for every layer", () => {
		const labels: Record<SubagentModelSource, string> = {
			shared: subagentModelSourceLabel("shared", AGENT),
			lane: subagentModelSourceLabel("lane", AGENT, 0),
			frontmatter: subagentModelSourceLabel("frontmatter", AGENT),
			default: subagentModelSourceLabel("default", AGENT),
		};

		// The blanket layer answers for every agent, so its label must NOT name one:
		// a refusal reading `subagent.model for scout` sends the operator to scout's
		// page, which is not drawn while that layer is the one deciding.
		expect(labels.shared).toContain("subagent.model");
		expect(labels.shared).not.toContain(AGENT);
		expect(labels.lane).toBe(`subagent.agents.${AGENT}`);
		expect(subagentModelSourceLabel("lane", AGENT, 2)).toBe(`subagent.agents.${AGENT}.subagents.subagents`);
		expect(labels.frontmatter).toContain("frontmatter");
		expect(labels.default).toContain("default model role");
		expect(new Set(Object.values(labels)).size).toBe(4);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The screen.
// ─────────────────────────────────────────────────────────────────────────────

function buildSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
			modelRegistry: {} as ModelRegistry,
			availableModels: [],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

interface AgentEditor {
	component: SettingsSelectorComponent;
	frame(): string[];
	/** The rows the operator can actually move to and press Enter on, in list order. */
	rows(): string[];
	/** Walk to the row whose label starts with `label` and press Enter on it. */
	enter(label: string): void;
	escape(): void;
}

/**
 * The right-hand column of one panel row.
 *
 * The settings panel is two columns inside a box, so a frame line is `│ tabs │ content │`. The tab
 * column carries its own `›` for the highlighted tab, and reading the whole line finds that one first.
 */
function contentColumn(line: string): string {
	const columns = line.split("│");
	return columns.length >= 3 ? columns[2] : "";
}

/** Drive Settings → Subagents → Agents → <agent> the way an operator reaches it. */
async function openAgentEditor(agentName: string): Promise<AgentEditor> {
	const component = buildSelector();
	component.openTab("subagents");
	expect(component.selectSetting("subagent.agents")).toBe(true);
	component.handleInput("\n");
	const frame = (): string[] => component.render(140).map(stripVTControlCharacters);
	const content = (): string[] => frame().map(contentColumn);
	/**
	 * The highlighted row's text, or undefined when nothing in the pane is a list.
	 *
	 * The marker is `›` at the START of the row, and the test cannot look for `›` anywhere in the
	 * line: a nested lane page titles itself `scout › subagents`, and that breadcrumb sorts above
	 * the rows, so a substring match reads the title as the selection and every walk lands on it.
	 */
	const selectedRow = (): string | undefined =>
		content()
			.map(line => line.trim())
			.find(line => line.startsWith("›"))
			?.slice(1)
			.trim();
	// Agent discovery is filesystem IO started in the submenu's constructor and it exposes no
	// settled signal, so there is nothing to await and no clock to fake. Yielding the event loop
	// lets the IO completion run without a wall-clock delay tuned to "long enough"; the bound is
	// an iteration count, so a discovery that never completes fails fast instead of hanging.
	for (let spin = 0; !content().some(line => line.includes(agentName)); spin++) {
		if (spin > 20_000) throw new Error(`agent discovery never listed ${agentName}:\n${frame().join("\n")}`);
		await setImmediate();
	}
	// Walk to the row by name: the roster is alphabetical, so a fixed number of Down presses
	// configures whichever agent happens to sort first.
	for (let step = 0; ; step++) {
		if (selectedRow()?.startsWith(agentName)) break;
		if (step > 64) throw new Error(`never landed on the ${agentName} row`);
		component.handleInput("\u001b[B");
	}
	component.handleInput("\n");

	/**
	 * Enumerate the editor's rows by walking the list rather than by pattern-matching the frame. The
	 * screen also prints what the lane RUNS above the rows, and that sentence carries the words
	 * "Model" and "Effort" — a text scan would read the preview as a control.
	 */
	const rows = (): string[] => {
		const seen: string[] = [];
		for (let step = 0; step < 16; step++) {
			const label = selectedRow();
			if (label === undefined || seen.includes(label)) break;
			seen.push(label);
			component.handleInput("\u001b[B");
		}
		return seen;
	};
	// The list wraps, so a bounded walk is the only honest way to land on a named row: pressing
	// Down a fixed number of times lands wherever the roster happens to sort that row.
	const enter = (label: string): void => {
		for (let step = 0; step <= 16; step++) {
			if (selectedRow()?.startsWith(label)) {
				component.handleInput("\n");
				return;
			}
			component.handleInput("\u001b[B");
		}
		throw new Error(`never landed on the ${label} row:\n${frame().join("\n")}`);
	};
	const goBack = (): void => component.handleInput("\u001b");
	return { component, frame, rows, enter, escape: goBack };
}

describe("every row the lane page shows is a row the lane page changes", () => {
	/**
	 * The editor's rows, pinned by exact equality.
	 *
	 * This is the fail-by-default half of the ownership class that no resolver sweep can provide.
	 * It used to read the other way — the Model and Effort rows were DELETED, because they wrote a
	 * value that outranked a setting edited on another screen. The rows are back and the rule that
	 * replaced the deletion is this one: a row here shows a lane's own value and opens the control
	 * that changes that same value. A row showing an answer decided elsewhere is the old defect;
	 * so is a row that writes a value nothing reads, and equality catches both.
	 */
	it("offers exactly Enabled, Model, Effort and Subagents", async () => {
		const editor = await openAgentEditor(AGENT);

		const rows = editor.rows();
		expect(rows.map(row => row.split(/\s{2,}/)[0]?.trim())).toEqual(["Enabled", "Model", "Effort", "Subagents"]);
	});

	/**
	 * And the rows lead somewhere. Pinning the labels alone would pass with four inert rows, which
	 * is the exact shape of "a screen that shows a value it cannot change".
	 */
	it("opens a control from the Model row and from the Effort row", async () => {
		const editor = await openAgentEditor(AGENT);

		editor.enter("Model");
		// The chain editor opens on the model picker while the lane's chain is empty, and it titles
		// itself with the lane it will write. What is under test is that the row REACHES the editor
		// bound to THIS lane, not what the harness's empty catalog can list.
		expect(editor.frame().join("\n")).toContain(`Model · ${AGENT}`);
		editor.escape();

		editor.enter("Effort");
		const effortScreen = editor.frame().join("\n");
		expect(effortScreen).toContain(`Effort · ${AGENT}`);
		expect(effortScreen).toContain("Inherit");
	});

	/**
	 * The recursion, driven rather than asserted from the type: the nested page is the same page,
	 * and its rows edit the nested lane rather than the agent's own. A nested page that showed the
	 * parent's value would be the two-screens defect one level down, so the page says which level
	 * it is and its Model row says what unset means here.
	 */
	it("recurses into a nested lane with the same four rows", async () => {
		const editor = await openAgentEditor(AGENT);

		editor.enter("Subagents");
		const nested = editor.rows();

		expect(nested.map(row => row.split(/\s{2,}/)[0]?.trim())).toEqual(["Enabled", "Model", "Effort", "Subagents"]);
		const screen = editor.frame().join("\n");
		expect(screen).toContain(`${AGENT} › subagents`);
		expect(screen).toContain("inherit · the level above");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The stale copy on disk.
// ─────────────────────────────────────────────────────────────────────────────

const makeStaleRowDir = useTrackedTempDirs("veyyon-stale-agent-row-");

describe("a config written before the lane tree", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeStaleRowDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "stale-agent-row"));
			agentDir = "";
		}
	});

	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	/**
	 * Through the REAL loader, not `Settings.isolated`. A persisted shape is how a fixed bug comes back:
	 * the value survives the release that changed the code reading it, and the next reader has to decide
	 * what to do with it. Reading it back once proves nothing about the second load, so both are checked.
	 *
	 * The old per-agent row is the LANE now, so a file written before the tree resolves to that row's
	 * model and effort — the same answer it got when it was written, from a path that now has a page.
	 */
	it("keeps the answer a pre-tree row asked for, on the first load and on the stale reload", async () => {
		writeConfig({
			subagent: {
				model: BLANKET_MODEL,
				thinkingLevel: "low",
				agents: { [AGENT]: { enabled: true, model: FALLBACK_MODEL, thinkingLevel: "max" } },
			},
		});

		for (const pass of ["first load", "stale reload"]) {
			const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			const model = resolveSubagentModel({
				settings: store,
				agentName: AGENT,
				agentModel: FRONTMATTER_MODEL,
			});

			expect(model.patterns, pass).toEqual([FALLBACK_MODEL]);
			expect(model.source, pass).toBe("lane");
			expect(resolveSubagentThinkingLevel({ settings: store, agentName: AGENT }), pass).toBe(ThinkingLevel.Max);
			expect(isSubagentEnabled(store, { name: AGENT, source: "bundled" } as AgentDefinition), pass).toBe(true);
		}
	});

	/**
	 * EVERY superseded field in the table is named, not just the one belonging to whichever agent
	 * happened to spawn, and not just the first one found. The report used to be scoped to the resolving
	 * agent, so a leftover on a DISABLED agent was never mentioned: that agent never resolves, so the
	 * value sat in the operator's config looking configured, which is the exact state the report exists
	 * to end. An operator cannot be expected to enable an agent in order to find out its setting moved.
	 * Two agents carry leftovers here rather than one, because a dedupe keyed on the field alone
	 * silences every agent after the first and a single-agent case cannot see it.
	 */
	it("names every superseded field in the table, on agents that never spawn as well", async () => {
		const leftovers = Object.fromEntries(SUPERSEDED_AGENT_ROW_FIELDS.map(field => [field, 2]));
		writeConfig({
			subagent: {
				agents: {
					[AGENT]: { enabled: true, ...leftovers },
					designer: { enabled: false, ...leftovers },
					librarian: { enabled: false },
				},
			},
		});
		const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		resetSupersededAgentRowReports();
		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			resolveSubagentModel({ settings: store, agentName: AGENT });
			resolveSubagentThinkingLevel({ settings: store, agentName: AGENT });
		} finally {
			warn.mockRestore();
		}

		const expected = Object.fromEntries(
			[AGENT, "designer"].flatMap(agent =>
				SUPERSEDED_AGENT_ROW_FIELDS.map(field => [`subagent.agents.${agent}.${field}`, 1]),
			),
		);
		const counted = Object.fromEntries(
			Object.keys(expected).map(setting => [setting, warnings.filter(message => message.includes(setting)).length]),
		);

		expect(counted).toEqual(expected);
		// The agent whose row carries nothing superseded is not mentioned at all.
		expect(warnings.filter(message => message.includes("subagent.agents.librarian"))).toEqual([]);
		// A live lane field is not a leftover, and must never be reported as one.
		expect(warnings.filter(message => message.includes(".model") || message.includes(".thinkingLevel"))).toEqual([]);
	});

	/**
	 * Named once per field, with the control that replaced it. Once per field and not once per spawn:
	 * this runs on every resolution, and a report per spawn is a log flood that gets filtered out and
	 * then never read.
	 */
	it("names each superseded field once, however many times a spawn resolves", async () => {
		writeConfig({ subagent: { agents: { [AGENT]: { maxNestedSpawnDepth: 2 } } } });
		const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		resetSupersededAgentRowReports();
		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			for (let spawn = 0; spawn < 25; spawn++) {
				resolveSubagentModel({ settings: store, agentName: AGENT });
				resolveSubagentThinkingLevel({ settings: store, agentName: AGENT });
			}
		} finally {
			warn.mockRestore();
		}

		const reported = warnings.filter(message => message.includes(`subagent.agents.${AGENT}`));
		expect(reported.length).toBe(1);
		expect(reported[0]).toContain("Subagents");
		expect(reported[0]).toContain("no screen writes");
		// Reported is not ignored: the ceiling the file asked for is still the one in force.
		expect(resolveSubagentMaxNestedSpawnDepth(store, AGENT)).toBe(2);
	});

	/** A blank lane value is what a cleared picker stored, so nobody is losing a value and nobody is told. */
	it("says nothing about a blank lane field", async () => {
		writeConfig({ subagent: { agents: { [AGENT]: { model: "", thinkingLevel: "   " } } } });
		const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		resetSupersededAgentRowReports();
		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			resolveSubagentModel({ settings: store, agentName: AGENT });
			resolveSubagentThinkingLevel({ settings: store, agentName: AGENT });
		} finally {
			warn.mockRestore();
		}

		expect(warnings.filter(message => message.includes(`subagent.agents.${AGENT}`))).toEqual([]);
	});

	/**
	 * The superseded number survives an unrelated edit and dies the moment the control that replaced
	 * it is used. Dropping it on the toggle would silently lower the ceiling the file asked for;
	 * keeping it after a chain exists would leave a dead value in the operator's file that used to
	 * decide. Both halves are asserted, because each is the tempting simplification of the other.
	 */
	it("keeps the superseded number until the chain replaces it", async () => {
		const staleRow: SubagentAgentSettings = {
			enabled: false,
			model: FALLBACK_MODEL,
			thinkingLevel: "max",
		};
		Object.assign(staleRow, { maxNestedSpawnDepth: 2 });
		settings.set("subagent.agents", { [AGENT]: staleRow });

		const editor = await openAgentEditor(AGENT);
		// The editor opens on the Enabled row; Enter toggles the lane and writes the row back.
		editor.component.handleInput("\n");

		expect(settings.get("subagent.agents")?.[AGENT]).toEqual({
			enabled: true,
			model: FALLBACK_MODEL,
			thinkingLevel: "max",
			maxNestedSpawnDepth: 2,
		});
		expect(resolveSubagentMaxNestedSpawnDepth(settings, AGENT)).toBe(2);
		expect(resolveSubagentModel({ settings, agentName: AGENT }).patterns).toEqual([FALLBACK_MODEL]);

		// Now use the control the report named: Subagents → Enabled.
		editor.enter("Subagents");
		editor.enter("Enabled");

		const row = settings.get("subagent.agents")?.[AGENT];
		expect(row?.subagents).toBeDefined();
		expect(row).not.toHaveProperty("maxNestedSpawnDepth");
	});
});

/**
 * The last seam before a subagent runs. `resolveEffectiveSubagentThinkingLevel` picks between the level
 * the caller already resolved and the one a `:level` suffix on the model pattern carried, and its own
 * doc comment names the defect it must not develop: re-applying a layer behind the caller, which is how
 * one axis came to have two answers. It takes no settings, and this is what holds it to that: it is
 * swept over the whole level space with a config that holds a DIFFERENT level in every settings layer,
 * so a lookup added here shows up as an answer nobody passed in.
 */
describe("the effort a spawn finally runs at answers only from what it was handed", () => {
	const SETTINGS_LEVEL = ThinkingLevel.XHigh;

	beforeEach(() => {
		const leftover: SubagentAgentSettings = {};
		Object.assign(leftover, { thinkingLevel: SETTINGS_LEVEL, model: `${FALLBACK_MODEL}:${SETTINGS_LEVEL}` });
		settings.set("subagent.thinkingLevel", SETTINGS_LEVEL);
		settings.set("subagent.agents", { [AGENT]: leftover });
	});

	it("never returns a level that came from the settings instead of the arguments", () => {
		const candidates: Array<ConfiguredThinkingLevel | undefined> = [
			undefined,
			...CONFIGURED_THINKING_LEVELS.filter(level => level !== SETTINGS_LEVEL),
		];
		const invented: string[] = [];

		for (const explicit of [true, false]) {
			for (const resolved of candidates) {
				for (const configured of candidates) {
					const answer = resolveEffectiveSubagentThinkingLevel(explicit, resolved, configured);
					if (answer !== undefined && answer !== resolved && answer !== configured) {
						invented.push(`${explicit}/${String(resolved)}/${String(configured)} -> ${String(answer)}`);
					}
				}
			}
		}

		// The sweep must be wide enough to be worth anything: two suffix states times the whole ladder.
		expect(candidates.length).toBe(CONFIGURED_THINKING_LEVELS.length);
		expect(invented).toEqual([]);
	});

	/**
	 * And the caller's resolved level is what runs unless the pattern carried an explicit suffix. Without
	 * this the case above passes on a function that always answers `undefined`.
	 */
	it("prefers the suffix when there is one and the resolved level when there is not", () => {
		expect(resolveEffectiveSubagentThinkingLevel(true, ThinkingLevel.High, ThinkingLevel.Low)).toBe(
			ThinkingLevel.High,
		);
		expect(resolveEffectiveSubagentThinkingLevel(false, ThinkingLevel.High, ThinkingLevel.Low)).toBe(
			ThinkingLevel.Low,
		);
		expect(resolveEffectiveSubagentThinkingLevel(false, ThinkingLevel.High, undefined)).toBe(ThinkingLevel.High);
	});
});
