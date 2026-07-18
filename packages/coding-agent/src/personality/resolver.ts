/**
 * Personality catalog resolver.
 *
 * Merges the 3 bundled built-in tone specs with Tier-B data-file
 * personalities discovered in the user (`~/.veyyon/personalities/*.md`) and
 * project (`.veyyon/personalities/*.md`) directories. Precedence for a given
 * name is project > user > built-in ("later wins").
 *
 * `none` is a reserved sentinel that disables the `<personality>` block
 * entirely; it is never a selectable file-backed name.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getProjectDir, isEnoent, logger } from "@veyyon/utils";
import defaultPersonality from "../prompts/system/personalities/default.md" with { type: "text" };
import friendlyPersonality from "../prompts/system/personalities/friendly.md" with { type: "text" };
import pragmaticPersonality from "../prompts/system/personalities/pragmatic.md" with { type: "text" };

/** Reserved sentinel that disables the personality block; never a valid file name. */
export const NONE_PERSONALITY = "none";

/** Name resolved to when a requested personality cannot be found. */
export const DEFAULT_PERSONALITY_NAME = "default";

/** Built-in tone specs, keyed by name. The seed tier of the merged catalog. */
export const BUILTIN_PERSONALITIES: Readonly<Record<string, string>> = {
	default: defaultPersonality.trim(),
	friendly: friendlyPersonality.trim(),
	pragmatic: pragmaticPersonality.trim(),
};

/** Short descriptions for built-in personalities, surfaced in the settings UI. */
export const BUILTIN_PERSONALITY_DESCRIPTIONS: Readonly<Record<string, string>> = {
	default: "Terse, evidence-first engineer; dense, action-oriented replies",
	friendly: "Warm, encouraging collaborator focused on momentum and morale",
	pragmatic: "Direct, efficient engineer focused on clarity and rigor",
};

/**
 * Resolve the home directory for Tier-B discovery. Reads `HOME`/`USERPROFILE`
 * directly (falling back to `os.homedir()`) because Bun's `os.homedir()`
 * snapshots the value at process start and does not observe later
 * `process.env.HOME` mutations — the pattern tests use to isolate `~/.veyyon`.
 */
function resolveHomeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** User-level personalities directory (`~/.veyyon/personalities`). */
export function getUserPersonalitiesDir(): string {
	return path.join(resolveHomeDir(), CONFIG_DIR_NAME, "personalities");
}

/** Project-level personalities directory (`<cwd>/.veyyon/personalities`). */
export function getProjectPersonalitiesDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME, "personalities");
}

/**
 * Read `*.md` personality files from `dir` into a name→spec map. Skips the
 * reserved `none` filename (it can never shadow the disable sentinel) and
 * empty/whitespace-only bodies (malformed — treated as absent so a lower
 * tier or the built-in seed provides the spec instead of a blank block).
 */
async function readPersonalityDir(dir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Could not read personalities directory", { dir, error: String(error) });
		}
		return result;
	}

	for (const entry of entries) {
		if (!entry.toLowerCase().endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		if (name.toLowerCase() === NONE_PERSONALITY) continue;

		const filePath = path.join(dir, entry);
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf-8");
		} catch (error) {
			logger.warn("Could not read personality file", { path: filePath, error: String(error) });
			continue;
		}

		const trimmed = content.trim();
		if (!trimmed) {
			logger.warn("Ignoring empty personality file", { path: filePath });
			continue;
		}
		result.set(name, trimmed);
	}

	return result;
}

export interface PersonalityCatalogOptions {
	/** Working directory used to resolve the project-level personalities dir. Default: getProjectDir() */
	cwd?: string;
}

interface PersonalityTiers {
	project: Map<string, string>;
	user: Map<string, string>;
}

async function loadTiers(options: PersonalityCatalogOptions): Promise<PersonalityTiers> {
	const cwd = options.cwd ?? getProjectDir();
	const [project, user] = await Promise.all([
		readPersonalityDir(getProjectPersonalitiesDir(cwd)),
		readPersonalityDir(getUserPersonalitiesDir()),
	]);
	return { project, user };
}

function resolveFromTiers(name: string, tiers: PersonalityTiers): string | undefined {
	return tiers.project.get(name) ?? tiers.user.get(name) ?? BUILTIN_PERSONALITIES[name];
}

