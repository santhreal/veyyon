/**
 * The Rules settings surface: every rule on unless it is turned off.
 *
 * `ttsr.disabledRules` stores EXCEPTIONS, not selections, and the whole design rests on
 * that inversion: a bundled rule added in a later release must arrive on rather than
 * waiting for every existing config to opt in. A "list the ones you want" storage shape
 * would look identical in the settings screen and would silently ship every new rule off.
 *
 * These drive the real funnel (`bucketRules`, the single place the disable levers are
 * enforced) rather than the submenu's rendering, because what the operator is promised is
 * that the toggle changes which rules RUN — not that a name appeared in an array.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "../../src/capability/rule";
import { bucketRules } from "../../src/capability/rule-buckets";
import { BUILTIN_RULE_SOURCES } from "../../src/discovery/builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "../../src/discovery/helpers";
import { TtsrManager } from "../../src/export/ttsr";
import { getSettingDef, invalidateSettingDefsCache } from "../../src/modes/components/settings-defs";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
	invalidateSettingDefsCache();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	invalidateSettingDefsCache();
});

/** Every bundled rule, built exactly as the `builtin-defaults` provider builds them. */
function bundledRules(): Rule[] {
	return BUILTIN_RULE_SOURCES.map(({ name, content }) => {
		const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${name}.md`;
		return buildRuleFromMarkdown(
			name,
			content,
			virtualPath,
			createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user"),
			{ ruleName: name },
		);
	});
}

/** Rule names that survived the disable levers, whichever bucket they landed in. */
function survivingRuleNames(disabledRules: string[], builtinRules = true): string[] {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
	});
	const buckets = bucketRules(bundledRules(), manager, { disabledRules, builtinRules });
	return [
		...manager.getRules().map(rule => rule.name),
		...buckets.rulebookRules.map(rule => rule.name),
		...buckets.alwaysApplyRules.map(rule => rule.name),
	];
}

describe("the default state of the rule list", () => {
	/**
	 * The promise the settings row makes. Every bundled rule — the TypeScript
	 * conventions, the Go and Rust ones, the nudges — is live on a stock install, and
	 * the stored exception list is empty.
	 */
	test("every bundled rule is on when nothing has been turned off", () => {
		const surviving = survivingRuleNames([]);
		for (const { name } of BUILTIN_RULE_SOURCES) {
			expect(surviving).toContain(name);
		}
		expect(surviving.length).toBe(BUILTIN_RULE_SOURCES.length);
	});

	/**
	 * The inversion, stated as a test. A rule nobody has heard of is on, which is what
	 * makes shipping a new bundled rule a one-file change instead of a migration.
	 */
	test("a rule the config has never mentioned is on, not off", () => {
		expect(survivingRuleNames(["ts-no-any"])).toContain("commit-drift");
	});
});

describe("turning one rule off", () => {
	/**
	 * The toggle's actual job. The submenu writes a name into `ttsr.disabledRules`, and
	 * that name must stop the rule from reaching the model through ANY bucket — not just
	 * from being registered for matching.
	 */
	test("removes exactly that rule and leaves its neighbours running", () => {
		const surviving = survivingRuleNames(["ts-no-any"]);
		expect(surviving).not.toContain("ts-no-any");
		expect(surviving).toContain("ts-no-tiny-functions");
		expect(surviving.length).toBe(BUILTIN_RULE_SOURCES.length - 1);
	});

	/** Turning it back on is removing the name again: the state is the array, nothing else. */
	test("turning it back on restores it", () => {
		expect(survivingRuleNames([])).toContain("ts-no-any");
	});

	/**
	 * The submenu trims names before storing, and `bucketRules` trims before comparing.
	 * A hand-edited config with stray whitespace must disable the rule it names rather
	 * than silently matching nothing.
	 */
	test("a name stored with stray whitespace still disables its rule", () => {
		expect(survivingRuleNames(["  ts-no-any  "])).not.toContain("ts-no-any");
	});

	/**
	 * The master switch stays above the per-rule list. With built-ins off, every row in
	 * the list is off regardless of the exception array — which is exactly what the
	 * submenu's warning banner tells the reader.
	 */
	test("the built-in master switch turns off every bundled rule at once", () => {
		expect(survivingRuleNames([], false)).toEqual([]);
	});
});

describe("the settings row", () => {
	/**
	 * The row must open the rule list, not a text box. It rendered as a comma-separated
	 * text field for as long as it existed, which required knowing a rule's exact name
	 * before you could turn it off and offered no way to discover the names.
	 */
	test("opens the rule editor rather than a free-text field", () => {
		const def = getSettingDef("ttsr.disabledRules");
		expect(def?.type).toBe("rules");
	});

	/** It stays on the Rules group, beside the master switch it is qualified by. */
	test("sits in the rules group where the master switch already lives", () => {
		expect(getSettingDef("ttsr.disabledRules")?.group).toBe(getSettingDef("ttsr.builtinRules")?.group);
	});
});
