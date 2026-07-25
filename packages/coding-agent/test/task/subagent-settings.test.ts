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
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import {
	delegationEnabled,
	delegationPreferred,
	delegationRequired,
	delegationStrength,
	filterEnabledAgents,
	isSubagentAdvertised,
	isSubagentSpawnable,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	subagentEnabledByDefault,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	configuredThinkingLevelOptions,
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
	 * Writing an agent file IS the opt-in, so a user- or project-authored agent
	 * needs no second gesture in settings. Requiring one would make every new
	 * agent look broken on first use.
	 */
	it("offers a user-authored agent without any settings row", () => {
		expect(subagentEnabledByDefault(userAgent("my-refactorer"))).toBe(true);
		expect(subagentEnabledByDefault({ ...userAgent("proj"), source: "project" })).toBe(true);
	});

	/** The tool description and the delegation prompt list exactly the offered set. */
	it("filters a discovered list down to the offered agents", () => {
		const settings = Settings.isolated();
		const agents = [bundled("task"), bundled("scout"), bundled("reviewer"), userAgent("mine")];

		expect(filterEnabledAgents(settings, agents).map(agent => agent.name)).toEqual(["task", "mine"]);
	});

	/** An explicit row turns a specialist on, and it then appears in the offered set. */
	it("offers a specialist the operator turned on", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: { enabled: true } } });

		expect(isSubagentAdvertised(settings, bundled("scout"))).toBe(true);
		expect(filterEnabledAgents(settings, [bundled("task"), bundled("scout")]).map(a => a.name)).toEqual([
			"task",
			"scout",
		]);
	});
});

describe("subagent enable states: offered, blocked, and default", () => {
	/**
	 * Three states, not two.
	 *
	 * "Not offered" and "blocked" are different answers to different questions,
	 * and conflating them breaks something real either way: treat default-off as
	 * blocked and `/review` (whose prompt says `agent: "reviewer"`) stops working
	 * on a stock install; treat blocked as merely unadvertised and an operator who
	 * said no gets the agent anyway.
	 */
	it("keeps a default-off specialist spawnable when something names it outright", () => {
		const settings = Settings.isolated();
		const reviewer = bundled("reviewer");

		expect(isSubagentAdvertised(settings, reviewer)).toBe(false);
		expect(isSubagentSpawnable(settings, reviewer)).toBe(true);
		expect(subagentEnableState(reviewer, subagentSettingsFor(settings, "reviewer").enabled)).toBe("default-off");
	});

	/** `enabled: false` is the operator saying no, and it refuses even a named spawn. */
	it("blocks a spawn for an agent explicitly turned off", () => {
		const settings = Settings.isolated({ "subagent.agents": { reviewer: { enabled: false } } });
		const reviewer = bundled("reviewer");

		expect(isSubagentAdvertised(settings, reviewer)).toBe(false);
		expect(isSubagentSpawnable(settings, reviewer)).toBe(false);
		expect(subagentEnableState(reviewer, subagentSettingsFor(settings, "reviewer").enabled)).toBe("off");
	});

	/** A user agent turned off is blocked too: same key, same meaning, either source. */
	it("blocks a user-authored agent turned off", () => {
		const settings = Settings.isolated({ "subagent.agents": { mine: { enabled: false } } });
		const mine = userAgent("mine");

		expect(isSubagentSpawnable(settings, mine)).toBe(false);
		expect(subagentEnableState(mine, subagentSettingsFor(settings, "mine").enabled)).toBe("off");
	});

	/** An untouched agent reports the shipped default, so the UI can say "(default)". */
	it("reports the shipped default when the agent has no row", () => {
		const settings = Settings.isolated();

		expect(subagentEnableState(bundled("task"), subagentSettingsFor(settings, "task").enabled)).toBe("default-on");
		expect(subagentEnableState(userAgent("mine"), subagentSettingsFor(settings, "mine").enabled)).toBe("default-on");
	});

	/** An `enabled: true` row on an already-default-on agent still reads as an explicit choice. */
	it("distinguishes an explicit yes from the default yes", () => {
		const settings = Settings.isolated({ "subagent.agents": { task: { enabled: true } } });

		expect(subagentEnableState(bundled("task"), subagentSettingsFor(settings, "task").enabled)).toBe("on");
	});

	/** A garbage row must not crash a reader or be mistaken for a real row. */
	it("treats a non-object row as no row at all", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: "yes" } });

		expect(subagentSettingsFor(settings, "scout")).toEqual({});
		expect(isSubagentSpawnable(settings, bundled("scout"))).toBe(true);
	});
});

