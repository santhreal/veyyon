/**
 * WHY THIS SUITE EXISTS (SUBAGENT-MODEL-AND-EFFORT-HAVE-ONE-OWNER — THE WHOLE CLASS).
 *
 * The defect: Settings → Subagents → Agents → <agent> carried its own Model and Effort rows, and both
 * outranked the blanket Subagent Model and Subagent Effort settings. Two screens answered one question
 * and disagreed on screen — the per-agent Model row printed an inherited value with an effort suffix
 * while the Effort row under it said inherit. The rows were DELETED rather than hidden, because a hidden
 * layer that outranks the visible setting is the same drift wearing a different hat.
 *
 * The class is: what a subagent RUNS has exactly one owner per axis, and nothing may reintroduce a
 * second one. A test that pins the two retired field names closes the incident and nothing else — the
 * next `subagent.agents.<name>.effort`, or a fourth precedence layer under a new name, lands green.
 * So every case here derives its variant space at run time and fails by default:
 *
 *  1. WHICH SETTINGS DECIDE. Every `subagent.*` path in `SETTINGS_SCHEMA` is probed against the real
 *     resolvers, and the set that changes the answer must be exactly `subagent.model` and
 *     `subagent.thinkingLevel`. A new setting that reaches either resolver turns this RED.
 *  2. WHAT A PER-AGENT ROW MAY DECIDE. Row field names are derived from the schema's own `subagent.*`
 *     leaf names, so the sweep grows with the settings area rather than with someone's memory. No field
 *     may change the resolved model or effort; exactly one may change enablement and exactly one the
 *     nested spawn depth, pinned by equality in both directions.
 *  3. WHICH LAYER ANSWERED. The `SubagentModelSource` values a combinatorial sweep can actually produce
 *     must be exactly blanket, frontmatter and inherit. Re-adding an `agent` layer produces a fourth.
 *  4. WHAT THE SCREEN OFFERS. The real Agents editor is driven and its editable rows are pinned by
 *     exact equality, so adding a per-agent Model or Effort row back to the UI turns this RED even if
 *     no resolver reads it yet.
 *  5. THE STALE COPY. A config already carrying the retired fields is loaded through the real loader,
 *     resolved, reloaded, and edited, because a persisted shape is how a fixed bug comes back after the
 *     fix ships.
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
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { resolveEffectiveSubagentThinkingLevel } from "@veyyon/coding-agent/task/executor";
import {
	isSubagentEnabled,
	RETIRED_AGENT_ROW_FIELDS,
	resetRetiredAgentRowReports,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	type SubagentModelSource,
	subagentModelSourceLabel,
} from "@veyyon/coding-agent/task/subagent-settings";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
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

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	resetRetiredAgentRowReports();
	geometryStub = stubStdoutGeometry({ columns: 200, rows: 60 });
});

afterEach(() => {
	resetSettingsForTest();
	resetRetiredAgentRowReports();
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
	const contexts: Array<{ agentName: string; agentModel?: string; agentThinkingLevel?: ThinkingLevel }> = [
		{ agentName: AGENT },
		{ agentName: AGENT, agentModel: FRONTMATTER_MODEL, agentThinkingLevel: ThinkingLevel.High },
		{ agentName: "reviewer", agentModel: FRONTMATTER_MODEL },
	];
	return contexts
		.map(context => {
			const model = resolveSubagentModel({
				settings: store,
				agentName: context.agentName,
				agentModel: context.agentModel,
				activeModelPattern: SESSION_MODEL,
				fallbackModelPattern: FALLBACK_MODEL,
			});
			const effort = resolveSubagentThinkingLevel({
				settings: store,
				agentName: context.agentName,
				agentThinkingLevel: context.agentThinkingLevel,
			});
			return [
				context.agentName,
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
			// The retired shape plus the live one, so a table that starts deciding models again is
			// caught whichever field name it comes back under.
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

/** Paths whose probe moves the resolved model or effort. */
function pathsThatDecideWhatASubagentRuns(): SettingPath[] {
	const baseline = resolutionFingerprint(Settings.isolated());
	return SUBAGENT_PATHS.filter(candidate => {
		const entry: SchemaEntry = SETTINGS_SCHEMA[candidate];
		return probeValuesFor(entry).some(
			value => resolutionFingerprint(Settings.isolated({ [candidate]: value })) !== baseline,
		);
	});
}

