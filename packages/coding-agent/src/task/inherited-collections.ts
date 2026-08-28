import * as path from "node:path";

import { logger } from "@veyyon/utils";

/** Which parent-resolved layer is being forwarded, for the log line and nothing else. */
export type InheritedCollectionKind = "skills" | "promptTemplates" | "rules";

/** A parent session's resolved layer, forwarded to a spawned agent only when forwarding it cannot turn the child's own discovery off by accident. */
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
	return items.slice();
}

/** What a spawner knows about an agent definition's `autoloadSkills` names at spawn time. `resolved` is a real answer: the spawner held the same skill set the child will run with, so the */
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

/** The subset of `available` an agent definition's `autoloadSkills` names, with every name that matched nothing reported. */
export function resolveAutoloadSkills<T extends { name: string }>(
	requested: readonly string[] | undefined,
	available: readonly T[] | undefined,
	agentName: string,
): AutoloadSkillPlan<T> {
	if (!requested || requested.length === 0) return { kind: "resolved", skills: [] };
	if (available === undefined) {
		logger.debug("Subagent resolves its own autoloadSkills: spawner holds no authoritative skill set", {
			agent: agentName,
			requested: requested.slice(),
		});
		return { kind: "deferred", names: requested.slice() };
	}
	return { kind: "resolved", skills: matchAutoloadSkills(requested, available, agentName) };
}

/** The plan's skills, matching a `deferred` plan's names against the set the child itself resolved. Called inside the child, where `available` is finally the authoritative set, so this is the only */
export function settleAutoloadSkills<T extends { name: string }>(
	plan: AutoloadSkillPlan<T> | undefined,
	available: readonly T[],
	agentName: string,
): T[] {
	if (!plan) return [];
	return plan.kind === "resolved" ? plan.skills : matchAutoloadSkills(plan.names, available, agentName);
}
