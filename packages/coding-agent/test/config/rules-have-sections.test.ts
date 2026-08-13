/**
 * Rules are sectioned, and an experimental section ships off.
 *
 * WHY THIS SUITE EXISTS. Thirty-one bundled rules used to arrive as one flat
 * alphabetical list with no way to say "this one is not ready". Two things
 * follow from fixing that, and both are load-bearing:
 *
 * The directory a rule ships in IS its section, and the section is what decides
 * both grouping and whether it ships on. That makes the file tree the reviewable
 * artifact — moving a file changes behaviour — which only holds if the table and
 * the tree cannot drift apart. A rule file nobody registered is worse than a
 * missing feature: it looks shipped in the tree and does nothing at runtime.
 *
 * An experimental rule is OFF until named in `ttsr.experimentalRules`, which
 * inverts `ttsr.disabledRules`. A rule injects text into a live session, so the
 * cost of getting this backwards is spending the operator's context on an
 * unproven rule and having the model blamed for it. The tests drive the real
 * funnel rather than the settings array, because what is promised is that the
 * rule does not RUN, not that a name sits in a list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TempDir } from "@veyyon/utils";
import { setAgentDir } from "@veyyon/utils/dirs";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "../../src/capability/rule";
import { bucketRules, resolveRuleLevers, ruleIsEnabled } from "../../src/capability/rule-buckets";
import { Settings, settings } from "../../src/config/settings";
import { buildBuiltinRules } from "../../src/discovery/builtin-defaults";
import {
	BUILTIN_RULE_SECTIONS,
	BUILTIN_RULE_SOURCES,
	type BuiltinRuleSection,
	isExperimentalSection,
} from "../../src/discovery/builtin-rules";
import { createSourceMeta } from "../../src/discovery/helpers";
import { TtsrManager } from "../../src/export/ttsr";
import { invalidateSettingDefsCache } from "../../src/modes/components/settings-defs";
import { SettingsSelectorComponent } from "../../src/modes/components/settings-selector";
import { initTheme } from "../../src/modes/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../helpers/stdout-geometry";
import { enterTempHome, type TempHome } from "../helpers/temp-home";

const RULES_DIR = join(import.meta.dirname, "../../src/discovery/builtin-rules");

/** Rule names that survived the levers, whichever bucket they landed in. */
function survivingRuleNames(options: { disabledRules?: string[]; experimentalRules?: string[] } = {}): string[] {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
	});
	const buckets = bucketRules(buildBuiltinRules(), manager, options);
	return [
		...manager.getRules().map(rule => rule.name),
		...buckets.rulebookRules.map(rule => rule.name),
		...buckets.alwaysApplyRules.map(rule => rule.name),
	];
}

/**
 * A rule as the loader would hand one over, with a real `SourceMeta`.
 *
 * `level`/`provider` are parameters because two of the levers below are about
 * WHERE a rule came from, and a hand-built source that omitted the fields the
 * registry fills in would type-check only behind a cast.
 */
function rule(
	overrides: Partial<Rule> & { name: string },
	origin?: { provider: string; level: "user" | "project" },
): Rule {
	const path = `${origin?.provider ?? BUILTIN_DEFAULTS_PROVIDER_ID}:${overrides.name}.md`;
	return {
		path,
		content: "body",
		description: "a rule",
		...overrides,
		_source: createSourceMeta(origin?.provider ?? BUILTIN_DEFAULTS_PROVIDER_ID, path, origin?.level ?? "user"),
	};
}

