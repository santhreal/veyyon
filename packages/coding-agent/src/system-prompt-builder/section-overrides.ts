/**
 * The supported way to change ONE section of the system prompt.
 *
 * WHY THIS EXISTS. Until now there were three ways to influence the prompt and
 * none of them was this:
 *
 *   - `--system-prompt` / `SYSTEM.md` replaces the ENTIRE template. Every
 *     section goes with it, including the ones you wanted to keep and every
 *     settings-gated branch inside them. That is why prompt customization has
 *     in practice meant forking the whole prompt and then falling behind it.
 *   - `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` does exactly the right thing but is
 *     a benchmark instrument by design: an env var, documented eval-only, and
 *     deliberately unreachable from config so no `config.yml` can quietly swap
 *     a section. It refuses to combine with a custom prompt at all.
 *   - `promptSectionOrder` on a harness profile reorders sections per model. It
 *     cannot change their content.
 *
 * So a user who wanted to add one rule to the delivery contract had to replace
 * all 272 lines of the template to do it. This closes that gap with a file
 * surface that sits next to `SYSTEM.md`, in the same project and user
 * locations, and resolves through the same registry.
 *
 * REPLACE VS APPEND, and why append is the one that matters. A replacement has
 * to carry its section's banner and, realistically, starts as a copy of the
 * shipped text — so it inherits the same drift problem as forking, just
 * smaller. Appending does not: the shipped section stays exactly as shipped,
 * including conditionals added to it later, and your text follows it. Most
 * customization is additive, so append is the path most people should take and
 * the one that survives upgrades.
 *
 * FAILING LOUDLY IS THE POINT. A file named after a section that does not exist
 * is a typo, and silently ignoring it would leave the operator believing a
 * change is live while the shipped prompt runs unmodified — the same false
 * confidence the eval override's validation exists to prevent. Unknown names
 * throw with the valid list.
 */
import * as path from "node:path";
import { getAgentDir, kebabToCamel } from "@veyyon/utils";
import { DEFAULT_TEMPLATE_SECTIONS, type DefaultTemplateSections, resolveSectionOverrides } from "./default-template";
import { TEMPLATE_SECTION_IDS } from "./section-registry";

/** Directory holding per-section override files, beside `SYSTEM.md`. */
export const PROMPT_SECTIONS_DIR = "PROMPT_SECTIONS";

/** Suffix marking a file as additive rather than replacing. */
const APPEND_SUFFIX = ".append.md";

export interface SectionOverrideFile {
	/** Registry section id, e.g. `delivery-contract`. */
	readonly id: string;
	readonly mode: "replace" | "append";
	readonly path: string;
	readonly content: string;
	/** Project-level files win over user-level ones for the same section. */
	readonly level: "user" | "project";
}

export interface LoadSectionOverridesOptions {
	readonly cwd: string;
	/** Nearest project config dir, when one was found. */
	readonly projectConfigDir?: string;
	/** Injected for tests; defaults to reading from disk. */
	readonly listDir?: (dir: string) => Promise<string[]>;
	readonly readFile?: (file: string) => Promise<string | null>;
}

const VALID_IDS: readonly string[] = TEMPLATE_SECTION_IDS;

/**
 * Parse a filename into the section it targets, or null when it is not one.
 *
 * Anything that is not a `.md` file is ignored rather than rejected, so a
 * README or an editor backup sitting in the directory is not an error. A `.md`
 * file whose stem is not a section IS rejected: it was written to change the
 * prompt and it will not, which is precisely the case that must not pass
 * quietly.
 */
export function parseSectionOverrideFilename(filename: string): { id: string; mode: "replace" | "append" } | null {
	if (filename.endsWith(APPEND_SUFFIX)) {
		return { id: filename.slice(0, -APPEND_SUFFIX.length), mode: "append" };
	}
	if (filename.endsWith(".md")) {
		return { id: filename.slice(0, -".md".length), mode: "replace" };
	}
	return null;
}

/** Reject a section id the registry does not know, naming the valid ones. */
export function assertKnownSectionId(id: string, filename: string): void {
	if (VALID_IDS.includes(id)) return;
	throw new Error(
		`${PROMPT_SECTIONS_DIR}/${filename} targets unknown prompt section "${id}". ` +
			`Valid sections: ${VALID_IDS.join(", ")}. ` +
			`Run \`veyyon prompt --sections\` to see the sections this configuration actually produces.`,
	);
}

