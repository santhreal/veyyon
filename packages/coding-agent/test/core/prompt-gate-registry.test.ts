/**
 * The settings that change the system prompt are one list, and flipping one takes effect.
 *
 * WHY THIS SUITE EXISTS. A settings-fed gate in the system prompt used to be declared in up
 * to six places (see `system-prompt-builder/gate-registry.ts` for the list). The one that
 * failed quietly was the last: `modes/controllers/selector-controller.ts` carried a
 * hand-written `case` per setting deciding which flips rebuild the prompt, and it had exactly
 * two of the settings. Flipping `subagent.batch`, `subagent.delegation`, `subagent.maxConcurrency`,
 * `subagent.agents`, `includeModelInPrompt` or `tools.format` changed the setting and left the
 * prompt describing the previous configuration, with nothing
 * logged, until an unrelated rebuild happened to fire.
 *
 * Every check here exists to keep a specific way of getting that wrong from coming back:
 *
 *   - A NEW GATE HAS TO BE CLASSIFIED. The suite partitions every gate variable the prompt
 *     reads into "registered settings gate" and "derived from something other than a setting",
 *     and fails on anything in neither. That is the check with no silent hole: an exemption
 *     list alone would let the next unclassified gate in.
 *
 *     That partition used to run over a regular expression across `system-prompt.md`, which
 *     was the best available handle when the prompt was one document. It is no longer either
 *     accurate or honest. Not honest, because every section is assembled from statements now
 *     and no session reads that file. Not accurate, because the regular expression had a
 *     silent hole: it matched `{{#if}}`, `{{#unless}}`, `{{#each}}`, `{{#ifAny}}` and
 *     `{{#has}}`, so `{{#when MAX_CONCURRENCY ">" 0}}` was a gate it could not see, and
 *     `subagent.maxConcurrency` was therefore partitioned over a set that omitted the one
 *     variable it gates. A statement's condition names its variable structurally, so the
 *     hole cannot exist on this side. The rows are read for block-level gates and the
 *     statement TEXT for the intra-line ones Handlebars still owns, which together are
 *     exactly what reaches the model.
 *   - A ROW CANNOT NAME A SETTING THAT DOES NOT EXIST. Rows carry setting paths as strings,
 *     because the registry cannot import the settings schema without a cycle, so nothing but
 *     a test can tell a real path from a typo. A typo would make a gate permanently
 *     unreachable and look exactly like a working row.
 *   - THE SECOND LIST CANNOT COME BACK. The controller must not carry a per-gate
 *     `refreshBaseSystemPrompt` call any more; if one reappears the registry stops being the
 *     one owner and the two can disagree again.
 *   - THE FROZEN LIST IS PINNED, and each frozen-by-placement row's stated reason is checked
 *     against `sdk.ts` itself: the read really does sit above `rebuildSystemPrompt`. A reason
 *     nobody verifies is a comment, and this one is the difference between "fixed on purpose"
 *     and "fixed by accident".
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { buildSystemPrompt } from "../../src/system-prompt";
import {
	FROZEN_PROMPT_GATE_SETTINGS,
	frozenGateNotice,
	gateSections,
	isLivePromptGate,
	LIVE_PROMPT_GATE_SETTINGS,
	PROMPT_GATE_SETTINGS,
	PROMPT_GATE_VARIABLES,
	PROMPT_GATES,
	promptGateFor,
} from "../../src/system-prompt-builder/gate-registry";
import { conditionVariables, PROMPT_STATEMENTS } from "../../src/system-prompt-builder/statement-registry";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..");
const SDK = path.join(PACKAGE_ROOT, "src/sdk.ts");
const SELECTOR_CONTROLLER = path.join(PACKAGE_ROOT, "src/modes/controllers/selector-controller.ts");

/**
 * Gate variables the PROMPT reads that are NOT fed by a setting, and what feeds each instead.
 *
 * This is a classification, not an exemption: the partition test below requires every gate
 * variable to appear either here or in the registry, so a new one fails until someone decides
 * which it is. Each entry names the source, because "not a setting" is the claim being made
 * and an unexplained entry here would be a place to hide a settings gate.
 *
 * "The prompt reads" means the statement rows plus the Handlebars still inside statement text,
 * which is what `promptGateVariables` returns. It used to mean a regular expression over
 * `system-prompt.md`; see the header for why that was neither accurate nor honest any more.
 */