describe("the file tree is the section table", () => {
	/**
	 * Every markdown file under the rules directory is registered, in the section
	 * named by the directory holding it. Both directions matter: an unregistered
	 * file is a rule that silently never ships, and a registered file in the wrong
	 * directory means the tree lies about what is experimental.
	 */
	test("every rule file is registered under the section it lives in", () => {
		const onDisk = new Map<string, string>();
		for (const section of Object.keys(BUILTIN_RULE_SECTIONS)) {
			for (const entry of readdirSync(join(RULES_DIR, section))) {
				if (entry.endsWith(".md")) onDisk.set(entry.slice(0, -3), section);
			}
		}
		const registered = new Map(BUILTIN_RULE_SOURCES.map(source => [source.name, source.section as string]));

		expect([...registered.keys()].sort()).toEqual([...onDisk.keys()].sort());
		for (const [name, section] of onDisk) {
			expect(registered.get(name), `${name} is registered under the wrong section`).toBe(section);
		}
	});

	/** No rule file may sit loose at the root: an unsectioned rule has no heading to render under. */
	test("no rule file sits outside a section directory", () => {
		const loose = readdirSync(RULES_DIR).filter(entry => entry.endsWith(".md"));
		expect(loose).toEqual([]);
	});

	/** The loader stamps both facts onto the rule, or nothing downstream can group or gate it. */
	test("the provider stamps the section and the experimental flag onto every rule", () => {
		const built = new Map(buildBuiltinRules().map(built => [built.name, built]));
		for (const source of BUILTIN_RULE_SOURCES) {
			const rule = built.get(source.name);
			expect(rule?.section).toBe(source.section);
			expect(rule?.experimental).toBe(isExperimentalSection(source.section));
		}
	});
});

describe("an experimental rule ships off", () => {
	test("it does not reach any bucket on a stock install", () => {
		const experiments = BUILTIN_RULE_SOURCES.filter(source => isExperimentalSection(source.section));
		expect(experiments.length).toBeGreaterThan(0);
		const surviving = survivingRuleNames();
		for (const { name } of experiments) expect(surviving).not.toContain(name);
	});

	test("naming it in the opt-in list turns it on", () => {
		const experiment = BUILTIN_RULE_SOURCES.find(source => isExperimentalSection(source.section));
		if (!experiment) throw new Error("expected at least one experimental rule");
		expect(survivingRuleNames({ experimentalRules: [experiment.name] })).toContain(experiment.name);
	});

	/**
	 * Off wins. The two lists can both name a rule — a hand-edited config, or an
	 * opt-in left behind after the operator later turned the rule off — and the
	 * safe reading of a contradiction about injecting text is "do not".
	 */
	test("a rule in both lists stays off", () => {
		const experiment = BUILTIN_RULE_SOURCES.find(source => isExperimentalSection(source.section));
		if (!experiment) throw new Error("expected at least one experimental rule");
		const surviving = survivingRuleNames({
			experimentalRules: [experiment.name],
			disabledRules: [experiment.name],
		});
		expect(surviving).not.toContain(experiment.name);
	});

	/** The opt-in is scoped to the rule named, not to the section. */
	test("opting one in leaves the others off", () => {
		const enabled = ruleIsEnabled(
			rule({ name: "b", experimental: true }),
			resolveRuleLevers({ experimentalRules: ["a"] }),
		);
		expect(enabled).toBe(false);
	});

	/** The opt-in list must not resurrect a rule that is not experimental at all. */
	test("naming a stable rule in the opt-in list changes nothing", () => {
		const levers = resolveRuleLevers({ experimentalRules: ["ts-no-any"], disabledRules: ["ts-no-any"] });
		expect(ruleIsEnabled(rule({ name: "ts-no-any" }), levers)).toBe(false);
	});

	/** Whitespace is trimmed on the opt-in list exactly as it is on the disable list. */
	test("a hand-edited opt-in with stray whitespace still matches", () => {
		const experiment = BUILTIN_RULE_SOURCES.find(source => isExperimentalSection(source.section));
		if (!experiment) throw new Error("expected at least one experimental rule");
		expect(survivingRuleNames({ experimentalRules: [`  ${experiment.name}  `] })).toContain(experiment.name);
	});
});

