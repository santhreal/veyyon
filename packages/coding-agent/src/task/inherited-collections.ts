import * as path from "node:path";

import { logger } from "@veyyon/utils";

/** Which parent-resolved layer is being forwarded, for the log line and nothing else. */
export type InheritedCollectionKind = "skills" | "promptTemplates" | "rules";

/**
 * A parent session's resolved layer, forwarded to a spawned agent only when forwarding it
 * cannot turn the child's own discovery off by accident.
 *
 * The session options these values feed (`skills`, `promptTemplates`, `rules`) are all
 * "resolved or not" switches keyed on PRESENCE: `sdk.ts` runs `if (options.skills !== undefined)`
 * and skips discovery entirely for anything that arrived, empty arrays included. So `[]` does not
 * mean "the child should also find nothing", it means "the child must not look", and a spawn site
 * that produced `[]` because the parent had nothing resolved yet silently disables the operator's
 * skills, prompt templates, or rules for every subagent, with green tests and no warning. That is
 * the same defect that cost every `AGENTS.md` in every spawned agent; `context-inheritance.ts`
 * carries the context-file half of the story.
 *
 * `undefined` is the honest answer for both ambiguous cases:
 *
 * - The parent never resolved this layer (`undefined` in, `undefined` out). Nothing is known, so
 *   nothing is asserted.
 * - The parent resolved it to zero items. Unlike a context-file set, zero skills, zero prompt
 *   templates, and zero rules are all legitimate steady states, so this is NOT warned about: it is
 *   simply indistinguishable from a scope that failed to load, and the cheap, correct response to
 *   an indistinguishable empty is to let the child resolve the layer itself. A layer that actually
 *   failed is reported by the loader that failed it, through the operator notices it already uses.
 *
 * The fourth rule is WHERE the child runs. All three layers carry a project scope keyed on the
 * working directory: prompt templates from `<cwd>/.veyyon/prompts`, rules from
 * `loadCapability("rules", { cwd })` (project `.veyyon/rules`, `.cursor/rules`, `.clinerules`,
 * `.agent[s]/rules`, and the project walk), and skills from the extension roots a project
 * declares in `<cwd>/.veyyon/settings.json#extensions`, whose `skills/` directory the
 * `veyyon-plugins` provider scans. That last one is the ONLY project scope a session's skills
 * have: the allowlist is `native` + `veyyon-managed` + `veyyon-plugins`, and project
 * `.veyyon/skills` is deliberately not scanned, so do not widen this comment to claim otherwise.
 * `test/task/cwd-discovered-layers.test.ts` proves all three on disk, with two real trees.
 * So a `task(cwd: elsewhere)` child handed the parent's list gets the PARENT tree's skills and
 * rules and, because presence disables discovery, never loads the ones that belong to the tree it
 * was pointed at. Inheritance across a root change is not inheritance, it is contamination, so a
 * differing cwd yields `undefined` and the child re-discovers, exactly as `inheritContextFiles`
 * already does for context files.
 *
 * A non-empty list from the same cwd is unambiguous and is passed straight through, so the common
 * spawn still pays no rediscovery.
 */
export interface InheritResolvedCollectionArgs<T> {
	/** The parent session's resolved layer, or `undefined` when it never resolved one. */
	items: readonly T[] | undefined;
	/** Which layer this is, for the log line and nothing else. */
	kind: InheritedCollectionKind;
	/** The parent session's working directory. */
	parentCwd: string;
	/** The working directory the child will run in. */
	spawnCwd: string;
	/** Agent name, for the log line. */
	agentName: string;
}

export function inheritResolvedCollection<T>(args: InheritResolvedCollectionArgs<T>): T[] | undefined {
	const { items, kind, parentCwd, spawnCwd, agentName } = args;

	if (path.resolve(parentCwd) !== path.resolve(spawnCwd)) {
		logger.debug("Subagent re-discovers layer: spawn cwd differs from parent", {
			agent: agentName,
			kind,
			parentCwd,
			spawnCwd,
		});
		return undefined;
	}

	if (items === undefined) {
		logger.debug("Subagent resolves its own layer: parent has none resolved", { agent: agentName, kind });
		return undefined;
	}
	if (items.length === 0) {
		logger.debug("Subagent resolves its own layer: parent resolved zero items", { agent: agentName, kind });
		return undefined;
	}
	return [...items];
}

