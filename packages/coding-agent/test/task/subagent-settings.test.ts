/**
 * The Subagents settings area contract.
 *
 * WHY THIS SUITE EXISTS: veyyon shipped for months spawning its subagents on
 * SEVERAL DIFFERENT MODELS on a stock install, and no subagent model setting
 * could change it. Three things conspired:
 *
 *  1. the bundled agents carried role aliases in their frontmatter (`@smol` on
 *     scout/sonic, `@slow` on reviewer, `@designer` on designer, `@task` on the
 *     worker);
 *  2. role EXPANSION resolved an unset role through `priority.json` instead of
 *     reporting "this role names no model", so those aliases turned into
 *     concrete, different models even though every role picker said
 *     "inherit (follows main model)";
 *  3. the precedence chain fell silently through to the next layer whenever a
 *     configured value did not resolve, so a typo in the operator's model looked
 *     like the setting had no effect at all.
 *
 * `subagent.*` is now the one owner of every subagent question, and this suite
 * pins the behavior that fixes each of the three: one model on a stock install,
 * a precedence order that never falls through silently, and defaults that ship
 * only the general worker so nobody pays tokens for agents they did not ask for.
 *
 * Everything here asserts real values — the chosen patterns, the deciding layer,
 * the refusal text — because a shape-only check ("something resolved") is exactly
 * what let the original defect through.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { SubagentAgentSettings } from "@veyyon/coding-agent/config/settings-domains/subagents";
import { isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import {
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import {
	AGENT_DEFAULT_EFFORT,
	delegationBlockedNotice,
	delegationEnabled,
	delegationStrength,
	filterEnabledAgents,
	isSubagentEnableDefaulted,
	isSubagentEnabled,
	nextSubagentEnableValue,
	RETIRED_SUBAGENT_MODEL_SETTINGS,
	rejectedSubagentModelSettings,
	resetRejectedSubagentModelSettingReports,
	resetSupersededAgentRowReports,
	resolveDelegation,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUBAGENT_ENABLE_STATE_LABEL,
	SUPERSEDED_AGENT_ROW_FIELDS,
	type SubagentEnableState,
	type SubagentModelSource,
	type SupersededAgentRowField,
	subagentEnabledByDefault,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "@veyyon/coding-agent/task/subagent-settings";
import { type AgentDefinition, canSpawnAtDepth } from "@veyyon/coding-agent/task/types";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	CONFIGURED_THINKING_LEVELS,
	configuredThinkingLevelOptions,
	configuredThinkingLevelsForModel,
	INHERIT_EFFORT_OPTION_VALUE,
} from "@veyyon/coding-agent/thinking";
import { logger } from "@veyyon/utils";

/**
 * Collect `logger.warn` messages while a block runs, and restore the logger after.
 *
 * The reports under test are said once per process, so each case that asserts one
 * must use a value no other case uses — otherwise the second case sees nothing and
 * passes for the wrong reason.
 */
function captureLoggerWarnings(into: string[]): () => void {
	const spy = spyOn(logger, "warn").mockImplementation((message: unknown) => {
		into.push(String(message));
	});
	return () => spy.mockRestore();
}

/** A bundled agent definition, the shape `discoverAgents` returns for `prompts/agents/*.md`. */
function bundled(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `You are ${name}.`,
		source: "bundled",
		...overrides,
	};
}

/** A user-authored agent: a file the operator wrote under their `agents/` directory. */
function userAgent(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return { ...bundled(name, overrides), source: "user" };
}

describe("subagent defaults: only the general worker ships offered", () => {
	/**
	 * The default that saves the tokens. Every bundled specialist in the tool
	 * description costs input tokens on EVERY request of the session, and most
	 * sessions want to hand work to a worker and nothing else.
	 */
	it("offers the general worker and no other bundled agent", () => {
		expect(subagentEnabledByDefault(bundled("task"))).toBe(true);
		for (const name of ["scout", "reviewer", "designer", "librarian", "sonic"]) {
			expect(subagentEnabledByDefault(bundled(name)), `${name} must not be offered by default`).toBe(false);
		}
	});

	/**
	 * Agent files define available roles but do not silently grant spawn
	 * permission. Onboarding and the Agents table are the opt-in.
	 */
	it("keeps user-authored and project agents disabled without a settings row", () => {
		expect(subagentEnabledByDefault(userAgent("my-refactorer"))).toBe(false);
		expect(subagentEnabledByDefault({ ...userAgent("proj"), source: "project" })).toBe(false);
	});

	/** The tool description and the delegation prompt list exactly the offered set. */
	it("filters a discovered list down to the offered agents", () => {
		const settings = Settings.isolated();
		const agents = [bundled("task"), bundled("scout"), bundled("reviewer"), userAgent("mine")];

		expect(filterEnabledAgents(settings, agents).map(agent => agent.name)).toEqual(["task"]);
	});

	/** An explicit row turns a specialist on, and it then appears in the offered set. */
	it("offers a specialist the operator turned on", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: { enabled: true } } });

		expect(isSubagentEnabled(settings, bundled("scout"))).toBe(true);
		expect(filterEnabledAgents(settings, [bundled("task"), bundled("scout")]).map(a => a.name)).toEqual([
			"task",
			"scout",
		]);
	});
});

