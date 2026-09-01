/**
 * WHY THIS SUITE EXISTS (CROSS-AGENT MODEL AND EFFORT — THE WHOLE CLASS).
 *
 * Model and effort used to be choosable for MANY agents at once:
 * `subagent.sharedModel` put every agent on `subagent.model` and
 * `subagent.thinkingLevel`, `subagent.modelByDepth` bound a chain to a spawn
 * depth whatever agent ran there, and an unconfigured agent followed the LIVE
 * session model, so a keystroke aimed at the main assistant moved the whole
 * roster with it. "I changed the model" and "my subagents changed model" were
 * the same event, and nothing on screen said which one had happened.
 *
 * There are two scopes now, and `subagent.sharedModel` selects which one is in
 * force rather than layering them. This suite defends that as an invariant
 * rather than as a list of keys:
 *
 *  1. WITH THE SWITCH OFF, NO `subagent.*` SETTING OUTSIDE `subagent.agents`
 *     MAY CHANGE WHAT AN AGENT RESOLVES TO — and with it on, none outside the
 *     three keys the switch owns. The sweep reads the schema at run time in
 *     both scopes, so a new global model or effort knob added under `subagent.`
 *     turns this file red the day it is declared, with no list to remember.
 *  2. A lane moves exactly the agent it names, on both axes, while the switch
 *     is off, and moves nobody while it is on.
 *  3. The shared scope is all-or-nothing: on, every agent runs the blanket
 *     chain at the blanket effort.
 *  4. Every agent resolves to a CONCRETE model and a CONCRETE effort with
 *     nothing configured, from the documented default rather than from whatever
 *     the operator happens to be looking at.
 *  5. The depth-keyed key still loads, still gets named, and decides nothing.
 *
 * The probe machinery is proved by a negative control before it is trusted: the
 * same comparison that reports "nothing moved" for every swept key must report
 * "one agent moved" for a lane. Without it, a sweep that silently resolved
 * nothing would pass while measuring air.
 *
 * WHAT THIS DOES NOT CATCH: a spawn site that resolves a model some other way
 * instead of calling `resolveSubagentModel`. That is a wiring question reviewed
 * per caller; the resolver cannot see a caller that never asks it.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getDefault, getType, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import {
	AGENT_DEFAULT_EFFORT,
	RETIRED_SUBAGENT_MODEL_SETTINGS,
	rejectedSubagentModelSettings,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
} from "@veyyon/coding-agent/task/subagent-settings";

/** The bundled roster plus a user-authored name, which resolves through the same chain. */
const ROSTER = ["task", "scout", "reviewer", "designer", "librarian", "sonic", "my-agent"] as const;

const PROFILE_DEFAULT = "anthropic/claude-opus-4-5";
/** A second real model, so "moved" means a different answer rather than an empty one. */
const PROBE_MODEL = "openai/gpt-5";
const PROBE_EFFORT = "minimal";

/** The scope that decides per agent. Everything else must move one agent or the whole roster. */
const PER_AGENT_PATH = "subagent.agents";

/**
 * The three keys the switch owns: the switch, and the model and effort it puts every agent on.
 * Listed once, so the sweep below and the tab check read the same set.
 */
const SHARED_SCOPE_PATHS: SettingPath[] = ["subagent.sharedModel", "subagent.model", "subagent.thinkingLevel"];

type SettingsSeed = Parameters<typeof Settings.isolated>[0];

function seeded(seed: SettingsSeed): Settings {
	const settings = Settings.isolated(seed);
	settings.setModelRole("default", PROFILE_DEFAULT);
	return settings;
}

/** What the whole roster runs, as one comparable value per agent. */
function rosterRuns(settings: Settings): Record<string, string> {
	const runs: Record<string, string> = {};
	for (const name of ROSTER) {
		const model = resolveSubagentModel({ settings, agentName: name, taskDepth: 1 });
		const effort = resolveSubagentThinkingLevel({ settings, agentName: name, taskDepth: 1 });
		runs[name] = `${model.patterns.join(",")}|${model.source}|${effort}`;
	}
	return runs;
}

/** The agents whose resolved model or effort differs between two stores. */
function moved(before: Record<string, string>, after: Record<string, string>): string[] {
	return ROSTER.filter(name => before[name] !== after[name]);
}

/**
 * A value of the right schema type that could carry a model or an effort.
 *
 * `undefined` means the type cannot express either — a concurrency number or a
 * runtime budget names no model, so writing one proves nothing. Every type that
 * CAN carry one is probed, which is what keeps the sweep honest as the schema
 * grows.
 */
