import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "../../../capability/rule";
import { PROVIDER_ID as NATIVE_RULES_PROVIDER_ID } from "../../../discovery/builtin";
import { BUILTIN_RULE_SECTIONS, type BuiltinRuleSection } from "../../../discovery/builtin-rules";

export const RULE_LIST_MAX_ROWS = 12;
export const BUNDLED_SECTION_ORDER: readonly BuiltinRuleSection[] = Object.keys(
	BUILTIN_RULE_SECTIONS,
) as BuiltinRuleSection[];

export function ruleSectionRank(rule: Rule): number {
	if (rule._source?.provider === NATIVE_RULES_PROVIDER_ID) return -2;
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) return -1;
	const index = BUNDLED_SECTION_ORDER.indexOf(rule.section as BuiltinRuleSection);
	return index < 0 ? BUNDLED_SECTION_ORDER.length : index;
}

export function ruleSectionLabel(rule: Rule): string {
	if (rule._source?.provider === NATIVE_RULES_PROVIDER_ID) {
		return "User created";
	}
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) {
		return rule._source?.provider ? `From ${rule._source.provider}` : "From this project";
	}
	const meta = BUILTIN_RULE_SECTIONS[rule.section as BuiltinRuleSection];
	return meta ? `Built-in · ${meta.label}` : "Built-in";
}