function availableNames(tiers: PersonalityTiers): string[] {
	const names = new Set<string>(Object.keys(BUILTIN_PERSONALITIES));
	for (const name of tiers.user.keys()) names.add(name);
	for (const name of tiers.project.keys()) names.add(name);
	return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Matches a literal `<personality>` or `</personality>` tag (any whitespace
 * inside the brackets), case-insensitively. A Tier-B data file is untrusted
 * content; without this guard a stray closing tag in the file body would
 * prematurely end the wrapper the system-prompt template renders around it,
 * letting the rest of the file (or a spoofed `<personality>`/other tag that
 * follows) escape the fixed section and read as top-level prompt content.
 */
const PERSONALITY_TAG_RE = /<\s*\/?\s*personality\s*>/gi;

/** Neutralize literal `<personality>`/`</personality>` tags inside untrusted spec text. */
function escapePersonalityTags(text: string): string {
	return text.replace(PERSONALITY_TAG_RE, tag => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/**
 * Hard cap on the injected `<personality>` body. Tone specs are meant to be
 * short (built-ins are ~1KB); a Tier-B file has no size limit on disk, so
 * without a cap a huge file would silently blow the per-request prompt
 * budget on every turn. Chosen generous relative to the built-ins (~4x) so
 * legitimate longer specs still fit, while a runaway file gets truncated
 * with a visible warning instead of degrading every request silently.
 */
export const MAX_PERSONALITY_CHARS = 4000;

interface BoundedPersonalityText {
	text: string;
	warning?: string;
}

/** Sanitize wrapper-breakout tags and enforce {@link MAX_PERSONALITY_CHARS}. */
function boundPersonalityText(name: string, rawText: string): BoundedPersonalityText {
	const sanitized = escapePersonalityTags(rawText);
	if (sanitized.length <= MAX_PERSONALITY_CHARS) return { text: sanitized };

	const warning = `Personality "${name}" spec is ${sanitized.length} chars, exceeding the ${MAX_PERSONALITY_CHARS}-char budget; truncated to avoid inflating every request's prompt.`;
	logger.warn("Personality spec exceeded size budget; truncated", {
		name,
		chars: sanitized.length,
		limit: MAX_PERSONALITY_CHARS,
	});
	return { text: `${sanitized.slice(0, MAX_PERSONALITY_CHARS).trimEnd()}\n[...truncated]`, warning };
}

/**
 * Resolve the sorted set of personality names available for selection
 * (built-ins + Tier-B overrides), excluding the reserved `none` sentinel.
 * Callers add `none` themselves when building UI option lists.
 */
export async function resolveAvailablePersonalities(options: PersonalityCatalogOptions = {}): Promise<string[]> {
	return availableNames(await loadTiers(options));
}

export interface ResolvedPersonality {
	/** Personality name actually rendered. Differs from the request only on fallback. */
	name: string;
	/** Trimmed spec text to inject into the `<personality>` block. Empty for `none`. */
	text: string;
	/** Set when the requested name could not be resolved and a fallback was used. */
	warning?: string;
}

/**
 * Resolve the spec text for `requestedName`, honoring project > user > built-in
 * precedence. `none` always resolves to an empty block without touching disk.
 * An unknown name falls back to {@link DEFAULT_PERSONALITY_NAME} with a
 * warning — the personality block is never silently emitted empty for a real
 * (non-`none`) request.
 */
export async function resolvePersonality(
	requestedName: string,
	options: PersonalityCatalogOptions = {},
): Promise<ResolvedPersonality> {
	if (requestedName === NONE_PERSONALITY) {
		return { name: NONE_PERSONALITY, text: "" };
	}

	const tiers = await loadTiers(options);
	const resolved = resolveFromTiers(requestedName, tiers);
	if (resolved !== undefined) {
		const bounded = boundPersonalityText(requestedName, resolved);
		return { name: requestedName, text: bounded.text, warning: bounded.warning };
	}

	const available = availableNames(tiers);
	const warning = `Unknown personality "${requestedName}"; falling back to "${DEFAULT_PERSONALITY_NAME}". Available: ${available.join(", ")}, ${NONE_PERSONALITY}.`;
	logger.warn("Unknown personality; falling back to default", { requested: requestedName, available });
	const fallbackRaw =
		resolveFromTiers(DEFAULT_PERSONALITY_NAME, tiers) ?? BUILTIN_PERSONALITIES[DEFAULT_PERSONALITY_NAME];
	const bounded = boundPersonalityText(DEFAULT_PERSONALITY_NAME, fallbackRaw);
	// Unknown-name and oversized-fallback are distinct conditions; surface both
	// rather than letting the size warning silently swallow the fallback one.
	const combinedWarning = bounded.warning ? `${warning} ${bounded.warning}` : warning;
	return { name: DEFAULT_PERSONALITY_NAME, text: bounded.text, warning: combinedWarning };
}
