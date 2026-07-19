import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir, prompt } from "@veyyon/utils";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { PROVIDER_ID as NATIVE_SKILL_PROVIDER } from "../discovery/builtin";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import { PROVIDER_ID as VEYYON_PLUGINS_SKILL_PROVIDER } from "../discovery/veyyon-plugins";
import autoloadTemplate from "../prompts/skills/autoload.md" with { type: "text" };
import userInvocationTemplate from "../prompts/skills/user-invocation.md" with { type: "text" };
import type { SkillPromptDetails } from "../session/messages";

/**
 * Skills load ONLY from these Veyyon-native providers, every one rooted under
 * the active profile's agent dir (`~/.veyyon/profiles/<name>/agent`):
 *
 *   - `native`         — the profile's own `skills/` directory (skills you author)
 *   - `veyyon-managed` — auto-learn managed skills in the same profile
 *   - `veyyon-plugins` — skills bundled with plugins installed into the profile
 *
 * There is no cross-computer autodiscovery. Claude (`~/.claude`), Codex
 * (`~/.codex`), the Agent Skills standard (`~/.agent[s]`), GitHub, OpenCode, and
 * Claude marketplace plugins never contribute skills, and are never scanned:
 * this list is passed to `loadCapability` as an explicit provider allowlist, so
 * their directories are not read at all. Switching profiles switches the skill
 * set, because every provider here resolves through the active profile.
 *
 * This is a function, not a top-level array, because the provider-id constants
 * live in modules that participate in the discovery import cycle: reading them at
 * module-init time would hit the temporal dead zone. Called from `loadSkills`,
 * every binding is initialized.
 */
export function profileSkillProviderIds(): readonly string[] {
	return [NATIVE_SKILL_PROVIDER, MANAGED_SKILLS_PROVIDER_ID, VEYYON_PLUGINS_SKILL_PROVIDER];
}
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * (when enabled) `/skill:<name>`, but is excluded from the rendered system
	 * prompt's `<skills>` listing.
	 */
	hide?: boolean;
	/** Source metadata for display */
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

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

/**
 * Whether `name` is already claimed by an active authored (non-managed) skill.
 *
 * Managed (auto-learn) skills resolve dead-last in discovery, so an authored
 * skill of the same name always wins (see `loadSkills`) and a managed skill
 * written under an authored name is silently dropped — it never surfaces.
 * `manage_skill` create consults this to refuse the write up front instead of
 * reporting a false "Created" for a skill that can never appear.
 */
export function isNameClaimedByAuthoredSkill(name: string): boolean {
	return getActiveSkills().some(
		skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID,
	);
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

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
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	// Load skills only from the active profile's Veyyon-native providers (see
	// profileSkillProviderIds). The allowlist means foreign-tool directories
	// (`~/.claude`, `~/.codex`, `~/.agent[s]`, GitHub, OpenCode, Claude plugins)
	// are never scanned, so there is nothing to filter out per source afterwards.
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, {
		cwd,
		disabledExtensions,
		providers: [...profileSkillProviderIds()],
	});

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Select authored skills from the pre-dedup superset. `loadCapability`
	// dedupes before this pass, so keep the first occurrence of each name (the
	// providers are already scoped to the active profile by the allowlist).
	const seenAuthoredSkillNames = new Set<string>();
	const filteredSkills = result.all.filter(capSkill => {
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) return false;
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		if (!matchesIncludePatterns(capSkill.name)) return false;
		if (seenAuthoredSkillNames.has(capSkill.name)) return false;
		seenAuthoredSkillNames.add(capSkill.name);
		return true;
	});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
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

	// Managed (auto-learn) skills resolve dead-last with first-wins. Source from
	// result.all (pre-dedup): capability-level dedup runs BEFORE this pass, so a
	// managed skill can be shadowed by a higher-priority authored skill; managed
	// must stay visible whenever the authored name is not actually present.
	// Validate the on-disk name (a hand-placed managed file could carry an unsafe
	// frontmatter name) and re-sanitize the description on read. Descriptions and
	// names both render unescaped into the system prompt.
	const managedCandidates = result.all.filter(
		capSkill =>
			capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID &&
			isValidManagedSkillName(capSkill.name) &&
			!disabledSkillNames.has(capSkill.name) &&
			!matchesIgnorePatterns(capSkill.name) &&
			matchesIncludePatterns(capSkill.name),
	);
	// Names claimed by any authored skill (from the pre-dedup superset). Managed
	// defers to these so it never masks an authored skill of the same name.
	const enabledAuthoredNames = new Set(
		result.all
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
		// Already loaded under this name (an authored skill won the dedup above).
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
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));
	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

/**
 * Parsed `/skill:<name>` invocation: either at the start of the draft (the
 * traditional slash-command position) or as a `/skill:<name>` token embedded
 * mid-prompt. For the mid-prompt form the surrounding prose is threaded
 * through as `args` so the skill sees the full user request.
 */
export interface ParsedSkillInvocation {
	/** Bare skill name without the leading `skill:` prefix. */
	name: string;
	/** User-supplied arguments (everything outside the `/skill:<name>` token). */
	args: string;
}

const MID_PROMPT_SKILL_RE = /(^|\s)\/skill:([^\s/]+)(\s|$)/;

/**
 * Detect a `/skill:<name>` invocation in a user draft.
 *
 * Returns `undefined` when the text contains no skill token. Otherwise:
 *   - Leading form (`/skill:foo bar baz`): name=`foo`, args=`bar baz`.
 *   - Mid-prompt form (`fix the bug /skill:foo focus on auth`): name=`foo`,
 *     args=`fix the bug focus on auth` — the surrounding prose collapsed
 *     into a single args string.
 *
 * Mid-prompt detection is disabled when the draft itself starts with a
 * different slash command (e.g. `/compact /skill:foo`) or a local-execution
 * sigil — `!cmd` / `!!cmd` for the bash tool and `$ cmd` / `$$ cmd` for the
 * python tool. Those handlers run after the skill-command dispatcher and
 * their bodies routinely contain `/skill:<name>` references that are not
 * meant as skill invocations.
 */
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

/**
 * Whether the (already left-trimmed) draft begins with a TUI local-execution
 * sigil that downstream branches will consume verbatim — `!`/`!!` for the bash
 * tool and `$`/`$$` followed by ASCII whitespace for the python tool. Mirrors
 * `pythonCommandPrefixLength` in `modes/controllers/input-controller` so the
 * two checks agree without forcing a circular import.
 */
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
		// User-invoked skills announce themselves and expose their skill directory
		// so the model resolves the skill's own relative paths (scripts/, templates/).
		message = prompt
			.render(userInvocationTemplate, {
				name: skill.name,
				body,
				baseDir: skill.baseDir,
				userArgs: trimmedArgs || undefined,
			})
			.trim();
	} else {
		// Autoload skills are hidden, non-user context — they MUST NOT claim the
		// user invoked them; this keeps the minimal provenance-only format.
		message = prompt
			.render(autoloadTemplate, {
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
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