function modelBearingProbe(path: SettingPath): unknown {
	switch (getType(path)) {
		case "modelChain":
			return PROBE_MODEL;
		case "string":
			// One value that is a model and one that is an effort, since a string
			// key could be either axis. The sweep runs both.
			return PROBE_MODEL;
		case "boolean":
			// A switch cannot name a model, but it can turn one on: the retired
			// shared-model switch was exactly this shape.
			return getDefault(path) !== true;
		case "record":
			return { "1": PROBE_MODEL, "2": PROBE_MODEL };
		default:
			return undefined;
	}
}

describe("the sweep can see an agent move", () => {
	/**
	 * NEGATIVE CONTROL, first, because every assertion below is an absence. A
	 * comparison that cannot detect a real change reports "nothing moved" for a
	 * store that moved everything.
	 */
	it("reports exactly the agent a lane names", () => {
		const baseline = rosterRuns(seeded({}));
		const withLane = rosterRuns(seeded({ "subagent.agents": { scout: { model: PROBE_MODEL } } } as SettingsSeed));

		expect(moved(baseline, withLane)).toEqual(["scout"]);
	});

	/** And on the effort axis, which is the axis that used to be left behind. */
	it("reports exactly the agent a lane gives an effort", () => {
		const baseline = rosterRuns(seeded({}));
		const withLane = rosterRuns(
			seeded({ "subagent.agents": { reviewer: { thinkingLevel: PROBE_EFFORT } } } as SettingsSeed),
		);

		expect(moved(baseline, withLane)).toEqual(["reviewer"]);
	});
});

describe("no subagent setting outside the per-agent table and the shared trio changes what an agent runs", () => {
	const swept = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
		path =>
			path.startsWith("subagent.") &&
			path !== PER_AGENT_PATH &&
			!SHARED_SCOPE_PATHS.includes(path) &&
			modelBearingProbe(path) !== undefined,
	);

	/**
	 * The sweep is worthless if it swept nothing, and the count is not pinned because the schema is
	 * allowed to grow. What is pinned is that the retired depth key is still IN it: it is the key
	 * that used to move whoever ran at a depth, so a rename that dropped it out of the sweep would
	 * take its proof with it.
	 */
	it("covers every retired cross-agent key", () => {
		for (const path of Object.keys(RETIRED_SUBAGENT_MODEL_SETTINGS)) {
			expect(swept, `${path} must stay under the sweep`).toContain(path as SettingPath);
		}
	});

	/**
	 * Both scopes, because a knob that moved an agent only while the switch was on would be a
	 * second blanket layer hidden behind the first, which is the shape this whole file exists to
	 * keep out.
	 */
	it.each(swept)("%s moves no agent in either scope", path => {
		for (const scope of [{}, { "subagent.sharedModel": true }] as SettingsSeed[]) {
			const baseline = rosterRuns(seeded(scope));
			for (const probe of [modelBearingProbe(path), PROBE_EFFORT]) {
				const after = rosterRuns(seeded({ ...scope, [path]: probe } as SettingsSeed));
				expect(moved(baseline, after), `${path} = ${JSON.stringify(probe)} moved an agent`).toEqual([]);
			}
		}
	});
});

describe("every agent resolves to a concrete model and effort with nothing configured", () => {
	/**
	 * A stock install must answer for every agent without reading a global. The
	 * documented default is the profile's default model role at
	 * {@link AGENT_DEFAULT_EFFORT}, and both are asserted per agent so an agent
	 * that quietly resolved to nothing cannot hide inside a roster-wide check.
	 */
	it.each([...ROSTER])("%s runs the default model role at the default effort", name => {
		const settings = seeded({});

		const model = resolveSubagentModel({ settings, agentName: name, taskDepth: 1 });
		expect(model.patterns).toEqual([PROFILE_DEFAULT]);
		expect(model.source).toBe("default");
		expect(resolveSubagentThinkingLevel({ settings, agentName: name, taskDepth: 1 })).toBe(AGENT_DEFAULT_EFFORT);
	});

	/**
	 * The default effort is a real level, not the inherit sentinel. An agent that
	 * resolved to "inherit" with nothing configured is an agent whose effort is
	 * decided by whoever spawned it, which is the coupling being removed.
	 */
	it("names a real effort as the default", () => {
		expect(AGENT_DEFAULT_EFFORT).not.toBe(ThinkingLevel.Inherit);
	});
});

