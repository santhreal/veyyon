import * as fs from "node:fs/promises";
import { getProjectDir, prompt } from "@veyyon/utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type DiscoveredSkill, loadCapability } from "../discovery";
import { PROVIDER_ID as NATIVE_SKILL_PROVIDER } from "../discovery/builtin";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { PROVIDER_ID as VEYYON_PLUGINS_SKILL_PROVIDER } from "../discovery/veyyon-plugins";
import { skillsPrompts } from "../prompts/skills/rows";
import type { SkillPromptDetails } from "../session/messages";
import { countNewlines } from "../session/streaming-output";

export { getActiveSkills, resetActiveSkillsForTests, setActiveSkills } from "./active-skills";

function profileSkillProviderIds(): readonly string[] {
	return [NATIVE_SKILL_PROVIDER, MANAGED_SKILLS_PROVIDER_ID, VEYYON_PLUGINS_SKILL_PROVIDER];
}
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	hide?: boolean;
	_source?: SourceMeta;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

export function isNameClaimedByAuthoredSkill(name: string, skills: readonly Skill[]): boolean {
	return skills.some(skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID);
}

export interface LoadSkillsFromDirOptions {
	dir: string;
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir({
		dir: options.dir,
		providerId,
		level,
		requireDescription: true,
	});

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	cwd?: string;
	agentDir?: string;
}

export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		agentDir,
		enabled = true,
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	const result = await loadCapability<DiscoveredSkill>(skillCapability.id, {
		cwd,
		agentDir,
		disabledExtensions,
		providers: [...profileSkillProviderIds()],
	});

	const loadWarnings = [...(result.warnings ?? [])];
	const candidates: DiscoveredSkill[] = result.all;

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	const filteredSkills = candidates.filter(capSkill => {
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) return false;
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		return matchesIncludePatterns(capSkill.name);
	});

	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message:
					`its skill name "${capSkill.name}" is already taken by ${existing.filePath}, so this file is not ` +
					"available to the model. Fix: rename this one in its own frontmatter, or delete whichever of the " +
					"two you do not want.",
			});
			realPathSet.add(resolvedPath);
		} else {
			skillMap.set(capSkill.name, {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				source: `${capSkill._source.provider}:${capSkill.level}`,
				hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
				_source: capSkill._source,
			});
			realPathSet.add(resolvedPath);
		}
	}

	const managedCandidates = candidates.filter(
		capSkill =>
			capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID &&
			isValidManagedSkillName(capSkill.name) &&
			!disabledSkillNames.has(capSkill.name) &&
			!matchesIgnorePatterns(capSkill.name) &&
			matchesIncludePatterns(capSkill.name),
	);
	const enabledAuthoredNames = new Set(
		candidates
			.filter(capSkill => capSkill._source.provider !== MANAGED_SKILLS_PROVIDER_ID)
			.map(capSkill => capSkill.name),
	);
	const managedRealPaths = await Promise.all(
		managedCandidates.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);
	for (let i = 0; i < managedCandidates.length; i++) {
		const capSkill = managedCandidates[i];
		const resolvedPath = managedRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;
		if (enabledAuthoredNames.has(capSkill.name)) continue; // an authored skill owns this name
		if (skillMap.has(capSkill.name)) continue;
		const rawDescription =
			typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "";
		skillMap.set(capSkill.name, {
			name: capSkill.name,
			description: sanitizeManagedDescription(rawDescription),
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: `${capSkill._source.provider}:${capSkill.level}`,
			hide: capSkill.frontmatter?.hide === true || capSkill.frontmatter?.disableModelInvocation === true,
			_source: capSkill._source,
		});
		realPathSet.add(resolvedPath);
	}

	const skills = Array.from(skillMap.values());
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return {
		skills,
		warnings: [...loadWarnings.map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

export interface ParsedSkillInvocation {
	name: string;
	args: string;
}

const MID_PROMPT_SKILL_RE = /(^|\s)\/skill:([^\s/]+)(\s|$)/;

export function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/skill:")) {
		const spaceIndex = trimmedStart.indexOf(" ");
		const name =
			spaceIndex === -1 ? trimmedStart.slice("/skill:".length) : trimmedStart.slice("/skill:".length, spaceIndex);
		if (!name) return undefined;
		const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
		return { name, args };
	}
	if (trimmedStart.startsWith("/")) return undefined;
	if (startsWithLocalExecutionPrefix(trimmedStart)) return undefined;
	const match = MID_PROMPT_SKILL_RE.exec(text);
	if (!match) return undefined;
	const leading = match[1] ?? "";
	const trailing = match[3] ?? "";
	const tokenStart = match.index + leading.length;
	const tokenEnd = match.index + match[0].length - trailing.length;
	const name = match[2] ?? "";
	if (!name) return undefined;
	const before = text.slice(0, tokenStart).trimEnd();
	const after = text.slice(tokenEnd).trimStart();
	const args = [before, after]
		.filter(part => part.length > 0)
		.join(" ")
		.trim();
	return { name, args };
}

function startsWithLocalExecutionPrefix(trimmedStart: string): boolean {
	if (trimmedStart.startsWith("!")) return true;
	if (trimmedStart.charCodeAt(0) !== 36 /* $ */) return false;
	if (trimmedStart.charCodeAt(1) === 123 /* { */) return false;
	const sigilLength = trimmedStart.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedStart.charCodeAt(sigilLength);
	if (Number.isNaN(next)) return true;
	return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13 /* CR */;
}

export type SkillInvocationKind = "user" | "autoload";

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "baseDir">,
	args: string,
	invocation: SkillInvocationKind = "user",
): Promise<BuiltSkillPromptMessage> {
	const content = await Bun.file(skill.filePath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const trimmedArgs = args.trim();
	let message: string;
	if (invocation === "user") {
		message = prompt
			.render(skillsPrompts["skills/user-invocation"].text, {
				name: skill.name,
				body,
				baseDir: skill.baseDir,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	} else {
		message = prompt
			.render(skillsPrompts["skills/autoload"].text, {
				body,
				filePath: skill.filePath,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	}
	return {
		message,
		details: {
			name: skill.name,
			path: skill.filePath,
			args: trimmedArgs || undefined,
			lineCount: body ? countNewlines(body) + 1 : 0,
		},
	};
}