describe("subagent model precedence: four layers, one owner", () => {
	const AGENT_ROW = "openai/gpt-5";
	const BLANKET = "anthropic/claude-sonnet-4-5";
	const FRONTMATTER = "google/gemini-2.5-pro";
	const SESSION = "anthropic/claude-opus-4-5";

	/**
	 * A stock install runs EVERY subagent on the model the operator is looking at.
	 *
	 * This is the headline fix. Before it, scout ran a small model, reviewer a
	 * thinking model and designer a third, all decided by frontmatter aliases the
	 * operator never saw, which is why "I changed the subagent model" changed
	 * nothing.
	 */
	it("inherits the session model when nothing is configured", () => {
		const settings = Settings.isolated();

		for (const name of ["task", "scout", "reviewer", "designer", "librarian", "sonic"]) {
			const resolved = resolveSubagentModel({ settings, agentName: name, activeModelPattern: SESSION });
			expect(resolved.patterns, `${name} must inherit the session model`).toEqual([SESSION]);
			expect(resolved.source).toBe("inherit");
			expect(resolved.unresolved).toBeUndefined();
		}
	});

	/** The blanket setting moves every subagent at once — the knob the operator reached for. */
	it("uses subagent.model over the definition's frontmatter", () => {
		const settings = Settings.isolated({ "subagent.model": BLANKET });

		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			agentModel: FRONTMATTER,
			activeModelPattern: SESSION,
		});

		expect(resolved.patterns).toEqual([BLANKET]);
		expect(resolved.source).toBe("blanket");
	});

	/** A per-agent row is the most specific choice and outranks the blanket one. */
	it("uses the agent's own row over subagent.model", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.agents": { scout: { model: AGENT_ROW } },
		});

		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			agentModel: FRONTMATTER,
			activeModelPattern: SESSION,
		});

		expect(resolved.patterns).toEqual([AGENT_ROW]);
		expect(resolved.source).toBe("agent");
	});

	/**
	 * Frontmatter still decides for a user-authored agent that asks for a specific
	 * model, but only after both settings layers have declined. It is the author's
	 * default, not an override of the operator.
	 */
	it("falls to the definition's frontmatter when no setting names a model", () => {
		const settings = Settings.isolated();

		const resolved = resolveSubagentModel({
			settings,
			agentName: "my-agent",
			agentModel: FRONTMATTER,
			activeModelPattern: SESSION,
		});

		expect(resolved.patterns).toEqual([FRONTMATTER]);
		expect(resolved.source).toBe("frontmatter");
	});

	/** Layer order is total: the row wins even with all four layers populated. */
	it("orders all four layers row > blanket > frontmatter > inherit", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.agents": { scout: { model: AGENT_ROW } },
		});

		expect(
			resolveSubagentModel({
				settings,
				agentName: "scout",
				agentModel: FRONTMATTER,
				activeModelPattern: SESSION,
			}).patterns,
		).toEqual([AGENT_ROW]);
	});

	/** A comma list or YAML list is a preference order, preserved as given. */
	it("keeps a multi-pattern value in order", () => {
		const settings = Settings.isolated({ "subagent.model": `${BLANKET}, ${AGENT_ROW}` });

		expect(resolveSubagentModel({ settings, agentName: "scout" }).patterns).toEqual([BLANKET, AGENT_ROW]);
	});

	/** With no session model yet (a headless start), the caller's fallback stands in. */
	it("inherits the fallback pattern when the session has no active model", () => {
		const settings = Settings.isolated();

		const resolved = resolveSubagentModel({
			settings,
			agentName: "task",
			fallbackModelPattern: SESSION,
		});

		expect(resolved.patterns).toEqual([SESSION]);
		expect(resolved.source).toBe("inherit");
	});

	/** An editor previewing an unsaved value must see what saving it would do. */
	it("honors a draft row over the saved one", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: { model: AGENT_ROW } } });

		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			draftModel: BLANKET,
		});

		expect(resolved.patterns).toEqual([BLANKET]);
		expect(resolved.source).toBe("agent");
	});

	/** An empty draft clears the override, so the preview shows the layer beneath. */
	it("treats an empty draft as no row, exposing the layer beneath", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.agents": { scout: { model: AGENT_ROW } },
		});

		const resolved = resolveSubagentModel({ settings, agentName: "scout", draftModel: "" });

		expect(resolved.patterns).toEqual([BLANKET]);
		expect(resolved.source).toBe("blanket");
	});

	/** `ignoreAgentRow` answers "what would this run WITHOUT an override" for the editor. */
	it("skips the agent row when asked for the default beneath it", () => {
		const settings = Settings.isolated({
			"subagent.model": BLANKET,
			"subagent.agents": { scout: { model: AGENT_ROW } },
		});

		const resolved = resolveSubagentModel({ settings, agentName: "scout", ignoreAgentRow: true });

		expect(resolved.patterns).toEqual([BLANKET]);
		expect(resolved.source).toBe("blanket");
	});
});

