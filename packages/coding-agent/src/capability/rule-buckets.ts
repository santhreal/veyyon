import type { TtsrManager } from "../export/ttsr";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface BucketRulesOptions {
	disabledRules?: readonly string[];
	builtinRules?: boolean;
	experimentalRules?: readonly string[];
}

export function ruleIsEnabled(rule: Rule, levers: EnabledRuleLevers): boolean {
	if (levers.disabled.has(rule.name)) return false;
	if (!levers.includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
	if (rule.experimental === true && !levers.enabledExperiments.has(rule.name)) return false;
	return true;
}

export interface EnabledRuleLevers {
	includeBuiltin: boolean;
	disabled: ReadonlySet<string>;
	enabledExperiments: ReadonlySet<string>;
}

function nameSet(names: readonly string[] | undefined): Set<string> {
	const set = new Set<string>();
	for (const raw of names ?? []) {
		const name = raw.trim();
		if (name.length > 0) set.add(name);
	}
	return set;
}

export function resolveRuleLevers(options: BucketRulesOptions): EnabledRuleLevers {
	return {
		includeBuiltin: options.builtinRules !== false,
		disabled: nameSet(options.disabledRules),
		enabledExperiments: nameSet(options.experimentalRules),
	};
}

export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const levers = resolveRuleLevers(options);
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];

	for (const rule of rules) {
		if (!ruleIsEnabled(rule, levers)) continue;

		const hasTtsrCondition =
			(rule.condition && rule.condition.length > 0) || (rule.astCondition && rule.astCondition.length > 0);
		const isTtsrRule = hasTtsrCondition ? ttsrManager.addRule(rule) : false;
		if (isTtsrRule) continue;
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules };
}