/**
 * What a spawner knows about an agent definition's `autoloadSkills` names at spawn time.
 *
 * `resolved` is a real answer: the spawner held the same skill set the child will run with, so the
 * names were matched against it and every unmatched one was reported. `deferred` is the honest
 * "not mine to answer": the spawner's set is not the child's, so the names travel unmatched and
 * `settleAutoloadSkills` matches them inside the child against what the child actually resolved.
 */
export type AutoloadSkillPlan<T> =
	| { readonly kind: "resolved"; readonly skills: T[] }
	| { readonly kind: "deferred"; readonly names: string[] };

function matchAutoloadSkills<T extends { name: string }>(
	requested: readonly string[],
	available: readonly T[],
	agentName: string,
): T[] {
	const resolved: T[] = [];
	const missing: string[] = [];
	for (const name of requested) {
		const skill = available.find(candidate => candidate.name === name);
		if (skill) resolved.push(skill);
		else missing.push(name);
	}
	if (missing.length > 0) {
		logger.warn("Agent declares autoloadSkills that no loaded skill matches; those skills will not load", {
			agent: agentName,
			missing,
			availableCount: available.length,
		});
	}
	return resolved;
}

/**
 * The subset of `available` an agent definition's `autoloadSkills` names, with every name that
 * matched nothing reported.
 *
 * The old inline spelling was a `.map(find).filter(defined)`, so a typo in an agent's frontmatter,
 * or a skill that failed to load, produced a shorter list and no signal at all: the agent started
 * without the skill it declares it needs and nothing anywhere said why. The names are operator
 * intent, so an unmatched one is a warning, not a silent drop.
 *
 * `available` is `readonly T[] | undefined` and the two are NOT interchangeable, for the same
 * reason `inheritResolvedCollection` above keeps them apart. `[]` is a resolved set that happens
 * to be empty (`--no-skills`, or a scope with nothing in it), so a declared name matching nothing
 * in it is real news and warned about. `undefined` means nobody resolved a set here at all, and
 * matching names against a set you do not have produces a warning whose stated cause ("no loaded
 * skill matches") is not the actual one. Callers MUST pass the value the inheritance decision
 * produced, never `parentSkills ?? []`: that `??` re-conflates exactly what the presence contract
 * exists to keep apart, and it also resolved autoload names against the PARENT tree's skills for a
 * `task(cwd: elsewhere)` child, so a name that exists only in the child's tree was reported
 * missing while the child went on to discover a skill of that name it was never told to load.
 */
export function resolveAutoloadSkills<T extends { name: string }>(
	requested: readonly string[] | undefined,
	available: readonly T[] | undefined,
	agentName: string,
): AutoloadSkillPlan<T> {
	if (!requested || requested.length === 0) return { kind: "resolved", skills: [] };
	if (available === undefined) {
		logger.debug("Subagent resolves its own autoloadSkills: spawner holds no authoritative skill set", {
			agent: agentName,
			requested: [...requested],
		});
		return { kind: "deferred", names: [...requested] };
	}
	return { kind: "resolved", skills: matchAutoloadSkills(requested, available, agentName) };
}

/**
 * The plan's skills, matching a `deferred` plan's names against the set the child itself resolved.
 * Called inside the child, where `available` is finally the authoritative set, so this is the only
 * place a differing-`spawnCwd` child's autoload names can be judged present or missing.
 */
export function settleAutoloadSkills<T extends { name: string }>(
	plan: AutoloadSkillPlan<T> | undefined,
	available: readonly T[],
	agentName: string,
): T[] {
	if (!plan) return [];
	return plan.kind === "resolved" ? plan.skills : matchAutoloadSkills(plan.names, available, agentName);
}