describe("the shared scope moves the whole roster, or nobody", () => {
	/**
	 * The blanket chain is all-or-nothing. A shared model that reached some agents and not others
	 * would be the three-surface split again: a roster showing one model per agent, and a spawn
	 * running something else for the ones the blanket happened to catch.
	 */
	it("puts every agent on the blanket chain while the switch is on", () => {
		const settings = seeded({ "subagent.sharedModel": true, "subagent.model": PROBE_MODEL } as SettingsSeed);

		expect(new Set(Object.values(rosterRuns(settings))).size).toBe(1);
		for (const name of ROSTER) {
			const resolved = resolveSubagentModel({ settings, agentName: name, taskDepth: 1 });
			expect(resolved.patterns, name).toEqual([PROBE_MODEL]);
			expect(resolved.source, name).toBe("shared");
		}
	});

	/** A lane the switch outranks moves nobody, including the agent it names. */
	it("leaves a lane deciding nothing while the switch is on", () => {
		const blanket = rosterRuns(
			seeded({ "subagent.sharedModel": true, "subagent.model": PROBE_MODEL } as SettingsSeed),
		);
		const withLane = rosterRuns(
			seeded({
				"subagent.sharedModel": true,
				"subagent.model": PROBE_MODEL,
				"subagent.agents": { scout: { model: PROFILE_DEFAULT, thinkingLevel: PROBE_EFFORT } },
			} as SettingsSeed),
		);

		expect(moved(blanket, withLane)).toEqual([]);
	});

	/** Effort travels with the model rather than staying on each agent's row. */
	it("puts every agent on the blanket effort while the switch is on", () => {
		const settings = seeded({
			"subagent.sharedModel": true,
			"subagent.thinkingLevel": PROBE_EFFORT,
			"subagent.agents": { reviewer: { thinkingLevel: ThinkingLevel.Max } },
		} as SettingsSeed);

		for (const name of ROSTER) {
			expect(resolveSubagentThinkingLevel({ settings, agentName: name, taskDepth: 1 }), name).toBe(
				ThinkingLevel.Minimal,
			);
		}
	});
});

describe("the retired depth-keyed key is named and inert", () => {
	const STALE: SettingsSeed = { "subagent.modelByDepth": { "1": PROBE_MODEL } } as SettingsSeed;

	/**
	 * An existing `config.yml` still loads. Dropping the declarations would make
	 * an old file fail to parse, which is a worse answer than reading it and
	 * saying it decides nothing.
	 */
	it("still declares every retired key", () => {
		for (const path of Object.keys(RETIRED_SUBAGENT_MODEL_SETTINGS)) {
			expect(Object.keys(SETTINGS_SCHEMA), `${path} must stay declared so an old config loads`).toContain(path);
		}
	});

	/** Listed, so a file that names a model is not read as live configuration. */
	it("lists a stale file's keys, and nothing in a clean one", () => {
		expect(rejectedSubagentModelSettings(Settings.isolated(STALE)).sort()).toEqual(
			Object.keys(RETIRED_SUBAGENT_MODEL_SETTINGS).sort(),
		);
		expect(rejectedSubagentModelSettings(Settings.isolated())).toEqual([]);
	});

	/** Inert in both scopes, since a depth names no agent in either of them. */
	it("resolves a stale profile to the documented default in either scope", () => {
		expect(moved(rosterRuns(seeded({})), rosterRuns(seeded(STALE)))).toEqual([]);
		const on: SettingsSeed = { "subagent.sharedModel": true } as SettingsSeed;
		expect(moved(rosterRuns(seeded(on)), rosterRuns(seeded({ ...on, ...STALE } as SettingsSeed)))).toEqual([]);
	});
});

describe("the Subagents tab offers cross-agent rows only under the switch that declares them", () => {
	/**
	 * Every row on the tab that names a model or an effort is one of the three the switch owns, and
	 * the two that decide are hidden while the switch is off. Read off the rows the tab actually
	 * builds, so a row reintroduced through any of the def factories is caught, and matched by path
	 * rather than by label, so renaming "Same Model for All Subagents" smuggles nothing back.
	 *
	 * `subagent.showResolvedModelBadge` is opted out by exact name: it decides whether the resolved
	 * model is PRINTED beside an agent, not what the agent runs. A new display knob lands in the
	 * list and turns this red until someone records that decision here.
	 */
	it("exposes model and effort through the per-agent table and the shared trio, and nothing else", () => {
		const displayOnly = ["subagent.showResolvedModelBadge"];
		const crossAgent = getSettingsForTab("subagents").filter(def => {
			const path = String(def.path);
			return path !== PER_AGENT_PATH && !displayOnly.includes(path) && /model|thinking/i.test(path);
		});

		expect(crossAgent.map(def => String(def.path)).sort()).toEqual([...SHARED_SCOPE_PATHS].sort());
	});

	/** And the per-agent table is on the tab, or there is nowhere left to choose one per agent. */
	it("keeps the per-agent table on the tab", () => {
		const table = getSettingsForTab("subagents").find(def => def.path === PER_AGENT_PATH);

		expect(table?.type).toBe("subagentAgents");
	});
});