const NON_SETTINGS_GATES: Readonly<Record<string, string>> = {
	skills: "the discovered skill list",
	rules: "the loaded rulebook rules",
	alwaysApplyRules: "rulebook rules with alwaysApply=true",
	hasTools: "whether the resolved tool set contains at least one tool",
	tools: "the resolved tool name list, tested with the `has` helper",
	secretsEnabled: "whether the obfuscator found secrets in this workspace, not a setting",
	mcpDiscoveryMode: "whether discovery is active and discoverable tools exist for this build",
	hasMCPDiscoveryServers: "whether any discoverable MCP server summaries were produced",
	hasMemoryRoot: "which memory backend resolved, not a setting read directly",
	hasObsidian: "whether an Obsidian vault was discovered",
	hasSpawnableSubagent: "derived from the enabled subagent names for this session",
	useCodexTaskPrompt: "a per-model policy decision keyed off the active model",
	eagerTasks: "delegation strength, gated by subagent.delegation",
	eagerTasksAlways: "delegation strength, gated by subagent.delegation",
	taskBatch: "registered under subagent.batch",
	taskIrcEnabled: "derived from whether IRC coordination is available to this session",
	intentTracing: "registered under tools.intentTracing",
	personality: "registered under personality",
	renderMermaid: "registered under tui.renderMermaid",
	toolListMode: "registered under tools.format and inlineToolDescriptors",
};

/**
 * Every variable a piece of prompt text gates on, found in that text.
 *
 * Only the INTRA-LINE conditionals need finding this way. A statement's own condition is a
 * value, so it is read from the row instead of matched out of prose. Kept as a helper because
 * both sides of `promptGateVariables` need it: statement text still contains `{{#if label}}`
 * inside an `{{#each}}`, and that is a real gate on what a statement says.
 */