describe("subagent enable states: on, off, and nothing in between", () => {
	/**
	 * TWO states, and the count is the fix.
	 *
	 * There were four (`on` / `default-on` / `default-off` / `off`) over two
	 * predicates, and the gap between them was a user-visible state that read "Not
	 * offered (default) — still runs when named". A switch labelled off that still
	 * runs is not a switch, and an operator who pressed `space` until the row said
	 * off had not turned the agent off. Enabled now means the model may choose this
	 * agent; disabled means it may not; there is no third behaviour to discover.
	 *
	 * What used to justify the middle state — `/review` naming `reviewer` on a
	 * stock install — is solved where it belongs, by the command declaring the
	 * agent it names for that turn. See the grant tests below.
	 */
	it("has exactly two states, and one label for each", () => {
		const states: SubagentEnableState[] = ["on", "off"];
		expect(Object.keys(SUBAGENT_ENABLE_STATE_LABEL).sort()).toEqual([...states].sort());
		expect(SUBAGENT_ENABLE_STATE_LABEL.on).toBe("Enabled");
		expect(SUBAGENT_ENABLE_STATE_LABEL.off).toBe("Disabled");
	});

	/**
	 * The regression that names the removed behaviour outright. A bundled
	 * specialist with no row is DISABLED, full stop — it is not "unadvertised but
	 * spawnable", and no caller may treat it as spawnable on the model's behalf.
	 */
	it("reports a default-off specialist as disabled, with nothing spawnable behind it", () => {
		const settings = Settings.isolated();
		const reviewer = bundled("reviewer");

		expect(isSubagentEnabled(settings, reviewer)).toBe(false);
		expect(subagentEnableState(reviewer, subagentSettingsFor(settings, "reviewer").enabled)).toBe("off");
		expect(isSubagentEnableDefaulted(subagentSettingsFor(settings, "reviewer").enabled)).toBe(true);
	});

	/** `enabled: false` and "no row on a specialist" now agree, because they mean the same thing. */
	it("reports an explicitly disabled agent the same way as a defaulted one", () => {
		const settings = Settings.isolated({ "subagent.agents": { reviewer: { enabled: false } } });
		const reviewer = bundled("reviewer");

		expect(isSubagentEnabled(settings, reviewer)).toBe(false);
		expect(subagentEnableState(reviewer, subagentSettingsFor(settings, "reviewer").enabled)).toBe("off");
		// The only difference is provenance, which surfaces may show as "(default)"
		// and which must never change what the agent does.
		expect(isSubagentEnableDefaulted(subagentSettingsFor(settings, "reviewer").enabled)).toBe(false);
	});

	/** A user agent turned off is disabled too: same key, same meaning, either source. */
	it("disables a user-authored agent turned off", () => {
		const settings = Settings.isolated({ "subagent.agents": { mine: { enabled: false } } });
		const mine = userAgent("mine");

		expect(isSubagentEnabled(settings, mine)).toBe(false);
		expect(subagentEnableState(mine, subagentSettingsFor(settings, "mine").enabled)).toBe("off");
	});

	/** Untouched agents follow their shipped source-specific defaults. */
	it("defaults task on and every other agent off when no row exists", () => {
		const settings = Settings.isolated();

		expect(subagentEnableState(bundled("task"), subagentSettingsFor(settings, "task").enabled)).toBe("on");
		expect(subagentEnableState(userAgent("mine"), subagentSettingsFor(settings, "mine").enabled)).toBe("off");
		expect(isSubagentEnableDefaulted(subagentSettingsFor(settings, "task").enabled)).toBe(true);
		expect(isSubagentEnableDefaulted(subagentSettingsFor(settings, "mine").enabled)).toBe(true);
	});

	/**
	 * The toggle writes an explicit value every time, in both directions.
	 *
	 * The old cycle had three stops and could land back on "unset", a keypress that
	 * changed nothing a reader could see. Writing explicitly also means the choice
	 * survives a change to the shipped default, which a cleared row would not.
	 */
	it("toggles both ways and always writes an explicit value", () => {
		const scout = bundled("scout");
		const task = bundled("task");

		// Defaulted-off → on → off, never back to undefined.
		expect(nextSubagentEnableValue(scout, undefined)).toBe(true);
		expect(nextSubagentEnableValue(scout, true)).toBe(false);
		expect(nextSubagentEnableValue(scout, false)).toBe(true);

		// And the toggle reads the agent's OWN default, so a defaulted-on agent
		// turns off on the first press rather than needing two.
		expect(nextSubagentEnableValue(task, undefined)).toBe(false);
	});

	/** A garbage row must not crash a reader or be mistaken for a real row. */
	it("treats a non-object row as no row at all", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: "yes" } });

		expect(subagentSettingsFor(settings, "scout")).toEqual({});
		// Falls back to the shipped default, which for a specialist is off.
		expect(isSubagentEnabled(settings, bundled("scout"))).toBe(false);
	});
});

