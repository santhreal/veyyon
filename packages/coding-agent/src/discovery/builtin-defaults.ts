/**
 * Builtin Defaults Provider
 *
 * Ships a curated set of default rules (mostly TTSR conventions) embedded into
 * the binary. Registered at the lowest priority so any user/project/tool rule
 * with the same `name` overrides the bundled copy (first-wins dedup by name).
 *
 * Users disable bundled rules three ways:
 *   - flip `ttsr.builtinRules` off (drops the whole set),
 *   - list a name in `ttsr.disabledRules` (drops one rule),
 *   - define a same-named rule in any higher-priority source (overrides it).
 * The first two are enforced in `bucketRules` (see capability/rule-buckets.ts).
 *
 * A rule in an experimental section arrives the other way round: it is off
 * until named in `ttsr.experimentalRules`, and the same funnel enforces that.
 * Both the section and the experimental flag come from the directory the rule
 * ships in, so the file tree is what a reviewer reads to know both.
 */
import { registerProvider } from "../capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { BUILTIN_RULE_SOURCES, isExperimentalSection } from "./builtin-rules";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

const DISPLAY_NAME = "Builtin Defaults";
// Lowest priority: every other rule provider wins a name conflict.
const PRIORITY = 1;

/**
 * Every bundled rule, built the way the provider builds it.
 *
 * Exported so a test never has to restate this. A test that rebuilds bundled
 * rules with its own copy of the construction is testing its own copy: the one
 * that used to live in `rules-are-on-unless-turned-off` set no section and no
 * experimental flag, so once the sections landed it would have gone on
 * asserting that every bundled rule ships live while the real provider had
 * already stopped shipping one.
 */
export function buildBuiltinRules(): Rule[] {
	return BUILTIN_RULE_SOURCES.map(({ name, content, section }) => {
		const virtualPath = `${BUILTIN_DEFAULTS_PROVIDER_ID}:${section}/${name}.md`;
		const source = createSourceMeta(BUILTIN_DEFAULTS_PROVIDER_ID, virtualPath, "user");
		const rule = buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
		return { ...rule, section, experimental: isExperimentalSection(section) };
	});
}

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	return { items: buildBuiltinRules() };
}

registerProvider<Rule>(ruleCapability.id, {
	id: BUILTIN_DEFAULTS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Default rules shipped with the agent (disable via ttsr.builtinRules / ttsr.disabledRules)",
	priority: PRIORITY,
	load: loadRules,
});