/**
 * Discover every override file, user level first then project level.
 *
 * Both levels are returned rather than resolved here so a caller can report
 * what it found; {@link applySectionOverrides} does the precedence.
 */
export async function loadSectionOverrideFiles(
	options: LoadSectionOverridesOptions,
): Promise<readonly SectionOverrideFile[]> {
	const listDir = options.listDir ?? defaultListDir;
	const readFile = options.readFile ?? defaultReadFile;
	const found: SectionOverrideFile[] = [];

	const locations: { dir: string; level: "user" | "project" }[] = [
		{ dir: path.join(getAgentDir(), PROMPT_SECTIONS_DIR), level: "user" },
	];
	if (options.projectConfigDir) {
		locations.push({ dir: path.join(options.projectConfigDir, PROMPT_SECTIONS_DIR), level: "project" });
	}

	for (const { dir, level } of locations) {
		for (const filename of await listDir(dir)) {
			const parsed = parseSectionOverrideFilename(filename);
			if (!parsed) continue;
			assertKnownSectionId(parsed.id, filename);
			const filePath = path.join(dir, filename);
			const content = await readFile(filePath);
			if (content === null) continue;
			found.push({ id: parsed.id, mode: parsed.mode, path: filePath, content, level });
		}
	}
	return found;
}

/**
 * Fold discovered files into an override map for `assembleDefaultTemplate`.
 *
 * Precedence is per section and per mode: a project-level file beats a
 * user-level one for the SAME section and mode, so a repository can override a
 * personal default without having to restate the others. A replace and an
 * append for one section compose — the replacement supplies the section, the
 * append follows it — because refusing that combination would make the two
 * mechanisms mutually exclusive for no reason.
 *
 * Replacements are validated by {@link resolveSectionOverrides}, which requires
 * the section's banner so a replacement cannot silently collapse two sections
 * into one. Appends are exempt: they follow text that already carries the
 * banner, so demanding a second one would produce a duplicate heading.
 */
export function applySectionOverrides(files: readonly SectionOverrideFile[]): Partial<DefaultTemplateSections> {
	const winner = new Map<string, SectionOverrideFile>();
	for (const file of files) {
		const key = `${file.id}:${file.mode}`;
		const existing = winner.get(key);
		if (existing && existing.level === "project" && file.level === "user") continue;
		winner.set(key, file);
	}

	const replacements: Record<string, string> = {};
	for (const file of winner.values()) {
		if (file.mode === "replace") replacements[kebabToCamel(file.id)] = file.content;
	}
	const resolved = resolveSectionOverrides(replacements);

	for (const file of winner.values()) {
		if (file.mode !== "append") continue;
		const key = kebabToCamel(file.id) as keyof DefaultTemplateSections;
		const base = resolved[key] ?? DEFAULT_TEMPLATE_SECTIONS[key];
		// The addition goes INSIDE the section, one blank line after its text and
		// before whatever trailing whitespace the section already ended with.
		//
		// That trailing run is the separator to the NEXT section's banner, so
		// normalizing it away (or appending after it) shifts the boundary and
		// changes the assembled document outside the region being overridden —
		// which is exactly the containment this feature promises. It is captured
		// and restored rather than assumed, because the shipped sections do not
		// all end the same way.
		const trailing = /\s*$/.exec(base)?.[0] ?? "";
		const body = base.slice(0, base.length - trailing.length);
		resolved[key] = `${body}\n\n${file.content.replace(/\s+$/, "")}${trailing}`;
	}
	return resolved;
}

/** Discover and fold in one call. */
export async function loadPromptSectionOverrides(
	options: LoadSectionOverridesOptions,
): Promise<Partial<DefaultTemplateSections>> {
	return applySectionOverrides(await loadSectionOverrideFiles(options));
}

async function defaultListDir(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	try {
		return await readdir(dir);
	} catch {
		// A missing directory is the overwhelmingly common case: almost nobody
		// overrides a section. It is absence, not failure, and must not be noisy.
		return [];
	}
}

async function defaultReadFile(file: string): Promise<string | null> {
	const { readFile } = await import("node:fs/promises");
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}
