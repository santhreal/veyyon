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

// The active-skill snapshot lives in its own leaf so a reader does not have to import the loader.
export { getActiveSkills, resetActiveSkillsForTests, setActiveSkills } from "./active-skills";

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

/**
 * Whether `name` is already claimed by an authored (non-managed) skill in the
 * calling session.
 *
 * Managed (auto-learn) skills resolve dead-last in discovery, so an authored
 * skill of the same name always wins (see `loadSkills`) and a managed skill
 * written under an authored name is silently dropped — it never surfaces.
 * The caller must supply its own skill set: consulting the process-global
 * compatibility snapshot here leaks names between concurrent top-level sessions.
 */
export function isNameClaimedByAuthoredSkill(name: string, skills: readonly Skill[]): boolean {
	return skills.some(skill => skill.name === name && skill._source?.provider !== MANAGED_SKILLS_PROVIDER_ID);
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
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
	/**
	 * WHICH profile's skills to load. Default: `getAgentDir()`, the process-active
	 * profile. Naming a different directory loads THAT directory's skills and drops the
	 * active profile's, so a session rooted in another agent dir gets its own skill set.
	 */
	agentDir?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 *
 * `options.agentDir` picks WHICH profile. It is forwarded to {@link loadCapability},
 * which puts it on the `LoadContext` every provider receives, and all three providers in
 * the skill allowlist read it from there:
 *
 *   - `native`         reads `<agentDir>/skills`
 *   - `veyyon-managed` reads `<agentDir>/managed-skills`
 *   - `veyyon-plugins` reads `<agentDir>/settings.json#extensions` and that profile's
 *                      installed plugins, via `listVeyyonExtensionRoots`
 *
 * Each of them used to call the process-global `getAgentDir()` instead, so a session
 * rooted in another profile silently ran on the booted profile's skills.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		agentDir,
		enabled = true,
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	// Load skills only from the named profile's Veyyon-native providers (see
	// profileSkillProviderIds). The allowlist means foreign-tool directories
	// (`~/.claude`, `~/.codex`, `~/.agent[s]`, GitHub, OpenCode, Claude plugins)
	// are never scanned, so there is nothing to filter out per source afterwards.
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
	// Select authored skills from the pre-dedup superset. Keep same-name
	// candidates until the map pass below: `result.items` is already deduped, but
	// the pre-dedup superset is deliberately used so distinct files with one name
	// can emit an operator-visible collision warning. Exact-file aliases are
	// deduped by realpath immediately before that warning.
	const filteredSkills = candidates.filter(capSkill => {
		if (capSkill._source.provider === MANAGED_SKILLS_PROVIDER_ID) return false;
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		return matchesIncludePatterns(capSkill.name);
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
				// Names the WINNER's file, and says the loser is inert. "skipping this
				// one" left an operator with two SKILL.md files, no way to tell which
				// one the model is reading, and no stated action.
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

	// Managed (auto-learn) skills resolve dead-last with first-wins. Source from
	// the pre-dedup superset: capability-level dedup runs BEFORE this pass, so a
	// managed skill can be shadowed by a higher-priority authored skill; managed
	// must stay visible whenever the authored name is not actually present.
	// Validate the on-disk name (a hand-placed managed file could carry an unsafe
	// frontmatter name) and re-sanitize the description on read. Descriptions and
	// names both render unescaped into the system prompt.
	const managedCandidates = candidates.filter(
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
			.render(skillsPrompts["skills/user-invocation"].text, {
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
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
