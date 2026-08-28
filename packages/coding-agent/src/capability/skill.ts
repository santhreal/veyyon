import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	hide?: boolean;
	disableModelInvocation?: boolean;
	[key: string]: unknown;
}

export interface DiscoveredSkill {
	name: string;
	path: string;
	content: string;
	frontmatter?: SkillFrontmatter;
	level: "user" | "project";
	_source: SourceMeta;
}

export const skillCapability = defineCapability<DiscoveredSkill>({
	id: "skills",
	displayName: "Skills",
	description: "Specialized knowledge and workflow files that extend agent capabilities",
	key: skill => skill.name,
	toExtensionId: skill => `skill:${skill.name}`,
	validate: skill => {
		if (!skill.name) return "Missing skill name";
		if (!skill.path) return "Missing skill path";
		return undefined;
	},
});
