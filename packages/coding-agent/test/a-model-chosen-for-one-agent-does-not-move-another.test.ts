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
 * The scope is now the agent, and this suite defends that as an invariant rather
 * than as a list of the four keys that were removed:
 *
 *  1. NO `subagent.*` SETTING OUTSIDE `subagent.agents` MAY CHANGE WHAT AN AGENT
 *     RESOLVES TO. The sweep reads the schema at run time, so a new global model
 *     or effort knob added under `subagent.` turns this file red the day it is
 *     declared, with no list to remember to update.
 *  2. A lane moves exactly the agent it names, on both axes.
 *  3. Every agent resolves to a CONCRETE model and a CONCRETE effort with
 *     nothing configured, from the documented default rather than from whatever
 *     the operator happens to be looking at.
 *  4. The four retired keys still load, still get named, and decide nothing.
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

/** The scope that is allowed to decide a model: the per-agent table and nothing else. */
const PER_AGENT_PATH = "subagent.agents";

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

describe("no subagent setting outside the per-agent table changes what an agent runs", () => {
	const swept = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
		path => path.startsWith("subagent.") && path !== PER_AGENT_PATH && modelBearingProbe(path) !== undefined,
	);

	/**
	 * The sweep is worthless if it swept nothing, and the count is not pinned
	 * because the schema is allowed to grow. What is pinned is that the retired
	 * four are still IN it: they are the exact keys that used to move everybody,
	 * so a rename that dropped one out of the sweep would take its proof with it.
	 */
	it("covers every retired cross-agent key", () => {
		for (const path of Object.keys(RETIRED_SUBAGENT_MODEL_SETTINGS)) {
			expect(swept, `${path} must stay under the sweep`).toContain(path as SettingPath);
		}
	});

	it.each(swept)("%s moves no agent", path => {
		const baseline = rosterRuns(seeded({}));

		for (const probe of [modelBearingProbe(path), PROBE_EFFORT]) {
			const after = rosterRuns(seeded({ [path]: probe } as SettingsSeed));
			expect(moved(baseline, after), `${path} = ${JSON.stringify(probe)} moved an agent`).toEqual([]);
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

describe("the retired cross-agent keys are named and inert", () => {
	const STALE: SettingsSeed = {
		"subagent.sharedModel": true,
		"subagent.model": PROBE_MODEL,
		"subagent.thinkingLevel": PROBE_EFFORT,
		"subagent.modelByDepth": { "1": PROBE_MODEL },
	} as SettingsSeed;

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

	/** All four at once, which is what an untouched old profile actually holds. */
	it("resolves a whole stale profile to the documented default", () => {
		expect(moved(rosterRuns(seeded({})), rosterRuns(seeded(STALE)))).toEqual([]);
	});
});

describe("the Subagents settings tab offers no cross-agent model or effort row", () => {
	/**
	 * The settings tab is where the removed toggle lived, so its absence is part
	 * of the contract rather than an implementation detail. Asserted over the
	 * rows the tab actually builds, so a row reintroduced through any of the
	 * def factories is caught, and by path prefix rather than by label, so
	 * renaming "Same Model for All Agents" does not smuggle it back.
	 */
	it("exposes model and effort only through the per-agent table", () => {
		const modelRows = getSettingsForTab("subagents").filter(def => {
			const path = String(def.path);
			return path !== PER_AGENT_PATH && (path.includes("model") || path.includes("thinking"));
		});

		expect(modelRows.map(def => def.path)).toEqual([]);
	});

	/** And the per-agent table is on the tab, or there is nowhere left to choose one. */
	it("keeps the per-agent table on the tab", () => {
		const table = getSettingsForTab("subagents").find(def => def.path === PER_AGENT_PATH);

		expect(table?.type).toBe("subagentAgents");
	});
});