function gateVariablesIn(source: string): Set<string> {
	const found = new Set<string>();
	// `{{#if x}}`, `{{#unless x}}`, `{{#each x}}`, `{{#ifAny a b}}`, and `{{#has tools "x"}}`
	// where the gated thing is the collection rather than the quoted member.
	for (const match of source.matchAll(/\{\{#(?:if|unless|each|ifAny|has)\s+([^}]+)\}\}/g)) {
		for (const token of (match[1] ?? "").split(/\s+/)) {
			// Drop quoted members, parenthesised sub-expressions, and helper names: the gate is
			// the identifier, and `.length` is a property of it rather than a separate gate.
			const bare = token.replace(/^\(+|\)+$/g, "").split(".")[0] ?? "";
			if (bare === "" || bare.startsWith('"') || bare === "includes") continue;
			found.add(bare);
		}
	}
	return found;
}

/**
 * Every variable the prompt gates text on, read from the statements the prompt is assembled from.
 *
 * Two sources because there are two kinds of gate, and the split is the statement design: a ROW's
 * condition decides whether a statement is present, and Handlebars inside the statement's text
 * decides what it says. Both reach the model, so both are gates the partition has to classify.
 */
function promptGateVariables(): string[] {
	const found = new Set<string>();
	for (const statement of PROMPT_STATEMENTS) {
		for (const variable of conditionVariables(statement.condition)) found.add(variable);
		for (const variable of gateVariablesIn(statement.text)) found.add(variable);
	}
	return [...found].sort();
}

/**
 * Every variable a statement REFERENCES, gated on or interpolated.
 *
 * A wider question than `promptGateVariables`, and both are needed because a gate row names "the
 * template variables this setting decides" and a setting can decide a variable that is not a gate.
 * `tools.intentTracing` is the case: `intentTracing` gates whether the bullet appears, and
 * `intentField` is the parameter name interpolated INTO that bullet, so it is decided by the
 * setting while never appearing in a conditional. Kept separate from the gate set so the partition
 * test stays a statement about gates and does not quietly start accepting any interpolation.
 */
function statementVariables(): Set<string> {
	const found = new Set(promptGateVariables());
	for (const statement of PROMPT_STATEMENTS) {
		for (const match of statement.text.matchAll(/\{\{+([^}]+)\}\}+/g)) {
			for (const token of (match[1] ?? "").split(/\s+/)) {
				const bare = token.replace(/^[#/(]+|\)+$/g, "").split(".")[0] ?? "";
				if (bare === "" || bare.startsWith('"')) continue;
				found.add(bare);
			}
		}
	}
	return found;
}

describe("the prompt gate registry", () => {
	it("registers at least twelve settings whose prompt effects must be classified", () => {
		// A floor, not the list, so adding a gate does not fail here. The exact membership is
		// pinned by the live/frozen tests below, which is where a change should have to be
		// argued.
		expect(PROMPT_GATES.length).toBeGreaterThanOrEqual(12);
		expect(new Set(PROMPT_GATE_SETTINGS).size, "a setting is registered twice").toBe(PROMPT_GATE_SETTINGS.length);
	});

	it("names only settings the schema actually defines", () => {
		// Rows carry paths as strings because the registry cannot import the schema without a
		// cycle. A typo would produce a gate that never fires and reads as a working row.
		const known = new Set(Object.keys(SETTINGS_SCHEMA));
		for (const gate of PROMPT_GATES) {
			expect(known.has(gate.setting), `${gate.setting} is not a defined setting path`).toBe(true);
		}
	});

	/**
	 * Every variable a gate names is one the TEMPLATE actually reads.
	 *
	 * This check found three wrong rows the moment it existed. `subagent.maxConcurrency` named
	 * `taskMaxConcurrency`, which is the builder OPTION's name; `system-prompt.ts` hands the template
	 * `MAX_CONCURRENCY`, so the row described a variable no `{{#if}}` could ever read. The other two
	 * named themselves as though a `{{#if includeWorkspaceTree}}` existed, when both actually decide
	 * whether a runtime section is assembled.
	 *
	 * It matters beyond tidiness: the statement registry validates a condition's variable against
	 * these rows, so a row naming the wrong thing rejects a CORRECT condition and accepts nothing in
	 * its place. A registry whose job is to say what a setting changes has to be checkable against
	 * the thing it claims to describe.
	 */
	it("names only variables the prompt actually reads", () => {
		// The statements, not `system-prompt.md`: a gate has to reach the MODEL, and that file is a
		// duplicate no session reads now that all six sections are assembled from rows.
		//
		// Membership in the gate-variable set, not a regular expression over the text, and the
		// difference is the point. A gate's variable is read in one of two places: a statement's
		// CONDITION, which is a value and cannot be matched out of prose, or intra-line Handlebars
		// inside a statement's text. `renderMermaid`, `eagerTasks`, `eagerTasksAlways` and
		// `toolListMode` are all the first kind, so a text search reports them missing while they
		// are in fact the only reason four statements are ever absent. An exact identifier match
		// over both sources is also stricter than the old regular expression, which would accept
		// `{{#if renderMermaidSomethingElse}}` as evidence for a row claiming `renderMermaid`.
		//
		// The set is `statementVariables`, not `promptGateVariables`, because a row may name a
		// variable the setting decides without gating on it: `intentField` is interpolated into the
		// bullet that `intentTracing` gates.
		const read = statementVariables();

		const missing = PROMPT_GATES.flatMap(gate =>
			[...gate.variables]
				.filter(variable => !read.has(variable))
				.map(variable => `${gate.setting} claims ${variable}`),
		);

		expect(missing, `gates naming variables no statement reads: ${missing.join(", ")}`).toEqual([]);
	});

	it("says what each gate renders, in words a reader can act on", () => {
		for (const gate of PROMPT_GATES) {
			expect(gate.renders.length, `${gate.setting} has no usable description`).toBeGreaterThan(20);
			expect(gate.renders, `${gate.setting}'s description just repeats the path`).not.toBe(gate.setting);
			// A gate reaches the prompt through a template variable OR by deciding a runtime section,
			// and it must name one of the two. Requiring a VARIABLE specifically was what let
			// `includeModelInPrompt` and `includeWorkspaceTree` sit here for months claiming
			// `{{#if includeModelInPrompt}}` and `{{#if includeWorkspaceTree}}`, neither of which the
			// template has ever contained; both actually gate a runtime section.
			const routes = gate.variables.length + gateSections(gate).length;
			expect(routes, `${gate.setting} names neither a template variable nor a section`).toBeGreaterThan(0);
		}
	});

	it("finds a row by setting path and nothing for a setting that does not gate the prompt", () => {
		expect(promptGateFor("subagent.batch")?.variables).toEqual(["taskBatch"]);
		// `theme` is a real setting that changes the TUI and not one byte of the prompt.
		expect(promptGateFor("theme")).toBeUndefined();
	});
});

describe("which flips reach the model", () => {
	it("treats every live gate as one that rebuilds the prompt", () => {
		expect([...LIVE_PROMPT_GATE_SETTINGS].sort()).toEqual([
			"includeModelInPrompt",
			"inlineToolDescriptors",
			"personality",
			"subagent.agents",
			"subagent.batch",
			"subagent.delegation",
			"subagent.enabled",
			"subagent.maxConcurrency",
			"tools.format",
			// Joined 2026-07-26. See "keeps tools.intentTracing registered, and live" below for what
			// had to change: the schema injection follows the setting now, not just the prompt text.
			"tools.intentTracing",
			"tui.renderMermaid",
		]);
		for (const setting of LIVE_PROMPT_GATE_SETTINGS) {
			expect(isLivePromptGate(setting), `${setting} is registered live but does not read as live`).toBe(true);
		}
	});

	it("covers the six settings the hand-written switch missed", () => {
		// The switch had `personality` and `tui.renderMermaid`. These six changed the setting
		// and left the prompt behind, which is the failure this registry exists to end.
		for (const setting of [
			"subagent.batch",
			"subagent.delegation",
			"subagent.maxConcurrency",
			"subagent.agents",
			"includeModelInPrompt",
			"tools.format",
		]) {
			expect(isLivePromptGate(setting), `${setting} still does not rebuild the prompt`).toBe(true);
		}
	});

	it("does not claim a frozen gate takes effect", () => {
		// Reporting a frozen gate as live would be worse than the original bug: the operator
		// would be told the flip applied.
		for (const setting of FROZEN_PROMPT_GATE_SETTINGS) {
			expect(isLivePromptGate(setting), `${setting} is frozen but reads as live`).toBe(false);
		}
	});

	it("does not treat an unrelated setting as a prompt gate", () => {
		for (const setting of ["theme", "showImages", "tui.tight", "autoCompact"]) {
			expect(isLivePromptGate(setting)).toBe(false);
		}
	});
});

describe("the gates a mid-session flip cannot reach", () => {
	it("pins the frozen list, so it can shrink but not grow unnoticed", () => {
		// `tools.intentTracing` and `inlineToolDescriptors` left this list when their
		// prompt and provider-schema decisions became per-request resolvers.
		expect([...FROZEN_PROMPT_GATE_SETTINGS].sort()).toEqual(["includeWorkspaceTree"]);
	});

	it("makes every frozen gate say why", () => {
		for (const gate of PROMPT_GATES) {
			if (gate.liveness.kind === "live") continue;
			expect(gate.liveness.because.length, `${gate.setting} is frozen with no reason given`).toBeGreaterThan(30);
		}
	});

	it("keeps descriptor placement live while naming the remaining placement accident", () => {
		expect(promptGateFor("inlineToolDescriptors")?.liveness.kind).toBe("live");
		expect(promptGateFor("includeWorkspaceTree")?.liveness.kind).toBe("frozen-by-placement");
	});

	/**
	 * The accident that got fixed, kept as a case rather than deleted with the row.
	 *
	 * `tools.intentTracing` was `frozen-by-placement`, and its `because` said what would have to
	 * change: not just moving the read, but making the tool-schema injection follow the setting too.
	 * Both happened, so it is live. Asserted by NAME because the two lists above would also pass if
	 * the row had simply been deleted, which is a different change with a different meaning.
	 */
	it("keeps tools.intentTracing registered, and live", () => {
		expect(promptGateFor("tools.intentTracing")?.liveness.kind).toBe("live");
		expect(isLivePromptGate("tools.intentTracing")).toBe(true);
		expect(frozenGateNotice("tools.intentTracing")).toBeUndefined();
	});

	it("checks the placement claim against sdk.ts rather than trusting the comment", async () => {
		// A frozen-by-placement row asserts a fact about the source: the setting is read into a
		// closure constant ABOVE `rebuildSystemPrompt`, so every later rebuild re-reads the
		// session-start value. If someone moves the read inside the closure the gate becomes
		// live and this fails, which is the reminder to reclassify it rather than leaving a
		// stale "frozen" label on a gate that now works.
		const source = await Bun.file(SDK).text();
		const closureStart = source.indexOf("const rebuildSystemPrompt =");
		expect(closureStart, "`rebuildSystemPrompt` was renamed; this check needs updating").toBeGreaterThan(0);

		for (const gate of PROMPT_GATES) {
			if (gate.liveness.kind !== "frozen-by-placement") continue;
			const readAt = source.indexOf(`settings.get("${gate.setting}")`);
			expect(readAt, `${gate.setting} is not read by that path in sdk.ts`).toBeGreaterThan(0);
			expect(readAt, `${gate.setting} is read inside the rebuild closure, so it is not frozen`).toBeLessThan(
				closureStart,
			);
		}
	});

	/**
	 * THE MIRROR OF THAT CHECK, for the gate that decides something OUTSIDE the prompt.
	 *
	 * `tools.intentTracing` also controls whether every tool schema carries the intent field, and that
	 * half is wired by handing the agent a resolver rather than a value. Invoking it at the call site
	 * (`intentTracing: intentTracingEnabled()`) compiles, keeps every prompt test green, and silently
	 * returns the gate to frozen for the schemas: the prompt would explain a field the schemas stopped
	 * carrying. A mutation run confirmed nothing else catches it.
	 *
	 * This reads the source rather than driving a session, and that is the right tool for this claim:
	 * the claim IS about the wiring, not about behaviour. `packages/agent`'s
	 * `intent-tracing-follows-the-setting.test.ts` proves the behaviour on the agent side by flipping a
	 * resolver between two requests; what no test there can see is which of the two forms `sdk.ts`
	 * actually passes.
	 */
	it("checks that sdk.ts hands the agent a resolver, not a resolved value", async () => {
		const source = await Bun.file(SDK).text();

		expect(source, "the resolver was renamed; this check needs updating").toContain(
			"const intentTracingEnabled = () =>",
		);
		expect(source).toContain("intentTracing: intentTracingEnabled,");
		expect(
			source.includes("intentTracing: intentTracingEnabled()"),
			"sdk.ts resolves intentTracing at construction, which refreezes the tool schemas",
		).toBe(false);
	});
});

describe("telling the operator when a flip did nothing", () => {
	it("explains every frozen gate, naming the setting and what it would have changed", () => {
		// The silent case this replaces: the settings UI shows the new value, the prompt keeps
		// the old text, and nothing distinguishes that from a change that applied.
		for (const setting of FROZEN_PROMPT_GATE_SETTINGS) {
			const notice = frozenGateNotice(setting);

			expect(notice, `${setting} flips with no explanation`).toBeDefined();
			expect(notice).toContain(setting);
			expect(notice).toContain("next session");
			expect(notice).toContain(promptGateFor(setting)?.renders ?? "");
		}
	});

	it("says nothing for a gate that did apply", () => {
		// A notice on a live gate would be a false warning, which trains the operator to ignore
		// the real ones.
		for (const setting of LIVE_PROMPT_GATE_SETTINGS) {
			expect(frozenGateNotice(setting), `${setting} applied but warns anyway`).toBeUndefined();
		}
	});

	it("says nothing for a setting that does not touch the prompt", () => {
		expect(frozenGateNotice("theme")).toBeUndefined();
		expect(frozenGateNotice("showImages")).toBeUndefined();
	});
});

describe("the controller no longer keeps its own list", () => {
	it("drives the rebuild from the registry", async () => {
		const source = await Bun.file(SELECTOR_CONTROLLER).text();

		expect(source).toContain("isLivePromptGate(id)");
	});

	it("tells the operator about a frozen gate instead of letting the flip go unremarked", async () => {
		const source = await Bun.file(SELECTOR_CONTROLLER).text();

		expect(source).toContain("frozenGateNotice(id)");
	});

	it("carries no per-setting rebuild case, which is the list that drifted", async () => {
		// The failure was two lists that had to agree. One `refreshBaseSystemPrompt` call driven
		// by `isLivePromptGate` is the whole point; a second call in a `case` arm would mean the
		// hand-written list is back, and it would be the one that goes stale again.
		const source = await Bun.file(SELECTOR_CONTROLLER).text();
		const calls = [...source.matchAll(/refreshBaseSystemPrompt\(/g)];

		expect(calls.length, "more than one rebuild site means the registry is not the only owner").toBe(1);
	});
});

describe("every gate in the template is accounted for", () => {
	it("classifies each one as a registered setting gate or as fed by something else", () => {
		// The check with no silent hole. A new gate fails here until someone decides which it is,
		// which is what the six-place chain never forced anyone to do.
		const inTemplate = promptGateVariables();
		const registered = new Set(PROMPT_GATE_VARIABLES);
		const classified = new Set(Object.keys(NON_SETTINGS_GATES));

		const unaccounted = inTemplate.filter(variable => !registered.has(variable) && !classified.has(variable));

		expect(unaccounted, `unclassified gate variables: ${unaccounted.join(", ")}`).toEqual([]);
	});

	it("reads real gates out of the statements, so the partition is not over an empty set", () => {
		// Both sides going empty would pass forever. 23 variables are gated on across the 68
		// statements; the floor is deliberately below that so ordinary edits do not fail here,
		// but a registry that stopped being read would.
		const inTemplate = promptGateVariables();

		expect(inTemplate.length).toBeGreaterThan(15);
		expect(inTemplate).toContain("intentTracing");
		expect(inTemplate).toContain("taskBatch");
		expect(inTemplate).toContain("personality");
		// The one the template regular expression could not see, because `{{#when x ">" 0}}` was
		// not in its alternation. A row names its variable, so this side cannot miss it.
		expect(inTemplate).toContain("MAX_CONCURRENCY");
	});

	it("does not carry a classification for a variable the prompt stopped gating on", () => {
		// A stale entry is how the exemption side of a partition rots: it keeps passing while
		// describing a gate that no longer exists, and the next reader trusts it.
		const inTemplate = new Set(promptGateVariables());
		const stale = Object.keys(NON_SETTINGS_GATES).filter(variable => !inTemplate.has(variable));

		expect(stale, `classified but no longer gated on: ${stale.join(", ")}`).toEqual([]);
	});
});

/** The minimum a `WorkspaceTree` needs to satisfy the builder without discovering anything. */
const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

describe("the rendered template data carries every gate", () => {
	/**
	 * PLACE 5 OF THE SIX, checked rather than derived.
	 *
	 * `system-prompt.ts` hands the template a context object built by hand, and a gate that is missing
	 * a key there renders as though it were off: the setting resolves, the option arrives, and the
	 * text silently never appears. That is not hypothetical. `system-prompt-builder/default-template.ts`
	 * records `taskIrcEnabled` and `eagerTasksAlways` being dropped by an edit exactly this way, and
	 * nothing failed.
	 *
	 * The build here is a real `buildSystemPrompt`, and the assertion reads `statementContext`, which
	 * IS the context the statements were rendered with. That matters over inspecting the source: a
	 * context key present in the file but overwritten, shadowed, or dropped by a later spread still
	 * fails here.
	 */
	async function renderedContext(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const result = await buildSystemPrompt({
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
			rules: [],
			workspaceTree: EMPTY_TREE,
			activeRepoContext: null,
			...overrides,
		} as Parameters<typeof buildSystemPrompt>[0]);
		// Never null for an assembled prompt: null means a custom prompt replaced the assembly, which
		// would make every assertion below vacuous.
		expect(result.statementContext).not.toBeNull();
		return result.statementContext as unknown as Record<string, unknown>;
	}

	it("passes each registered gate variable to the template", async () => {
		const data = await renderedContext();

		const missing = PROMPT_GATE_VARIABLES.filter(variable => !(variable in data));

		expect(missing, `registered but never reaches the template: ${missing.join(", ")}`).toEqual([]);
	});

	/**
	 * Presence is not enough on its own: a key whose value is always `undefined` reads as off for every
	 * configuration, which is the same failure with a key in place. Every gate variable the template
	 * TESTS must arrive with a defined value.
	 *
	 * `tools` is excluded because it is the tool map rather than a gate value, and the empty-map case is
	 * meaningful; it is covered by the `{{#has tools "task"}}` assertions in the delegation suites.
	 */
	it("gives each one a defined value rather than a key that is always falsy by accident", async () => {
		const data = await renderedContext();

		const undefinedValues = PROMPT_GATE_VARIABLES.filter(
			variable => variable !== "tools" && variable in data && data[variable] === undefined,
		);

		expect(undefinedValues, `reaches the template as undefined: ${undefinedValues.join(", ")}`).toEqual([]);
	});

	/*
	 * A CASE WAS DELETED HERE on 2026-08-04: "still carries the two variables an edit once dropped",
	 * two bare `expect(data.taskIrcEnabled).toBeDefined()` calls. Its own doc comment said the list
	 * check above "would also fail if either went missing", so it added no coverage, and `toBeDefined`
	 * is satisfied by the key arriving as `false`, `""` or `0` -- which is the state the case beside it
	 * ("passes through what the caller asked for, not a fixed value") is the actual guard against. A
	 * better failure MESSAGE is not a test.
	 */

	/**
	 * And the value follows the option rather than being pinned to whatever the default renders. A key
	 * that arrives defined but constant is the third way this can be wrong.
	 */
	it("passes through what the caller asked for, not a fixed value", async () => {
		const data = await renderedContext({ taskBatch: false, eagerTasksAlways: true, taskMaxConcurrency: 7 });

		expect(data.taskBatch).toBe(false);
		expect(data.eagerTasksAlways).toBe(true);
		// The option is `taskMaxConcurrency`; the template reads `MAX_CONCURRENCY`, which is why the
		// registry contracts the TEMPLATE's name.
		expect(data.MAX_CONCURRENCY).toBe(7);
	});
});
