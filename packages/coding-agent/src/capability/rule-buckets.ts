/**
 * Rule bucketing
 *
 * Single funnel that every discovered rule passes through on its way into a
 * session. It applies the user's disable levers, registers TTSR rules with the
 * manager, and splits the rest into the always-apply and rulebook buckets.
 *
 * Bucket precedence (matches docs/internal/rulebook-matching-pipeline.md §5):
 *   1. TTSR     — non-empty `condition`/`astCondition` that `TtsrManager.addRule` accepts
 *   2. always   — `alwaysApply === true`
 *   3. rulebook — has a `description`
 */
import type { TtsrManager } from "../export/ttsr";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: readonly string[];
	/** When false, drop every rule from the bundled `builtin-defaults` provider. */
	builtinRules?: boolean;
	/**
	 * Experimental rule names the operator has explicitly turned on.
	 *
	 * The inverse of `disabledRules`, and deliberately a second list rather than
	 * a shared one: `disabledRules` stores exceptions to on, so a rule that ships
	 * off cannot be expressed in it at all. Keeping them apart also means turning
	 * an experimental rule on, and later un-shipping it, leaves a stale name in a
	 * list that grants nothing rather than one that silently suppresses a rule
	 * that came back.
	 */
	experimentalRules?: readonly string[];
}

/**
 * Whether a rule reaches the session at all, given the operator's levers.
 *
 * The one owner of that question. `bucketRules` routes an enabled rule into a
 * bucket and `ttsr scan` reports on it, and both used to re-derive enablement
 * from the same three fields with their own copy of the trimming and the
 * builtin check. Two copies of a predicate agree until one of them learns
 * something, which is exactly what adding the experimental gate would have
 * done: the scan would have listed a rule as armed that the session drops.
 */
export function ruleIsEnabled(rule: Rule, levers: EnabledRuleLevers): boolean {
	if (levers.disabled.has(rule.name)) return false;
	if (!levers.includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
	// Off wins. A name in both lists is a contradiction, and the safe reading of
	// a contradiction about injecting text into a live session is "do not".
	if (rule.experimental === true && !levers.enabledExperiments.has(rule.name)) return false;
	return true;
}

/** The levers above, resolved once so a filter loop does not re-trim per rule. */
export interface EnabledRuleLevers {
	includeBuiltin: boolean;
	disabled: ReadonlySet<string>;
	enabledExperiments: ReadonlySet<string>;
}

/** Names, trimmed the way every caller has always trimmed them. */
function nameSet(names: readonly string[] | undefined): Set<string> {
	const set = new Set<string>();
	for (const raw of names ?? []) {
		const name = raw.trim();
		if (name.length > 0) set.add(name);
	}
	return set;
}

/** Resolve the operator's three levers into the form `ruleIsEnabled` reads. */
export function resolveRuleLevers(options: BucketRulesOptions): EnabledRuleLevers {
	return {
		includeBuiltin: options.builtinRules !== false,
		disabled: nameSet(options.disabledRules),
		enabledExperiments: nameSet(options.experimentalRules),
	};
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Disabled rules are dropped before any bucket assignment, so a
 * disabled rule is neither matched as TTSR nor surfaced via `rule://`.
 */
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