describe("subagent model precedence: one scope, the agent", () => {
	const LANE_ROW = "openai/gpt-5";
	const NESTED = "anthropic/claude-sonnet-4-5";
	const FRONTMATTER = "google/gemini-2.5-pro";
	const PROFILE_DEFAULT = "anthropic/claude-opus-4-5";

	/**
	 * A stock install runs every subagent on the profile's default model.
	 *
	 * The documented default, and the only fallback: it is the model the main
	 * assistant starts on, so a fresh roster is coherent without anyone
	 * configuring a row. What it is NOT is the live session model, which moves on
	 * a temporary pick, on role cycling and on prewalk.
	 */
	it("falls back to the profile default model role when nothing is configured", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", PROFILE_DEFAULT);

		for (const name of ["task", "scout", "reviewer", "designer", "librarian", "sonic"]) {
			const resolved = resolveSubagentModel({ settings, agentName: name });
			expect(resolved.patterns, `${name} must fall back to the default role`).toEqual([PROFILE_DEFAULT]);
			expect(resolved.source).toBe("default");
			expect(resolved.unresolved).toBeUndefined();
		}
	});

	/**
	 * THE HEADLINE CONTRACT. Choosing a model for one agent moves that agent and
	 * nothing else. The old shape had a switch that put every agent on one chain,
	 * which is why "I changed the model" and "my subagents changed model" were the
	 * same event.
	 */
	it("moves exactly the agent whose lane names a model", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: LANE_ROW } },
		} as Parameters<typeof Settings.isolated>[0]);
		settings.setModelRole("default", PROFILE_DEFAULT);

		expect(resolveSubagentModel({ settings, agentName: "scout" }).patterns).toEqual([LANE_ROW]);
		for (const other of ["task", "reviewer", "librarian"]) {
			const resolved = resolveSubagentModel({ settings, agentName: other });
			expect(resolved.patterns, `${other} must not move with scout`).toEqual([PROFILE_DEFAULT]);
			expect(resolved.source).toBe("default");
		}
	});

	/**
	 * The lane is the top layer, because it is the most specific statement anyone
	 * can make: it names the agent and the depth. The badge naming the deciding
	 * layer is the part that must not regress — an operator who cannot see WHICH
	 * level decided is back to editing one screen and reading another.
	 */
	it("puts the agent's own lane above its frontmatter", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: LANE_ROW } },
		} as Parameters<typeof Settings.isolated>[0]);

		const resolved = resolveSubagentModel({ settings, agentName: "scout", agentModel: FRONTMATTER });

		expect(resolved.patterns).toEqual([LANE_ROW]);
		expect(resolved.source).toBe("lane");
		expect(subagentModelSourceLabel(resolved.source, "scout", resolved.depth)).toBe("subagent.agents.scout");
	});

	/** A nested lane names itself, not its agent, and decides for the depth it governs. */
	it("lets a nested lane decide for the depth it governs, and names that level", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: LANE_ROW, subagents: { model: NESTED } } },
		} as Parameters<typeof Settings.isolated>[0]);

		const child = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 1 });
		expect(child.patterns).toEqual([LANE_ROW]);
		expect(subagentModelSourceLabel(child.source, "scout", child.depth)).toBe("subagent.agents.scout");

		const grandchild = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 2 });
		expect(grandchild.patterns).toEqual([NESTED]);
		expect(subagentModelSourceLabel(grandchild.source, "scout", grandchild.depth)).toBe(
			"subagent.agents.scout.subagents",
		);
	});

	/**
	 * Unset on a nested page means the level above, never the profile default:
	 * that is the only reading under which a nested page needs no absolute value
	 * to be understood, and the walk is upward for exactly that reason.
	 */
	it("inherits the level above when a nested lane names no model", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: LANE_ROW, subagents: { enabled: true } } },
		} as Parameters<typeof Settings.isolated>[0]);

		const grandchild = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 2 });

		expect(grandchild.patterns).toEqual([LANE_ROW]);
		expect(subagentModelSourceLabel(grandchild.source, "scout", grandchild.depth)).toBe("subagent.agents.scout");
	});

	/**
	 * Frontmatter still decides for a user-authored agent that asks for a specific
	 * model, but only after the lane has declined. It is the author's default, not
	 * an override of the operator.
	 */
	it("falls to the definition's frontmatter when no lane names a model", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { enabled: true } },
		} as Parameters<typeof Settings.isolated>[0]);

		const resolved = resolveSubagentModel({ settings, agentName: "scout", agentModel: FRONTMATTER });

		expect(resolved.patterns).toEqual([FRONTMATTER]);
		expect(resolved.source).toBe("frontmatter");
	});

	/** Layer order is total, with every layer populated at once. */
	it("orders the chain end to end", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: LANE_ROW } },
		} as Parameters<typeof Settings.isolated>[0]);
		settings.setModelRole("default", PROFILE_DEFAULT);
		const spawn = { agentName: "scout", agentModel: FRONTMATTER, taskDepth: 1 } as const;

		expect(resolveSubagentModel({ settings, ...spawn }).source).toBe("lane");

		const withoutLane = Settings.isolated();
		withoutLane.setModelRole("default", PROFILE_DEFAULT);
		expect(resolveSubagentModel({ settings: withoutLane, ...spawn }).source).toBe("frontmatter");
		expect(resolveSubagentModel({ settings: withoutLane, agentName: "scout", taskDepth: 1 }).source).toBe("default");
	});

	/** A comma list or YAML list is a preference order, preserved as given. */
	it("keeps a multi-pattern value in order", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: `${NESTED}, ${LANE_ROW}` } },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentModel({ settings, agentName: "scout" }).patterns).toEqual([NESTED, LANE_ROW]);
	});

	/**
	 * A profile that has never recorded a default model role (a headless start
	 * before onboarding) takes the caller's bootstrap pattern. It is not a layer:
	 * a recorded role always outranks it.
	 */
	it("uses the caller's bootstrap pattern only when the default role is unset", () => {
		const empty = Settings.isolated();
		const bootstrapped = resolveSubagentModel({
			settings: empty,
			agentName: "task",
			fallbackModelPattern: PROFILE_DEFAULT,
		});
		expect(bootstrapped.patterns).toEqual([PROFILE_DEFAULT]);
		expect(bootstrapped.source).toBe("default");

		const recorded = Settings.isolated();
		recorded.setModelRole("default", LANE_ROW);
		expect(
			resolveSubagentModel({ settings: recorded, agentName: "task", fallbackModelPattern: PROFILE_DEFAULT })
				.patterns,
		).toEqual([LANE_ROW]);
	});
});

