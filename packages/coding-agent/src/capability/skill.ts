/**
 * Skills Capability
 *
 * Skills provide specialized knowledge or workflows that extend agent capabilities.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * Parsed frontmatter from a skill file.
 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/**
	 * When `true`, the skill is loaded and accessible via `skill://<name>` (and
	 * `/skill:<name>` slash commands), but is omitted from the rendered system
	 * prompt's skill listing. Use for skills the user opts into explicitly
	 * rather than ones the model should auto-discover.
	 */
	hide?: boolean;
	/**
	 * Agent Skills standard equivalent of `hide`.
	 * When `true`, the skill is excluded from the system prompt listing.
	 * Normalized from kebab-case `disable-model-invocation` in YAML frontmatter.
	 * @see https://agentskills.io/specification
	 */
	disableModelInvocation?: boolean;
	[key: string]: unknown;
}

/**
 * A skill file as the discovery layer loads it: the whole markdown body plus its parsed
 * frontmatter. `extensibility/skills.ts` owns a different `Skill`, the session-facing summary
 * (name, description, paths) built FROM these, and the two shapes share only `name` and
 * `_source`. They used to share the exported name as well, in one package, so code that
 * touched nothing but `name` type-checked against either and could read the wrong provenance.
 * Named the way `capability/tool.ts` names `DiscoveredCustomTool`, for the same reason.
 */
export interface DiscoveredSkill {
	/** Skill name (unique key, derived from filename or frontmatter) */
	name: string;
	/** Absolute path to skill file */
	path: string;
	/** Skill content (markdown) */
	content: string;
	/** Parsed frontmatter */
	frontmatter?: SkillFrontmatter;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
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