describe("subagent model: a configured value that resolves to nothing refuses", () => {
	/**
	 * NO SILENT FALL-THROUGH. This is the third leg of the original defect: a
	 * configured value that expanded to nothing quietly handed the decision to the
	 * next layer, so a typo in the subagent model looked exactly like the setting
	 * having no effect — the operator's own value vanished without a word.
	 *
	 * The resolver reports the layer and the value instead, and every caller
	 * refuses the spawn with that text.
	 */
	it("reports an unresolvable blanket model instead of using the frontmatter", () => {
		const settings = Settings.isolated({ "subagent.model": "@smol" });

		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			agentModel: "google/gemini-2.5-pro",
			activeModelPattern: "anthropic/claude-opus-4-5",
		});

		expect(resolved.patterns).toEqual([]);
		expect(resolved.unresolved).toEqual({ source: "blanket", value: "@smol" });
	});

	/** Same rule one layer up: a broken per-agent row does not fall to the blanket model. */
	it("reports an unresolvable agent row instead of using subagent.model", () => {
		const settings = Settings.isolated({
			"subagent.model": "anthropic/claude-sonnet-4-5",
			"subagent.agents": { scout: { model: "@designer" } },
		});

		const resolved = resolveSubagentModel({ settings, agentName: "scout" });

		expect(resolved.unresolved).toEqual({ source: "agent", value: "@designer" });
		expect(resolved.patterns).toEqual([]);
	});

	/**
	 * And in the frontmatter, which is where the retired `@task` alias still lurks
	 * in older agent files. Resolving it to the literal string would push the
	 * failure into model matching, where the message says only "no model matched"
	 * and never mentions the role that no longer exists.
	 */
	it("reports a retired role alias left in an agent definition", () => {
		const settings = Settings.isolated();

		const resolved = resolveSubagentModel({
			settings,
			agentName: "old-agent",
			agentModel: "@task",
			activeModelPattern: "anthropic/claude-opus-4-5",
		});

		expect(resolved.unresolved).toEqual({ source: "frontmatter", value: "@task" });
	});

	/** The label names the exact setting to edit, which is what makes the refusal actionable. */
	it("names the setting behind every layer", () => {
		expect(subagentModelSourceLabel("agent", "scout")).toBe("subagent.agents.scout.model");
		expect(subagentModelSourceLabel("blanket", "scout")).toBe("subagent.model");
		expect(subagentModelSourceLabel("frontmatter", "scout")).toBe("scout agent frontmatter");
		expect(subagentModelSourceLabel("inherit", "scout")).toBe("inherited from the session model");
	});
});