describe("subagent model: the two scopes, and the key that is retired in both", () => {
	/**
	 * `subagent.model` and `subagent.thinkingLevel` answer only while the switch is on. Left in a
	 * file with the switch off they are inert, so a config written while the roster was shared does
	 * not quietly outrank the per-agent pages once the operator turns the switch back off.
	 */
	it.each([
		["subagent.model", { "subagent.model": "openai/gpt-5" }],
		["subagent.modelByDepth", { "subagent.modelByDepth": { "1": "openai/gpt-5" } }],
	] as Array<[string, Parameters<typeof Settings.isolated>[0]]>)(
		"ignores %s while the switch is off",
		(_name, stored) => {
			const settings = Settings.isolated(stored);
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			const resolved = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 1 });

			expect(resolved.patterns).toEqual(["anthropic/claude-opus-4-5"]);
			expect(resolved.source).toBe("default");
		},
	);

	/**
	 * The depth-keyed chain is retired in BOTH scopes: it named a depth rather than an agent, so it
	 * decided for whatever agent happened to run there, and neither scope has a reading of that.
	 */
	it("ignores subagent.modelByDepth even while the switch is on", () => {
		const settings = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.modelByDepth": { "1": "openai/gpt-5" },
		} as Parameters<typeof Settings.isolated>[0]);
		settings.setModelRole("default", "anthropic/claude-opus-4-5");

		const resolved = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 1 });

		expect(resolved.patterns).toEqual(["anthropic/claude-opus-4-5"]);
		expect(resolved.source).toBe("default");
	});

	/** The blanket effort is inert on its own axis while the switch is off, for the same reason. */
	it("ignores subagent.thinkingLevel while the switch is off", () => {
		const settings = Settings.isolated({ "subagent.thinkingLevel": "low" });

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(AGENT_DEFAULT_EFFORT);
	});

	/** With the switch on, both blanket keys answer, and they answer for an agent with no row. */
	it("serves both blanket keys while the switch is on", () => {
		const settings = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.model": "openai/gpt-5",
			"subagent.thinkingLevel": "low",
		} as Parameters<typeof Settings.isolated>[0]);
		settings.setModelRole("default", "anthropic/claude-opus-4-5");

		const resolved = resolveSubagentModel({ settings, agentName: "scout", taskDepth: 1 });

		expect(resolved.patterns).toEqual(["openai/gpt-5"]);
		expect(resolved.source).toBe("shared");
		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(ThinkingLevel.Low);
	});

	/**
	 * The switch on with no chain set is every agent on the default model role, not a fall-through
	 * to the agent's own layers. Falling through would make the switch look on while frontmatter
	 * still decided, which is a screen saying one thing and a spawn doing another.
	 */
	it("lands every agent on the default role when the switch is on and no chain is set", () => {
		const settings = Settings.isolated({ "subagent.sharedModel": true });
		settings.setModelRole("default", "anthropic/claude-opus-4-5");

		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			agentModel: "openai/gpt-5",
			taskDepth: 1,
		});

		expect(resolved.patterns).toEqual(["anthropic/claude-opus-4-5"]);
		expect(resolved.source).toBe("default");
	});

	/**
	 * Inert is not the same as silent. A file that still names a depth-keyed chain looks
	 * configured, so the stale key is listed with the page that replaced it; otherwise the operator
	 * reads a value on disk and watches something else run.
	 */
	it("lists every stale key that is still set, and nothing that is unset", () => {
		const stale = Settings.isolated({
			"subagent.modelByDepth": { "1": "openai/gpt-5" },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(rejectedSubagentModelSettings(stale).sort()).toEqual(Object.keys(RETIRED_SUBAGENT_MODEL_SETTINGS).sort());
		expect(rejectedSubagentModelSettings(Settings.isolated())).toEqual([]);
	});

	/**
	 * A live key is never reported as stale. Reporting `subagent.model` would tell an operator to
	 * migrate the setting the switch above it just told them to use.
	 */
	it("says nothing about the blanket keys, which are live", () => {
		const settings = Settings.isolated({
			"subagent.sharedModel": true,
			"subagent.model": "openai/gpt-5",
			"subagent.thinkingLevel": "low",
		} as Parameters<typeof Settings.isolated>[0]);

		expect(rejectedSubagentModelSettings(settings)).toEqual([]);
	});

	/**
	 * A key holding its unset value is not a choice somebody made, so it is not
	 * reported. Without this, every profile that ever opened the old screen would
	 * be told to migrate settings it never used.
	 */
	it("says nothing about a key left at its unset value", () => {
		const settings = Settings.isolated({
			"subagent.sharedModel": false,
			"subagent.model": "",
			"subagent.modelByDepth": {},
		} as Parameters<typeof Settings.isolated>[0]);

		expect(rejectedSubagentModelSettings(settings)).toEqual([]);
	});

	/** Every retired key names a live control, so the report is actionable. */
	it("points each retired key at a per-agent control", () => {
		for (const [path, pointer] of Object.entries(RETIRED_SUBAGENT_MODEL_SETTINGS)) {
			expect(pointer, `${path} must name where to set it now`).toContain("Roster");
		}
	});

	/**
	 * The report reaches the operator once per key, on the path that would have
	 * read the value. Once, because a spawn-rate warning is noise nobody reads.
	 */
	it("reports a stale key once, naming the key and its replacement", () => {
		resetRejectedSubagentModelSettingReports();
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			const settings = Settings.isolated({
				"subagent.modelByDepth": { "1": "openai/gpt-5" },
			} as Parameters<typeof Settings.isolated>[0]);
			resolveSubagentModel({ settings, agentName: "scout" });
			resolveSubagentModel({ settings, agentName: "reviewer" });
		} finally {
			restore();
			resetRejectedSubagentModelSettingReports();
		}

		const reported = warnings.filter(message => message.includes("subagent.modelByDepth"));
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain(RETIRED_SUBAGENT_MODEL_SETTINGS["subagent.modelByDepth"]);
	});
});

describe("subagent model: a configured value that resolves to nothing refuses", () => {
	/**
	 * NO SILENT FALL-THROUGH. A configured value that expanded to nothing quietly
	 * handed the decision to the next layer, so a typo in an agent's model looked
	 * exactly like the setting having no effect — the operator's own value
	 * vanished without a word.
	 *
	 * The resolver reports the layer and the value instead, and every caller
	 * refuses the spawn with that text.
	 */
	it("refuses over a lane whose value resolves to nothing", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { model: "@designer" } },
		} as Parameters<typeof Settings.isolated>[0]);
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");

		const resolved = resolveSubagentModel({ settings, agentName: "scout" });

		expect(resolved.patterns).toEqual([]);
		expect(resolved.unresolved).toEqual({ source: "lane", value: "@designer", depth: 0 });
	});

	/**
	 * And in the frontmatter, which is where the retired `@task` alias still lurks
	 * in older agent files. Resolving it to the literal string would push the
	 * failure into model matching, where the message says only "no model matched"
	 * and never mentions the role that no longer exists.
	 */
	it("reports a retired role alias left in an agent definition", () => {
		const settings = Settings.isolated();

		const resolved = resolveSubagentModel({ settings, agentName: "old-agent", agentModel: "@task" });

		expect(resolved.unresolved).toEqual({ source: "frontmatter", value: "@task" });
	});

	/**
	 * The label names the exact setting to edit, which is what makes the refusal
	 * actionable. The table is typed `Record<SubagentModelSource, string>`, so
	 * adding a layer to the union fails this file to compile until the new layer
	 * has a label of its own — an unnamed layer would refuse a spawn while
	 * pointing at nothing.
	 */
	it("names the setting behind every layer", () => {
		const expected: Record<SubagentModelSource, string> = {
			// Names the switch beside the key: a reader who never set the switch has
			// to learn why one key answers for an agent they did not configure.
			shared: "subagent.model (Same Model for All Subagents)",
			// For a lane the number is its index in the chain, not a spawn depth: 0 is the
			// agent's own row and each step down adds one `.subagents`, so the label spells
			// the exact sequence of pages an operator walked to set it.
			lane: "subagent.agents.scout.subagents.subagents",
			frontmatter: "scout agent frontmatter",
			default: "the default model role",
		};
		for (const [source, label] of Object.entries(expected)) {
			expect(subagentModelSourceLabel(source as SubagentModelSource, "scout", 2)).toBe(label);
		}
	});
});

