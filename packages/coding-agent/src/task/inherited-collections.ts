import * as path from "node:path";

import { logger } from "@veyyon/utils";

export type InheritedCollectionKind = "skills" | "promptTemplates" | "rules";

export interface InheritResolvedCollectionArgs<T> {
	items: readonly T[] | undefined;
	kind: InheritedCollectionKind;
	parentCwd: string;
	spawnCwd: string;
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

export function settleAutoloadSkills<T extends { name: string }>(
	plan: AutoloadSkillPlan<T> | undefined,
	available: readonly T[],
	agentName: string,
): T[] {
	if (!plan) return [];
	return plan.kind === "resolved" ? plan.skills : matchAutoloadSkills(plan.names, available, agentName);
}