describe("subagent thinking level", () => {
	/** The agent's own row is the most specific effort choice. */
	it("prefers the agent's row over the definition and the blanket setting", () => {
		const settings = Settings.isolated({
			"subagent.thinkingLevel": "low",
			"subagent.agents": { scout: { thinkingLevel: "high" } },
		});

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout", agentThinkingLevel: AUTO_THINKING })).toBe(
			ThinkingLevel.High,
		);
	});

	/**
	 * THE BLANKET SETTING BEATS FRONTMATTER, and this case used to assert the
	 * opposite. It was the reported bug surviving in the effort axis: bundled agents
	 * carry a `thinking-level` even though they carry no `model:` (scout `medium`,
	 * librarian `minimal`), so with frontmatter ranked higher, setting "Subagent
	 * Effort" did nothing for exactly those agents while appearing to be set. The
	 * order now matches `resolveSubagentModel` layer for layer, which is also what
	 * the docs have always claimed.
	 */
	it("prefers the blanket setting over the definition's own level", () => {
		const settings = Settings.isolated({ "subagent.thinkingLevel": "low" });

		expect(
			resolveSubagentThinkingLevel({ settings, agentName: "scout", agentThinkingLevel: ThinkingLevel.Medium }),
		).toBe(ThinkingLevel.Low);
		expect(resolveSubagentThinkingLevel({ settings, agentName: "task", agentThinkingLevel: AUTO_THINKING })).toBe(
			ThinkingLevel.Low,
		);
	});

	/** Then the blanket setting, so one value can raise effort across every subagent. */
	it("falls back to the blanket thinking level", () => {
		const settings = Settings.isolated({ "subagent.thinkingLevel": "low" });

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBe(ThinkingLevel.Low);
	});

	/** With no setting at all, the definition's own level is what is left to use. */
	it("uses the definition's level when no setting names one", () => {
		expect(
			resolveSubagentThinkingLevel({
				settings: Settings.isolated(),
				agentName: "scout",
				agentThinkingLevel: ThinkingLevel.Medium,
			}),
		).toBe(ThinkingLevel.Medium);
	});

	/**
	 * The per-agent row is still the most specific layer, so one agent can be raised
	 * or lowered without moving the rest.
	 */
	it("prefers the agent's row over the blanket setting and the definition", () => {
		const settings = Settings.isolated({
			"subagent.thinkingLevel": "low",
			"subagent.agents": { scout: { thinkingLevel: "xhigh" } },
		});

		expect(
			resolveSubagentThinkingLevel({ settings, agentName: "scout", agentThinkingLevel: ThinkingLevel.Medium }),
		).toBe(ThinkingLevel.XHigh);
	});

	/**
	 * Effort and model must answer in the SAME order, because the docs describe them
	 * with one sentence and an operator reasons about them together. This asserts the
	 * shape rather than one pair of values, so the two cannot drift apart again the
	 * way they had.
	 */
	it("resolves in the same layer order as the model", () => {
		const blanketOnly = Settings.isolated({ "subagent.model": "openai/gpt-5", "subagent.thinkingLevel": "low" });
		const modelFromBlanket = resolveSubagentModel({
			settings: blanketOnly,
			agentName: "scout",
			agentModel: "anthropic/claude-opus-4-5",
			activeModelPattern: "anthropic/claude-sonnet-4-5",
		});
		const effortFromBlanket = resolveSubagentThinkingLevel({
			settings: blanketOnly,
			agentName: "scout",
			agentThinkingLevel: ThinkingLevel.Medium,
		});

		// Both took the blanket layer over the definition's frontmatter.
		expect(modelFromBlanket.source).toBe("blanket");
		expect(effortFromBlanket).toBe(ThinkingLevel.Low);
	});

	/** Nothing configured means inherit, reported as undefined rather than a guess. */
	it("returns undefined when nothing sets a level", () => {
		expect(resolveSubagentThinkingLevel({ settings: Settings.isolated(), agentName: "scout" })).toBeUndefined();
	});

	/**
	 * A typo must read as "inherited", never as a neighbouring level. Silently
	 * running at an effort nobody chose is both a wrong answer and an invisible
	 * one, and effort changes cost.
	 */
	it("ignores an unparseable level instead of guessing one", () => {
		const settings = Settings.isolated({ "subagent.agents": { scout: { thinkingLevel: "hihg" } } });

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBeUndefined();
	});

	/**
	 * Ignoring it silently is the other half of the bug: "inherited" is exactly what
	 * an operator sees when they set nothing, so a typo left them with a setting that
	 * looked configured and did nothing. The value is named, and so are the levels
	 * that would have worked.
	 */
	it("reports an unparseable level rather than ignoring it quietly", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			// A value no other case uses, because the report fires once per process.
			const settings = Settings.isolated({ "subagent.agents": { scout: { thinkingLevel: "hgih" } } });
			resolveSubagentThinkingLevel({ settings, agentName: "scout" });
		} finally {
			restore();
		}

		const reported = warnings.find(message => message.includes("hgih"));
		expect(reported).toBeDefined();
		expect(reported).toContain("subagent.agents.scout.thinkingLevel");
		expect(reported).toContain("inherited");
		for (const level of CLI_THINKING_LEVELS) expect(reported).toContain(level);
	});

	/** The blanket setting is named too, so the message points at the right key. */
	it("names the blanket setting when that is the value at fault", () => {
		const warnings: string[] = [];
		const restore = captureLoggerWarnings(warnings);
		try {
			resolveSubagentThinkingLevel({
				settings: Settings.isolated({ "subagent.thinkingLevel": "extreme" }),
				agentName: "scout",
			});
		} finally {
			restore();
		}

		const reported = warnings.find(message => message.includes("extreme"));
		expect(reported).toBeDefined();
		expect(reported).toContain("subagent.thinkingLevel");
		expect(reported).not.toContain("subagent.agents");
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
				"subagent.thinkingLevel": "",
				"subagent.agents": { scout: { thinkingLevel: "   " } },
			});
			expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBeUndefined();
		} finally {
			restore();
		}

		expect(warnings).toEqual([]);
	});
});