describe("ruleIsEnabled is the one owner of the question", () => {
	/**
	 * `bucketRules` routes an enabled rule and `ttsr scan` reports on one, and they
	 * used to answer this from two hand-rolled copies of the same three checks.
	 * Every lever is asserted through the exported predicate so the copies cannot
	 * come back one at a time.
	 */
	test("each lever independently takes a rule out", () => {
		const stable = rule({ name: "ts-no-any" });
		expect(ruleIsEnabled(stable, resolveRuleLevers({}))).toBe(true);
		expect(ruleIsEnabled(stable, resolveRuleLevers({ disabledRules: ["ts-no-any"] }))).toBe(false);
		expect(ruleIsEnabled(stable, resolveRuleLevers({ builtinRules: false }))).toBe(false);
		expect(ruleIsEnabled(rule({ name: "x", experimental: true }), resolveRuleLevers({}))).toBe(false);
	});

	/** `builtinRules: false` drops the bundle, not the operator's own rules. */
	test("turning built-ins off leaves a project rule running", () => {
		const project = rule({ name: "house-style" }, { provider: "native", level: "project" });
		expect(ruleIsEnabled(project, resolveRuleLevers({ builtinRules: false }))).toBe(true);
	});
});

/**
 * The rule list is two screens: an index of sections, and one section's rules.
 *
 * WHY THIS BLOCK EXISTS. Thirty-one rules in one list is a wall, and the first
 * shape tried was a flat list with group headers, which kept the wall and only
 * labelled it. The section a rule ships in is the fact that decides whether it
 * runs at all, so it earns a screen. Two levels also introduce the one bug a
 * flat list could not have: a toggle or an Escape that lands on the WRONG level
 * — toggling a rule and being thrown back to the index re-costs the operator
 * the drill-in for every rule they wanted to flip, and an Escape that closes
 * the whole list instead of stepping up one level makes the second level a trap.
 * Neither is visible in the stored setting, only in which frame comes back, so
 * these drive the real component and read the real frame.
 */