describe("subagent thinking level", () => {
	/**
	 * Effort rides the same one scope as the model, so a lane's effort answers for
	 * that agent and a nested lane that names none takes the level above.
	 */
	it("puts a lane's effort above the definition's, and inherits upward", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { thinkingLevel: "high", subagents: { enabled: true } } },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", agentThinkingLevel: AUTO_THINKING })).toBe(
			ThinkingLevel.High,
		);
		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", taskDepth: 2 })).toBe(ThinkingLevel.High);
	});

	/** A nested lane that names its own effort decides for the depth it governs. */
	it("lets a nested lane set an effort its parent does not use", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { thinkingLevel: "high", subagents: { thinkingLevel: "minimal" } } },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", taskDepth: 1 })).toBe(ThinkingLevel.High);
		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", taskDepth: 2 })).toBe(ThinkingLevel.Minimal);
	});

	/**
	 * An effort set on one agent moves that agent only. The pair with the model
	 * case above is the point: both axes have the same scope, so a roster row
	 * cannot move the model and leave the effort behind.
	 */
	it("moves exactly the agent whose lane names an effort", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { thinkingLevel: "high" } },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(ThinkingLevel.High);
		expect(resolveSubagentThinkingLevel({ settings, agentName: "reviewer" })).toBe(AGENT_DEFAULT_EFFORT);
	});

	/** With no lane, the definition's own level is what is left to use. */
	it("uses the definition's level when no lane names one", () => {
		expect(
			resolveSubagentThinkingLevel({
				settings: Settings.isolated(),
				agentName: "scout",
				agentThinkingLevel: ThinkingLevel.Medium,
			}),
		).toBe(ThinkingLevel.Medium);
	});

	/**
	 * Nothing configured resolves to a concrete documented effort rather than
	 * undefined. An agent that resolved to "no effort" was an agent whose effort
	 * was decided somewhere else, which is the coupling this scope change removes.
	 */
	it("returns the documented default when nothing sets a level", () => {
		expect(resolveSubagentThinkingLevel({ settings: Settings.isolated(), agentName: "scout" })).toBe(
			AGENT_DEFAULT_EFFORT,
		);
	});

	/**
	 * A typo must not become a neighbouring level. Silently running at an effort
	 * nobody chose is both a wrong answer and an invisible one, and effort changes
	 * cost.
	 */
	it("falls to the default instead of guessing at an unparseable level", () => {
		const settings = Settings.isolated({
			"subagent.agents": { scout: { thinkingLevel: "hihg" } },
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(AGENT_DEFAULT_EFFORT);
	});

	/**
	 * Ignoring it silently is the other half of the bug: the default is exactly
	 * what an operator sees when they set nothing, so a typo left them with a
	 * setting that looked configured and did nothing. The value is named, and so
	 * are the levels that would have worked.
	 */
	it("reports an unparseable level rather than ignoring it quietly", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			// A value no other case uses, because the report fires once per process.
			resolveSubagentThinkingLevel({
				settings: Settings.isolated({
					"subagent.agents": { scout: { thinkingLevel: "hgih" } },
				} as Parameters<typeof Settings.isolated>[0]),
				agentName: "scout",
			});
		} finally {
			restore();
		}

		const reported = warnings.find(message => message.includes("hgih"));
		expect(reported).toBeDefined();
		expect(reported).toContain("subagent.agents.scout.thinkingLevel");
		for (const level of CLI_THINKING_LEVELS) expect(reported).toContain(level);
	});

	/**
	 * Blank is what the picker's Inherit row stores, so it is a deliberate choice
	 * rather than a mistake. Warning about it would fire on every spawn of every
	 * agent an operator had explicitly set back to inherit.
	 */
	it("says nothing about a blank level", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			const settings = Settings.isolated({
				"subagent.agents": { scout: { thinkingLevel: "   " } },
			} as Parameters<typeof Settings.isolated>[0]);
			expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(AGENT_DEFAULT_EFFORT);
		} finally {
			restore();
		}

		expect(warnings).toEqual([]);
	});
});

describe("superseded per-agent rows are named, and still honored", () => {
	/**
	 * WHY THIS SUITE READS THIS WAY (SUPERSEDED-AGENT-ROWS-ARE-REPORTED).
	 * `subagent.agents.<name>.maxNestedSpawnDepth` is the pre-tree numeric ceiling.
	 * The nested `subagents` chain replaced it, and no screen writes it any more,
	 * but it EXISTS in config files an earlier release wrote. Dropping it would
	 * silently change what those files mean, so it is read and it is named.
	 *
	 * The contract is therefore two-sided, and both sides are easy to break in
	 * opposite directions: the value still decides (a config keeps its meaning),
	 * AND it is named once with the control that replaced it (nobody edits a dead
	 * field for an hour). It is a report, not a refusal — a leftover field must
	 * not stop a spawn (see the refusal suite above).
	 *
	 * NOT COVERED: whether the roster page renders the chain the number implies.
	 * That is a surface concern and lives in the selector suites.
	 */
	/**
	 * The fields are read from the owner table rather than restated, so a second superseded field
	 * gets its cases the moment it is added there. The probe value and the replacement wording each
	 * live in a `Record` over that same union, so a new field does not typecheck until someone
	 * records both.
	 */
	const SUPERSEDED_ROW_VALUE: Record<SupersededAgentRowField, number> = {
		maxNestedSpawnDepth: 2,
	};
	const REPLACEMENT_NAMED: Record<SupersededAgentRowField, string> = {
		maxNestedSpawnDepth: "Subagents",
	};

	it("records a probe value and a replacement for every superseded field", () => {
		expect(Object.keys(SUPERSEDED_ROW_VALUE).sort()).toEqual([...SUPERSEDED_AGENT_ROW_FIELDS].sort());
		expect(Object.keys(REPLACEMENT_NAMED).sort()).toEqual([...SUPERSEDED_AGENT_ROW_FIELDS].sort());
	});

	// A `for` loop rather than `it.each`: each case needs its own agent name, because
	// the report is deduplicated per agent and field for the life of the process.
	for (const field of SUPERSEDED_AGENT_ROW_FIELDS) {
		it(`names subagent.agents.<name>.${field} and where the control moved to`, () => {
			resetSupersededAgentRowReports();
			const agentName = `superseded-${field}`;
			const row: SubagentAgentSettings = {};
			Object.assign(row, { [field]: SUPERSEDED_ROW_VALUE[field] });
			const settings = Settings.isolated({ "subagent.agents": { [agentName]: row } });
			const warnings: string[] = [];
			const restore = captureLoggerWarnings(warnings);
			try {
				resolveSubagentModel({ settings, agentName });
				resolveSubagentThinkingLevel({ settings, agentName });
			} finally {
				restore();
			}

			const reported = warnings.find(message => message.includes(`subagent.agents.${agentName}.${field}`));
			expect(reported).toBeDefined();
			expect(reported).toContain("no screen writes");
			expect(reported).toContain(REPLACEMENT_NAMED[field]);
		});
	}

	/**
	 * Said once, not once per spawn. Both resolvers report, and both run on every
	 * spawn and on every settings render, so an undeduplicated message would bury
	 * the log and the operator would learn to skip it.
	 */
	it("reports each superseded field once per process", () => {
		resetSupersededAgentRowReports();
		const row: SubagentAgentSettings = {};
		Object.assign(row, SUPERSEDED_ROW_VALUE);
		const settings = Settings.isolated({ "subagent.agents": { "superseded-twice": row } });
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				resolveSubagentModel({ settings, agentName: "superseded-twice" });
				resolveSubagentThinkingLevel({ settings, agentName: "superseded-twice" });
			}
		} finally {
			restore();
		}

		const counted = SUPERSEDED_AGENT_ROW_FIELDS.map(
			field => warnings.filter(message => message.includes(`subagent.agents.superseded-twice.${field}`)).length,
		);
		expect(counted).toEqual(SUPERSEDED_AGENT_ROW_FIELDS.map(() => 1));
	});

	/**
	 * Reported is not ignored. The whole reason the field is still read is that an
	 * operator's file must keep meaning what it meant, and a report that came with
	 * a behavior change would be a worse outcome than either alone.
	 */
	it("still resolves the depth the superseded number asked for", () => {
		resetSupersededAgentRowReports();
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 0,
			"subagent.agents": { "superseded-depth": { maxNestedSpawnDepth: 2 } },
		});

		expect(resolveSubagentMaxNestedSpawnDepth(settings, "superseded-depth")).toBe(2);
		// And the blanket still answers for an agent that never carried the field,
		// so the migration is scoped to the row that has it.
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "scout")).toBe(0);
	});

	/** The superseded path is gone from the schema, so no picker can write one again. */
	it("declares no superseded field in the settings schema", () => {
		const declared = SUPERSEDED_AGENT_ROW_FIELDS.filter(field => isSettingPath(`subagent.agents.${field}`));

		expect(declared).toEqual([]);
	});
});