describe("subagent effort choices", () => {
	/**
	 * The blanket effort was a free-text field: any string was accepted and an
	 * unrecognized one resolved to "inherited". It is picked from the one effort
	 * vocabulary now, so a typo cannot be entered in the first place.
	 */
	it("offers the effort setting as a picked list, not a text field", () => {
		invalidateSettingDefsCache();
		const def = getSettingsForTab("subagents").find(entry => entry.path === "subagent.thinkingLevel");
		expect(def?.type).toBe("submenu");
	});

	/** Every accepted selector is offered, plus one explicit inherit row. */
	it("offers exactly the accepted selectors plus inherit", () => {
		const options = configuredThinkingLevelOptions();
		expect(options[0]?.value).toBe(INHERIT_EFFORT_OPTION_VALUE);
		expect(options.slice(1).map(option => option.value)).toEqual([...CLI_THINKING_LEVELS]);
	});

	/**
	 * Labels come from the shared metadata table rather than the raw selector, so a
	 * level cannot be renamed on one surface only. Descriptions are what make the
	 * rows choosable without reading the docs.
	 */
	it("labels and describes every row from the shared metadata", () => {
		for (const option of configuredThinkingLevelOptions()) {
			expect(option.label.length).toBeGreaterThan(0);
			expect(option.description.length).toBeGreaterThan(0);
		}
		const minimal = configuredThinkingLevelOptions().find(option => option.value === ThinkingLevel.Minimal);
		expect(minimal?.label).toBe("min");
	});

	/**
	 * The value the inherit row stores must be one the resolver reads as unset, or
	 * choosing Inherit would write a level that resolves to nothing while looking
	 * like a choice — the same defect this list replaced.
	 */
	it("stores an inherit value the resolver treats as unset", () => {
		const settings = Settings.isolated({ "subagent.thinkingLevel": INHERIT_EFFORT_OPTION_VALUE });

		expect(resolveSubagentThinkingLevel({ settings, agentName: "scout" })).toBeUndefined();
	});
});

describe("delegation strength", () => {
	/** Delegation is available but never pushed, which is the shipped default. */
	it("defaults to allowed", () => {
		const settings = Settings.isolated();

		expect(delegationStrength(settings)).toBe("allowed");
		expect(delegationEnabled(settings)).toBe(true);
		expect(delegationPreferred(settings)).toBe(false);
		expect(delegationRequired(settings)).toBe(false);
	});

	/** `off` removes the task tool entirely rather than describing a tool nobody may use. */
	it("reports off as no delegation at all", () => {
		const settings = Settings.isolated({ "subagent.delegation": "off" });

		expect(delegationEnabled(settings)).toBe(false);
		expect(delegationPreferred(settings)).toBe(false);
		expect(delegationRequired(settings)).toBe(false);
	});

	/** `preferred` asks the prompt to push work out, without the first-turn reminder. */
	it("reports preferred as a push without the reminder", () => {
		const settings = Settings.isolated({ "subagent.delegation": "preferred" });

		expect(delegationEnabled(settings)).toBe(true);
		expect(delegationPreferred(settings)).toBe(true);
		expect(delegationRequired(settings)).toBe(false);
	});

	/** `required` is the strongest: the push plus the eager first-turn prelude. */
	it("reports required as a push plus the reminder", () => {
		const settings = Settings.isolated({ "subagent.delegation": "required" });

		expect(delegationPreferred(settings)).toBe(true);
		expect(delegationRequired(settings)).toBe(true);
	});
});