describe("the rule list is a section index you drill into", () => {
	let settingsState: SettingsTestState | undefined;
	let geometry: StubbedStdoutGeometry | undefined;
	let temp: TempDir | undefined;
	let tempHome: TempHome | undefined;

	const WIDTH = 160;
	const ENTER = "\r";
	const ESCAPE = "\x1b";
	const DOWN = "\x1b[B";
	/** The glyph `SelectList` puts in front of the selected row. */
	const CURSOR = "\u203a";
	/** The row that opens the list. Its own value is the summary the list collapses to. */
	const RULES_ROW = "ttsr.disabledRules";

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		invalidateSettingDefsCache();
		// Discovery is real, so the answer depends on what is on disk. An empty
		// agent dir and an empty home leave exactly the bundled rules, which is
		// what the counts below are derived from; without this the suite would
		// pass or fail on whether the machine running it has personal rules.
		//
		// The home has to move through `enterTempHome`, not through
		// `process.env.HOME`. Bun resolves `os.homedir()` once at process start,
		// so assigning the variable moves nothing: this suite spent its life
		// reading whichever rules the developer happened to have in their real
		// `~/.veyyon`, while looking isolated. The helper installs the `homedir`
		// spy, enters a config root under the temp home, and asserts the resolver
		// actually landed there before any test body runs.
		tempHome = enterTempHome();
		temp = TempDir.createSync("rules-sections-");
		mkdirSync(temp.join("agent"), { recursive: true });
		setAgentDir(temp.join("agent"));
		await Settings.init({ inMemory: true });
		geometry = stubStdoutGeometry({ columns: WIDTH, rows: 48 });
	});

	afterEach(() => {
		geometry?.restore();
		geometry = undefined;
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		invalidateSettingDefsCache();
		temp?.removeSync();
		temp = undefined;
		// After the temp dir, because the helper restores the `homedir` spy and
		// leaves the isolated config root: unwinding it first would put the real
		// home back while this suite still had state pointed at the temp one.
		tempHome?.restore();
		tempHome = undefined;
		invalidateSettingDefsCache();
	});

	afterAll(() => {
		invalidateSettingDefsCache();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: ["default"],
				providers: ["anthropic"],
				cwd: temp?.join("project") ?? process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
	}

	function frame(component: SettingsSelectorComponent): string {
		return component.render(WIDTH).map(stripVTControlCharacters).join("\n");
	}

	/**
	 * Yield to the event loop until the list has loaded, rather than sleeping.
	 * Discovery is async and a frame taken before it lands reads "Reading rules…",
	 * which contains none of the strings below and would fail for the wrong reason.
	 */
	async function settle(component: SettingsSelectorComponent): Promise<string> {
		for (let attempt = 0; attempt < 500; attempt++) {
			const text = frame(component);
			if (!text.includes("Reading rules")) return text;
			const tick = Promise.withResolvers<void>();
			setImmediate(tick.resolve);
			await tick.promise;
		}
		throw new Error("the rule list never finished loading");
	}

	/** Open Settings → Rules → the Rules row, and wait for the section index. */
	async function openIndex(): Promise<SettingsSelectorComponent> {
		const component = createSelector();
		component.openTab("rules");
		expect(component.selectSetting(RULES_ROW)).toBe(true);
		component.handleInput(ENTER);
		await settle(component);
		return component;
	}

	/**
	 * Walk the list to the row naming `needle` with the down arrow, then Enter.
	 *
	 * Arrows rather than a typed query, because `SelectList` accepts a filter only
	 * while the list overflows its visible rows and neither rule screen does — a
	 * test that typed its way to a row would be exercising a path the operator
	 * cannot use. The card draws the sidebar and the content pane on one physical
	 * line and the sidebar carries a cursor of its own, so the pane is taken by
	 * column first; reading the cursor anywhere on the line would accept the
	 * sidebar's and report a row as reached that was never selected.
	 */
	function pick(component: SettingsSelectorComponent, needle: string): void {
		for (let step = 0; step <= 40; step++) {
			const landed = component.render(WIDTH).some(line => {
				const columns = stripVTControlCharacters(line).split("\u2502");
				const pane = columns.at(-2) ?? "";
				return columns.length >= 3 && pane.trimStart().startsWith(CURSOR) && pane.includes(needle);
			});
			if (landed) {
				component.handleInput(ENTER);
				return;
			}
			component.handleInput(DOWN);
		}
		throw new Error(`no selectable row named ${needle}`);
	}

	/** `Built-in · TypeScript`, the label the index renders for a bundled section. */
	function sectionLabel(section: BuiltinRuleSection): string {
		return `Built-in · ${BUILTIN_RULE_SECTIONS[section].label}`;
	}

	function namesIn(section: BuiltinRuleSection): string[] {
		return BUILTIN_RULE_SOURCES.filter(source => source.section === section).map(source => source.name);
	}

	test("the index is one row per section, each carrying its own count", async () => {
		const text = frame(await openIndex());
		for (const section of Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[]) {
			const label = sectionLabel(section);
			const rows = text.split("\n").filter(line => line.includes(label));
			expect(rows.length, `${label} should be exactly one row`).toBe(1);
			expect(rows[0]).toContain(`${namesIn(section).length} rule`);
		}
		// The index is the index: no individual rule name has leaked onto it.
		for (const name of namesIn("typescript")) expect(text).not.toContain(name);
	});

	test("every section row agrees with its own rule count, in number and in plural", async () => {
		const text = frame(await openIndex());
		for (const section of Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[]) {
			const count = namesIn(section).length;
			const row = text.split("\n").find(line => line.includes(sectionLabel(section)));
			// "1 rules" is the tell that the count was formatted by concatenation.
			expect(row, `${sectionLabel(section)} row`).toContain(`${count} rule${count === 1 ? "" : "s"}`);
			if (count !== 1) expect(row).not.toContain(`${count} rule `);
		}
	});

	test("an experimental section says every rule under it is off", async () => {
		const text = frame(await openIndex());
		const experimental = (Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[]).filter(section =>
			isExperimentalSection(section),
		);
		expect(experimental).toHaveLength(1);
		const row = text.split("\n").find(line => line.includes(sectionLabel(experimental[0] as BuiltinRuleSection)));
		expect(row).toContain("all off");
	});

	test("a section with every rule on says so rather than counting to zero", async () => {
		const text = frame(await openIndex());
		const row = text.split("\n").find(line => line.includes(sectionLabel("workflow")));
		expect(row).toContain(`${namesIn("workflow").length} rules · all on`);
	});

	test("opening a section lists exactly the rules under it", async () => {
		const component = await openIndex();
		pick(component, "Workflow");
		const text = frame(component);
		for (const name of namesIn("workflow")) expect(text).toContain(name);
		for (const name of namesIn("typescript")) expect(text).not.toContain(name);
		for (const name of namesIn("go")) expect(text).not.toContain(name);
	});

	test("Escape inside a section steps up to the index instead of closing the list", async () => {
		const component = await openIndex();
		pick(component, "Workflow");
		expect(frame(component)).toContain(namesIn("workflow")[0] as string);

		component.handleInput(ESCAPE);
		const back = frame(component);
		// Back at the index: every section is listed again and no rule name is.
		expect(back).toContain(sectionLabel("typescript"));
		expect(back).toContain(sectionLabel("workflow"));
		for (const name of namesIn("workflow")) expect(back).not.toContain(name);

		// And the list itself is still open — one more Escape is what leaves it.
		component.handleInput(ESCAPE);
		const closed = frame(component);
		expect(closed).not.toContain(sectionLabel("typescript"));
		expect(closed).toContain("Built-in Rules");
	});

	test("toggling a rule keeps you in the section, with the row flipped", async () => {
		const component = await openIndex();
		pick(component, "Workflow");
		const target = namesIn("workflow")[0] as string;

		pick(component, target);
		const text = frame(component);
		expect(settings.get("ttsr.disabledRules")).toContain(target);
		// Still the section, not the index: the other workflow rules are on screen.
		for (const name of namesIn("workflow")) expect(text).toContain(name);
		expect(text).not.toContain(sectionLabel("typescript"));
		const row = text.split("\n").find(line => line.includes(target));
		expect(row).toContain("off");
	});

	test("an experimental rule is turned on through the opt-in list, from the same row", async () => {
		const component = await openIndex();
		pick(component, "Experimental");
		const experiment = namesIn("experimental")[0] as string;

		pick(component, experiment);
		expect(settings.get("ttsr.experimentalRules")).toContain(experiment);
		// The opt-in never lands in the disable list, which would read as an
		// exception-to-on and turn the rule off the moment it shipped stable.
		expect(settings.get("ttsr.disabledRules")).not.toContain(experiment);
		expect(
			frame(component)
				.split("\n")
				.find(line => line.includes(experiment)),
		).toContain("on");
	});

	/**
	 * Closing the list writes its summary back onto the row that opened it. The
	 * experiment count is reported separately from the off count: an opted-in
	 * experiment is the one non-default state here that "all on" would hide.
	 */
	test("the row collapses to a summary naming both lists", async () => {
		const component = await openIndex();
		pick(component, "Experimental");
		pick(component, namesIn("experimental")[0] as string);
		component.handleInput(ESCAPE);
		component.handleInput(ESCAPE);
		// The whole card, not one located line: the row's own label is `Rules`, which
		// is also the sidebar entry and the card title, so a line search for it is
		// three ways to pick the wrong line.
		expect(frame(component)).toContain("all on, 1 experimental on");
	});

	/**
	 * Neither rule screen may promise a filter it cannot honour. `SelectList` takes
	 * a typed query only while the list overflows its visible rows, and splitting
	 * thirty-one rules into five sections put every one of these lists under that
	 * line — so the footer inherited from the flat list described a filter that
	 * silently ignored every key pressed at it.
	 */
	test("the footer offers a filter only when the list is long enough to have one", async () => {
		const component = await openIndex();
		expect(frame(component)).not.toContain("type to filter");
		for (const section of Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[]) {
			pick(component, sectionLabel(section));
			expect(frame(component), `${sectionLabel(section)} footer`).not.toContain("type to filter");
			component.handleInput(ESCAPE);
		}
	});
});