describe("exactly two settings decide what a subagent runs", () => {
	/**
	 * The ownership ratchet, stated as a set rather than as a pair of positive cases.
	 *
	 * A per-agent layer is only one way to get a second owner. Any `subagent.*` setting that reaches
	 * either resolver is one, and the assertion is that there are no others rather than that the two
	 * known ones work.
	 */
	it("names them, and finds no third", () => {
		expect(pathsThatDecideWhatASubagentRuns()).toEqual(["subagent.model", "subagent.thinkingLevel"]);
	});

	/**
	 * The sweep's own control. Without it a fingerprint that never changes — a resolver call that threw
	 * and was swallowed, a probe generator that produced nothing — passes the case above by finding
	 * nothing at all.
	 */
	it("has a fingerprint that actually moves", () => {
		const baseline = resolutionFingerprint(Settings.isolated());

		expect(resolutionFingerprint(Settings.isolated({ "subagent.model": BLANKET_MODEL }))).not.toBe(baseline);
		expect(resolutionFingerprint(Settings.isolated({ "subagent.thinkingLevel": "low" }))).not.toBe(baseline);
		expect(SUBAGENT_PATHS.length).toBeGreaterThan(10);
		expect(SUBAGENT_PATHS).toContain("subagent.agents");
	});

	/**
	 * Precedence is total and stated once: the blanket setting, then the agent's own file, then the
	 * session. Two layers being right in isolation says nothing about which wins when both are set,
	 * which is the exact question the deleted table got wrong.
	 */
	it("orders the three layers blanket over frontmatter over inherit", () => {
		const blanket = Settings.isolated({ "subagent.model": BLANKET_MODEL, "subagent.thinkingLevel": "low" });
		const nothing = Settings.isolated();

		expect(
			resolveSubagentModel({
				settings: blanket,
				agentName: AGENT,
				agentModel: FRONTMATTER_MODEL,
				activeModelPattern: SESSION_MODEL,
			}).patterns,
		).toEqual([BLANKET_MODEL]);
		expect(
			resolveSubagentThinkingLevel({
				settings: blanket,
				agentName: AGENT,
				agentThinkingLevel: ThinkingLevel.High,
			}),
		).toBe(ThinkingLevel.Low);
		expect(
			resolveSubagentModel({
				settings: nothing,
				agentName: AGENT,
				agentModel: FRONTMATTER_MODEL,
				activeModelPattern: SESSION_MODEL,
			}).patterns,
		).toEqual([FRONTMATTER_MODEL]);
		expect(
			resolveSubagentModel({ settings: nothing, agentName: AGENT, activeModelPattern: SESSION_MODEL }).patterns,
		).toEqual([SESSION_MODEL]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-agent table: which lanes are offered, and nothing about what they run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field names a per-agent row could plausibly carry, derived from the schema's own `subagent.*` leaf
 * names plus the two that were retired.
 *
 * Derived rather than listed so that adding `subagent.somethingNew` also probes
 * `subagent.agents.<name>.somethingNew`, which is how a per-agent layer would come back: as the row
 * twin of a blanket setting someone just added.
 */
const ROW_FIELDS: string[] = [
	...new Set([
		...SUBAGENT_PATHS.map(candidate => candidate.slice(candidate.lastIndexOf(".") + 1)),
		"model",
		"thinkingLevel",
		"effort",
	]),
].sort();

/** Every probe value any `subagent.*` type produces, so each field is tried with all of them. */
const ROW_VALUES: unknown[] = [
	...new Set(SUBAGENT_PATHS.flatMap(candidate => probeValuesFor(SETTINGS_SCHEMA[candidate]))),
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

describe("a per-agent row decides which lanes are offered and nothing else", () => {
	const scout: AgentDefinition = { name: AGENT, source: "bundled" } as AgentDefinition;

	/**
	 * The headline. No field a row can carry — retired, current, or one invented tomorrow as the twin of
	 * a new blanket setting — may change the model or the effort the agent runs.
	 */
	it("changes neither the model nor the effort, whatever field it carries", () => {
		expect(rowFieldsThatChange(resolutionFingerprint)).toEqual([]);
		// The sweep is only worth anything if it is actually writing rows the reader can see.
		expect(ROW_FIELDS).toContain("model");
		expect(ROW_FIELDS).toContain("thinkingLevel");
		expect(ROW_FIELDS).toContain("maxNestedSpawnDepth");
		expect(ROW_VALUES.length).toBeGreaterThan(5);
	});

	/**
	 * And the two axes a row DOES own, pinned in both directions. Equality rather than `toContain`,
	 * because a row quietly gaining a third axis is the same defect as a row keeping the model.
	 */
	it("owns exactly enablement and nested spawn depth", () => {
		expect(rowFieldsThatChange(store => String(isSubagentEnabled(store, scout)))).toEqual(["enabled"]);
		expect(rowFieldsThatChange(store => String(resolveSubagentMaxNestedSpawnDepth(store, AGENT)))).toEqual([
			"maxNestedSpawnDepth",
		]);
	});

	/**
	 * A retired row must not truncate a chain either. It used to REPLACE the blanket list wholesale, so
	 * one leftover single-model row silently stripped every fallback the operator had configured.
	 */
	it("keeps the whole blanket chain in order over a leftover row", () => {
		const store = Settings.isolated({
			"subagent.model": `${BLANKET_MODEL}, ${FALLBACK_MODEL}, ${FRONTMATTER_MODEL}`,
			"subagent.agents": { [AGENT]: { model: "openai/gpt-5-mini", thinkingLevel: "max" } },
		});

		const resolved = resolveSubagentModel({ settings: store, agentName: AGENT });

		expect(resolved.source).toBe("blanket");
		expect(resolved.patterns).toEqual([BLANKET_MODEL, FALLBACK_MODEL, FRONTMATTER_MODEL]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Which layer answered.
// ─────────────────────────────────────────────────────────────────────────────

describe("the layer that chose a subagent's model is one of exactly three", () => {
	/**
	 * Enumerated by driving the resolver over every combination rather than by reading the union: a
	 * fourth member added to the type is only a defect once something can produce it, and a fourth
	 * member produced without being added to the type is the same defect with no type error.
	 */
	function producedSources(): SubagentModelSource[] {
		const produced = new Set<SubagentModelSource>();
		for (const blanket of [undefined, BLANKET_MODEL, "@no-such-role"]) {
			for (const row of [undefined, { model: FALLBACK_MODEL, thinkingLevel: "high" }]) {
				for (const frontmatter of [undefined, FRONTMATTER_MODEL]) {
					for (const active of [undefined, SESSION_MODEL]) {
						const store = Settings.isolated({
							...(blanket ? { "subagent.model": blanket } : {}),
							...(row ? { "subagent.agents": { [AGENT]: row } } : {}),
						});
						produced.add(
							resolveSubagentModel({
								settings: store,
								agentName: AGENT,
								agentModel: frontmatter,
								activeModelPattern: active,
							}).source,
						);
					}
				}
			}
		}
		return [...produced].sort();
	}

	it("produces blanket, frontmatter and inherit, and never a per-agent layer", () => {
		expect(producedSources()).toEqual(["blanket", "frontmatter", "inherit"]);
	});

	/**
	 * Each layer is named by the setting an operator can go and change. "agent" used to be one of these
	 * and its label pointed at the row that outranked everything; a label that still named a row would
	 * send someone to a screen that no longer decides anything.
	 */
	it("names a real setting for every layer, and no per-agent row", () => {
		const labels: Record<SubagentModelSource, string> = {
			blanket: subagentModelSourceLabel("blanket", AGENT),
			frontmatter: subagentModelSourceLabel("frontmatter", AGENT),
			inherit: subagentModelSourceLabel("inherit", AGENT),
		};

		expect(labels.blanket).toBe("subagent.model");
		expect(labels.frontmatter).toContain("frontmatter");
		expect(new Set(Object.values(labels)).size).toBe(3);
		for (const label of Object.values(labels)) {
			expect(label).not.toContain(`subagent.agents.${AGENT}`);
		}
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
		if (
			content()
				.find(line => line.includes(agentName))
				?.includes("›")
		)
			break;
		if (step > 64) throw new Error(`never landed on the ${agentName} row`);
		component.handleInput("\u001b[B");
	}
	component.handleInput("\n");

	/**
	 * Enumerate the editor's rows by walking the list rather than by pattern-matching the frame. The
	 * screen also prints what the lane RUNS and where to change it, and those sentences carry the words
	 * "Model" and "Effort" — a text scan would read the pointer as a control.
	 */
	const rows = (): string[] => {
		const seen: string[] = [];
		for (let step = 0; step < 16; step++) {
			const selected = content().find(line => line.includes("›"));
			if (!selected) break;
			const label = selected.replace("›", "").trim();
			if (seen.includes(label)) break;
			seen.push(label);
			component.handleInput("\u001b[B");
		}
		return seen;
	};
	return { component, frame, rows };
}

describe("the Agents editor offers no model or effort control", () => {
	/**
	 * The editor's rows, pinned by exact equality.
	 *
	 * This is the fail-by-default half of the ownership class that no resolver sweep can provide: a
	 * Model or Effort row added back to this screen writes a value nothing reads, which is precisely the
	 * state the deletion removed, and it would pass every resolver sweep above.
	 */
	it("offers exactly the two rows a lane's availability needs", async () => {
		const editor = await openAgentEditor(AGENT);

		const rows = editor.rows();
		expect(rows.length).toBe(2);
		expect(rows[0]?.startsWith("Enabled")).toBe(true);
		expect(rows[1]?.startsWith("Nested spawn depth")).toBe(true);
		for (const row of rows) {
			expect(row, row).not.toMatch(/\b(Model|Effort|Thinking)\b/);
		}
	});

	/**
	 * What the lane runs is still SHOWN here, as a fact with a pointer to the one place it is decided.
	 * Removing the row without saying where the answer moved would leave the screen looking like the
	 * setting had vanished.
	 */
	it("shows what the lane runs and names the settings that decide it", async () => {
		const body = (await openAgentEditor(AGENT)).frame().join("\n");

		expect(body).toContain("Runs");
		expect(body).toContain("Subagent Model");
		expect(body).toContain("Subagent Effort");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The stale copy on disk.
// ─────────────────────────────────────────────────────────────────────────────

const makeRetiredRowDir = useTrackedTempDirs("veyyon-retired-agent-row-");

describe("a config still carrying the retired per-agent shape", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeRetiredRowDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "retired-agent-row"));
			agentDir = "";
		}
	});

	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	/**
	 * Through the REAL loader, not `Settings.isolated`. A persisted shape is how a fixed bug comes back:
	 * the value survives the release that removed the code reading it, and the next reader has to decide
	 * what to do with it. Reading it back once proves nothing about the second load, so both are checked.
	 */
	it("resolves the blanket answer on the first load and on the stale reload", async () => {
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
				activeModelPattern: SESSION_MODEL,
			});

			expect(model.patterns, pass).toEqual([BLANKET_MODEL]);
			expect(model.source, pass).toBe("blanket");
			expect(resolveSubagentThinkingLevel({ settings: store, agentName: AGENT }), pass).toBe(ThinkingLevel.Low);
			// The lane is still offered: the half of the row that still has a home survives untouched.
			expect(isSubagentEnabled(store, { name: AGENT, source: "bundled" } as AgentDefinition), pass).toBe(true);
		}
	});

	/**
	 * EVERY leftover in the table is named, not just the one belonging to whichever agent happened to
	 * spawn, and not just the first one found. The report used to be scoped to the resolving agent, so a
	 * retired model on a DISABLED agent was never mentioned: that agent never resolves, so the value sat
	 * in the operator's config looking configured and doing nothing, which is the exact state this
	 * retirement exists to end. An operator cannot be expected to enable an agent in order to find out
	 * that its setting is dead. Two agents carry leftovers here rather than one, because a dedupe keyed
	 * on the field alone silences every agent after the first and a single-agent case cannot see it.
	 */
	it("names every leftover in the table, on agents that never spawn as well", async () => {
		const leftovers = Object.fromEntries(
			RETIRED_AGENT_ROW_FIELDS.map(field => [field, field === "model" ? FALLBACK_MODEL : "max"]),
		);
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
		resetRetiredAgentRowReports();
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
				RETIRED_AGENT_ROW_FIELDS.map(field => [`subagent.agents.${agent}.${field}`, 1]),
			),
		);
		const counted = Object.fromEntries(
			Object.keys(expected).map(setting => [setting, warnings.filter(message => message.includes(setting)).length]),
		);

		expect(counted).toEqual(expected);
		// The agent whose row carries nothing retired is not mentioned at all.
		expect(warnings.filter(message => message.includes("subagent.agents.librarian"))).toEqual([]);
	});

	/**
	 * A dropped value is only acceptable if the operator is told, once per field, with the setting that
	 * replaced it. Once per field and not once per spawn: this runs on every resolution, and a report
	 * per spawn is a log flood that gets filtered out and then never read.
	 */
	it("names each retired field once, however many times a spawn resolves", async () => {
		writeConfig({
			subagent: { agents: { [AGENT]: { model: FALLBACK_MODEL, thinkingLevel: "max" } } },
		});
		const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		resetRetiredAgentRowReports();
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
		expect(reported.length).toBe(2);
		expect(reported.find(message => message.includes(".model"))).toContain("Subagent Model");
		expect(reported.find(message => message.includes(".thinkingLevel"))).toContain("Subagent Effort");
		for (const message of reported) expect(message).toContain("no longer read");
	});

	/** A blank leftover is what a cleared picker stored, so nobody is losing a value and nobody is told. */
	it("says nothing about a blank leftover field", async () => {
		writeConfig({ subagent: { agents: { [AGENT]: { model: "", thinkingLevel: "   " } } } });
		const store = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		resetRetiredAgentRowReports();
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
	 * And the stale fields do not survive the next edit of that row. Toggling the lane on is driven
	 * through the real editor, because the scrub lives in the editor's write path: it rebuilds the row
	 * from the fields it still owns rather than spreading the stored one, so a leftover is dropped
	 * instead of being rewritten into the file for the next reader to wonder about.
	 */
	it("drops the retired fields when the operator next edits the row", async () => {
		// `model` and `thinkingLevel` were removed from `SubagentAgentSettings`, so the stale shape is
		// no longer expressible as a literal. It is still what an older config holds on disk.
		const staleRow: SubagentAgentSettings = { enabled: false, maxNestedSpawnDepth: 2 };
		Object.assign(staleRow, { model: FALLBACK_MODEL, thinkingLevel: "max" });
		settings.set("subagent.agents", { [AGENT]: staleRow });

		const editor = await openAgentEditor(AGENT);
		// The editor opens on the Enabled row; Enter toggles the lane and writes the row back.
		editor.component.handleInput("\n");

		expect(settings.get("subagent.agents")?.[AGENT]).toEqual({ enabled: true, maxNestedSpawnDepth: 2 });
		expect(resolveSubagentModel({ settings, agentName: AGENT, activeModelPattern: SESSION_MODEL }).patterns).toEqual([
			SESSION_MODEL,
		]);
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