/**
 * WHY THIS SUITE READS THIS WAY (THE-ENABLED-CHAIN-IS-THE-SPAWN-CEILING).
 *
 * The whole lane tree turns on one sentence: lane index `i` governs the process at task depth `i`,
 * so a process at depth `d` may spawn exactly when lane index `d` is enabled. Every screen, the
 * resolver, and `canSpawnAtDepth` agree only while that holds, and an off-by-one in it is invisible
 * on any screen — it shows up as a subagent that cannot spawn, or one that can spawn a level too
 * far. The cases below drive the arithmetic directly at each of its four branches: an explicit
 * `false`, a chain shorter than the blanket, an unlimited blanket, and a row with no chain at all.
 *
 * The class this closes is "the ceiling the page draws is not the ceiling the gate applies", which
 * is why each case asserts through `canSpawnAtDepth` as well as on the number: a resolver returning
 * a plausible number that gates the wrong depth is the defect, not the number.
 *
 * WHAT IT DOES NOT CATCH: what a screen prints. The page default is pinned where the page is
 * driven, in `modes/components/subagent-agents-surface.test.ts`.
 */
describe("the enabled chain is the spawn ceiling", () => {
	/** A cap and the two depths that bracket it, so a number cannot pass while gating the wrong one. */
	function gate(cap: number, depth: number): boolean {
		return canSpawnAtDepth(cap, depth);
	}

	it("stops at the level turned off, and the blanket may not widen it", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 5,
			"subagent.agents": { scout: { subagents: { enabled: false } } },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(cap).toBe(0);
		// Depth 0 is this session spawning `scout`; depth 1 would be `scout` spawning in turn, which
		// is the level the operator turned off.
		expect(gate(cap, 0)).toBe(true);
		expect(gate(cap, 1)).toBe(false);
	});

	it("stops at the deepest level turned off, not the first level named", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 0,
			"subagent.agents": { scout: { subagents: { enabled: true, subagents: { enabled: false } } } },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(cap).toBe(1);
		expect(gate(cap, 1)).toBe(true);
		expect(gate(cap, 2)).toBe(false);
	});

	it("raises the ceiling to the depth the chain reaches", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 0,
			"subagent.agents": { scout: { subagents: { enabled: true, subagents: { enabled: true } } } },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(cap).toBe(2);
		expect(gate(cap, 2)).toBe(true);
		expect(gate(cap, 3)).toBe(false);
	});

	/**
	 * Where the chain STOPS, nothing was written, so the blanket keeps answering from there down. A
	 * chain shorter than the blanket that lowered the ceiling would turn "I turned one level on"
	 * into "I turned every level below it off".
	 */
	it("keeps answering from the blanket where the chain stops", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 3,
			"subagent.agents": { scout: { subagents: { enabled: true } } },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(cap).toBe(3);
		expect(gate(cap, 3)).toBe(true);
		expect(gate(cap, 4)).toBe(false);
	});

	/** Unlimited is not a number to take the larger of: a chain must not make it finite. */
	it("leaves an unlimited blanket unlimited", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": -1,
			"subagent.agents": { scout: { subagents: { enabled: true } } },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(cap).toBe(-1);
		expect(gate(cap, 64)).toBe(true);
	});

	/** An absent lane is not a decision, which is what keeps a stock install unchanged. */
	it("answers with the blanket for a row that names no chain", () => {
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 2,
			"subagent.agents": { scout: { enabled: true } },
		});

		expect(resolveSubagentMaxNestedSpawnDepth(settings, "scout")).toBe(2);
		expect(resolveSubagentMaxNestedSpawnDepth(settings, "designer")).toBe(2);
		expect(resolveSubagentMaxNestedSpawnDepth(settings)).toBe(2);
	});

	/**
	 * A settings file is untrusted input. A lane that points at itself is a bounded walk, not a
	 * hung settings read, and the bound is asserted rather than the process being trusted to return.
	 */
	it("bounds a self-referential lane instead of hanging", () => {
		const cyclic: SubagentAgentSettings = { enabled: true };
		cyclic.subagents = cyclic;
		const settings = Settings.isolated({
			"subagent.maxNestedSpawnDepth": 0,
			"subagent.agents": { scout: cyclic },
		});

		const cap = resolveSubagentMaxNestedSpawnDepth(settings, "scout");
		expect(Number.isFinite(cap)).toBe(true);
		expect(cap).toBeLessThanOrEqual(64);
	});
});

describe("subagent effort choices", () => {
	/**
	 * The blanket effort was a free-text field on the Subagents tab: any string was accepted and an
	 * unrecognized one resolved to "inherited". It is a picker over the one effort vocabulary now,
	 * and it renders only while the shared switch is on, beside the blanket model it applies to. Off,
	 * neither row is drawn, so the tab never shows two rows that decide nothing — which is how the
	 * retired version of this switch confused people.
	 */
	it("draws the blanket model and effort only while the shared switch is on", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		invalidateSettingDefsCache();
		try {
			const entries = getSettingsForTab("subagents");
			const paths = entries.map(entry => entry.path);
			expect(paths).toContain("subagent.agents");
			expect(paths).toContain("subagent.sharedModel");

			const blanket = entries.filter(
				entry => entry.path === "subagent.model" || entry.path === "subagent.thinkingLevel",
			);
			expect(blanket.map(entry => entry.type)).toEqual(["modelSelector", "subagentSharedEffort"]);

			settings.set("subagent.sharedModel", false);
			for (const entry of blanket) {
				expect(entry.condition?.(), `${entry.path} must not be drawn while the switch is off`).toBe(false);
			}
			settings.set("subagent.sharedModel", true);
			for (const entry of blanket) {
				expect(entry.condition?.(), `${entry.path} must be drawn while the switch is on`).toBe(true);
			}

			// The switch itself is never conditional, or turning it off would hide the way back.
			expect(entries.find(entry => entry.path === "subagent.sharedModel")?.condition).toBeUndefined();
		} finally {
			resetSettingsForTest();
			invalidateSettingDefsCache();
		}
	});

	/**
	 * With NOTHING in scope a picker offers nothing but inherit. It used to offer the whole
	 * vocabulary, on the theory that a level with nothing to narrow against is stored now and
	 * clamped later — but the picker cannot say that, and a session whose models declare
	 * `low, high, max` was shown `minimal`, a level no endpoint in it accepts.
	 */
	it("offers inherit and nothing else when nothing is in scope", () => {
		expect(configuredThinkingLevelOptions().map(option => option.value)).toEqual([INHERIT_EFFORT_OPTION_VALUE]);
	});

	/**
	 * A row that has no single model and never will — this one with no chain set, and
	 * `defaultEffort`'s any-model `*` row — passes the catalog instead, and offers the UNION of what
	 * that catalog declares. Every row is then addressable on some model the operator can select,
	 * which is what "nothing is invented" means for a row with no model of its own.
	 */
	it("offers the union of the catalog when a scope is passed instead of a model", () => {
		// `high, max` and `low, medium, high`: two real ladders that overlap without covering the
		// vocabulary, so the union is provably narrower than the constant it replaced.
		const glm = getBundledModel("zai", "glm-5.2");
		const o1 = getBundledModel("azure", "o1");
		const union = configuredThinkingLevelOptions({ scope: [glm, o1] })
			.map(option => option.value)
			.slice(1);
		const declared = new Set([...configuredThinkingLevelsForModel(glm), ...configuredThinkingLevelsForModel(o1)]);

		expect(union).toEqual(CONFIGURED_THINKING_LEVELS.filter(level => declared.has(level)));
		// Both bounds: a build that publishes everything and one that publishes nothing both fail.
		expect(union.length).toBeGreaterThan(0);
		expect(union.length).toBeLessThan(CONFIGURED_THINKING_LEVELS.length);
	});

	/** With a model in scope the picker offers exactly the row's declared choices. */
	it("offers the model's declared levels plus inherit when a model is in scope", () => {
		const glm = getBundledModel("zai", "glm-5.2");
		const options = configuredThinkingLevelOptions({ model: glm });
		expect(options[0]?.value).toBe(INHERIT_EFFORT_OPTION_VALUE);
		expect(options.slice(1).map(option => option.value)).toEqual([...configuredThinkingLevelsForModel(glm)]);
	});

	/**
	 * Labels come from the shared metadata table rather than the raw selector, so a
	 * level cannot be renamed on one surface only. Descriptions are what make the
	 * rows choosable without reading the docs.
	 */
	it("labels and describes every row from the shared metadata", () => {
		const glm = getBundledModel("zai", "glm-5.2");
		for (const option of configuredThinkingLevelOptions({ model: glm })) {
			expect(option.label.length).toBeGreaterThan(0);
			expect(option.description.length).toBeGreaterThan(0);
		}
		const high = configuredThinkingLevelOptions({ model: glm }).find(option => option.value === ThinkingLevel.High);
		expect(high?.label).toBe("high");
	});

	/**
	 * The value the inherit row stores must be one the resolver reads as unset, or
	 * choosing Inherit would write a level that resolves to nothing while looking
	 * like a choice — the same defect this list replaced.
	 *
	 * Asserted on a NESTED lane, because that is where "inherit" has a visible
	 * answer: the level above. On the agent's own row it would be indistinguishable
	 * from the documented default, and a stored value that happened to equal the
	 * default would pass while deciding nothing.
	 */
	it("stores an inherit value the resolver treats as unset", () => {
		const settings = Settings.isolated({
			"subagent.agents": {
				scout: { thinkingLevel: "high", subagents: { thinkingLevel: INHERIT_EFFORT_OPTION_VALUE } },
			},
		} as Parameters<typeof Settings.isolated>[0]);

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", taskDepth: 2 })).toBe(ThinkingLevel.High);
	});
});

describe("delegation strength answers with the agent table, not on its own", () => {
	/**
	 * WHY THIS SUITE READS THIS WAY (SUBAGENT-DELEGATION-IGNORES-THE-AGENT-TABLE).
	 * `subagent.delegation` and the `subagent.agents` table each decide whether any
	 * work leaves the main session, and they used to be computed apart. So
	 * `required` with every agent disabled still injected a first-turn "delegate
	 * substantial work" reminder, telling the model to hand work to nothing it was
	 * allowed to spawn. Each setting was individually correct and the pair was
	 * incoherent, which is exactly what makes a settings screen feel arbitrary.
	 * `resolveDelegation` takes both inputs, so every assertion below passes the
	 * enabled-agent set alongside the strength.
	 */
	const WORKER = ["task"];

	/**
	 * Subagents on, delegation encouraged, worker only — the shipped defaults, which
	 * the settings doc states as a promise to the operator. Pinned here so a change to
	 * any of the three has to be deliberate rather than a schema edit nobody noticed.
	 */
	it("defaults to preferred with subagents on", () => {
		const settings = Settings.isolated();
		const state = resolveDelegation(settings, WORKER);

		expect(delegationStrength(settings)).toBe("preferred");
		expect(delegationEnabled(settings)).toBe(true);
		expect(state.possible).toBe(true);
		expect(state.preferred).toBe(true);
		expect(state.required).toBe(false);
		expect(delegationBlockedNotice(state)).toBeUndefined();
	});

	/**
	 * `subagent.enabled: false` removes the task tool entirely rather than describing
	 * a tool nobody may use. This is the ONLY setting that does: the strength dial
	 * cannot, which is the distinction the two settings exist to keep apart.
	 */
	it("reports subagents-off as no delegation at all, and names the setting that stopped it", () => {
		const settings = Settings.isolated({ "subagent.enabled": false });
		const state = resolveDelegation(settings, WORKER);

		expect(delegationEnabled(settings)).toBe(false);
		expect(state.possible).toBe(false);
		expect(state.blockedBy).toBe("subagents-off");
		expect(state.preferred).toBe(false);
		expect(state.required).toBe(false);
		expect(delegationBlockedNotice(state)).toBe(
			"Subagents are off, so nothing here runs until you turn them back on.",
		);
	});

	/**
	 * The headline of the split, stated as its own case because it was the bug: the
	 * LOWEST delegation strength still delegates. `allowed` means the model keeps the
	 * task tool and decides for itself, so nothing here is blocked and no notice is
	 * shown. While one setting carried both jobs there was no way to express this —
	 * turning delegation down took the tool away — and it is the state most sessions
	 * want.
	 */
	it("keeps delegation possible at the lowest strength, because strength never forbids", () => {
		const settings = Settings.isolated({ "subagent.delegation": "allowed" });
		const state = resolveDelegation(settings, WORKER);

		expect(delegationEnabled(settings)).toBe(true);
		expect(state.possible).toBe(true);
		expect(state.blockedBy).toBeUndefined();
		expect(delegationBlockedNotice(state)).toBeUndefined();
		// Allowed is not a push: neither prompt flag is set.
		expect(state.preferred).toBe(false);
		expect(state.required).toBe(false);
	});

	/**
	 * And the master switch beats the dial in both directions: `required` with
	 * subagents off delegates nothing, rather than injecting a first-turn reminder to
	 * hand work to a tool that was never built.
	 */
	it("lets the master switch override the strongest strength", () => {
		const settings = Settings.isolated({ "subagent.enabled": false, "subagent.delegation": "required" });
		const state = resolveDelegation(settings, WORKER);

		expect(state.strength).toBe("required");
		expect(state.possible).toBe(false);
		expect(state.required).toBe(false);
		expect(state.blockedBy).toBe("subagents-off");
	});

	/** The defaults the docs promise: subagents on, delegation encouraged. */
	it("defaults to subagents on and delegation preferred", () => {
		const settings = Settings.isolated({});
		const state = resolveDelegation(settings, WORKER);

		expect(delegationEnabled(settings)).toBe(true);
		expect(state.strength).toBe("preferred");
		expect(state.possible).toBe(true);
		expect(state.preferred).toBe(true);
		expect(state.required).toBe(false);
	});

	/** `preferred` asks the prompt to push work out, without the first-turn reminder. */
	it("reports preferred as a push without the reminder", () => {
		const settings = Settings.isolated({ "subagent.delegation": "preferred" });
		const state = resolveDelegation(settings, WORKER);

		expect(state.possible).toBe(true);
		expect(state.preferred).toBe(true);
		expect(state.required).toBe(false);
	});

	/** `required` is the strongest: the push plus the eager first-turn prelude. */
	it("reports required as a push plus the reminder", () => {
		const state = resolveDelegation(Settings.isolated({ "subagent.delegation": "required" }), WORKER);

		expect(state.preferred).toBe(true);
		expect(state.required).toBe(true);
	});

	/**
	 * THE HEADLINE. With nothing to delegate to, the strongest setting available
	 * pushes nothing -- this is the assertion that fails if the two settings are
	 * ever computed apart again. The old behaviour was a first-turn reminder to
	 * delegate substantial work in a session that could not spawn anything.
	 */
	it("pushes nothing when no agent is enabled, however hard the strength is turned up", () => {
		for (const strength of ["allowed", "preferred", "required"] as const) {
			const state = resolveDelegation(Settings.isolated({ "subagent.delegation": strength }), []);

			expect(state.strength, `${strength} keeps its own value`).toBe(strength);
			expect(state.possible, `${strength} cannot delegate with no agent`).toBe(false);
			expect(state.preferred).toBe(false);
			expect(state.required).toBe(false);
			expect(state.blockedBy).toBe("no-enabled-agents");
		}
	});

	/**
	 * And it says WHICH setting to go fix, naming the strength that is being
	 * overruled. An operator looking at a delegation control that reads `required`
	 * while nothing delegates needs to be sent to the other setting, not left to
	 * guess between the two.
	 */
	it("names the strength being overruled when the agent table is what stopped it", () => {
		const state = resolveDelegation(Settings.isolated({ "subagent.delegation": "required" }), []);

		expect(delegationBlockedNotice(state)).toBe(
			'No agent is enabled, so there is nothing to delegate to and "required" has no effect.',
		);
	});

	/**
	 * The master switch outranks the agent table in the reason it reports: with
	 * subagents off the tool is not offered at all, so enabling agents changes
	 * nothing, and sending the operator to the agent table first would waste the trip.
	 */
	it("reports subagents-off first when both would block", () => {
		const state = resolveDelegation(Settings.isolated({ "subagent.enabled": false }), []);

		expect(state.blockedBy).toBe("subagents-off");
	});
});
