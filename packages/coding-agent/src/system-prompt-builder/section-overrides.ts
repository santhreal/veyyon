/**
 * The supported way to change ONE section of the system prompt.
 *
 * WHY THIS EXISTS. Until now there were three ways to influence the prompt and
 * none of them was this:
 *
 *   - `--system-prompt` replaces the ENTIRE template. Every
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
 * all 272 lines of the template to do it. This closes that gap with a native
 * file surface in the active profile and nearest project `.veyyon` directory.
 *
 * REPLACE VS APPEND, and why append is the one that matters. Both file forms
 * contain body text only; the registry adds the section banner. A replacement
 * still starts, realistically, as a copy of the shipped body and inherits the
 * smaller version of whole-prompt drift. An append keeps the shipped section,
 * including future conditions, and places operator text after it. Most
 * customization is additive, so append survives upgrades better.
 *
 * FAILING LOUDLY IS THE POINT. A file named after a section that does not exist
 * is a typo, and silently ignoring it would leave the operator believing a
 * change is live while the shipped prompt runs unmodified — the same false
 * confidence the eval override's validation exists to prevent. Unknown names
 * throw with the valid list.
 */
import * as path from "node:path";
import { errorMessage, getAgentDir, isMissingPath, kebabToCamel } from "@veyyon/utils";
import { assertNoRegisteredBanners, bannerTable } from "./banner-grammar";
import { type DefaultTemplateSections, resolveSectionOverrides } from "./default-template";
import { SYSTEM_PROMPT_SECTIONS, TEMPLATE_SECTION_IDS } from "./section-registry";

const SYSTEM_SECTION_BANNERS = bannerTable(SYSTEM_PROMPT_SECTIONS);

/** Directory holding persistent per-section override files. */
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
	readonly readFile?: (file: string) => Promise<string>;
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
		for (const filename of await listOverrideDir(listDir, dir)) {
			const parsed = parseSectionOverrideFilename(filename);
			if (!parsed) continue;
			assertKnownSectionId(parsed.id, filename);
			const filePath = path.join(dir, filename);
			const content = await readOverrideFile(readFile, filePath);
			found.push({ id: parsed.id, mode: parsed.mode, path: filePath, content, level });
		}
	}
	return found;
}

/**
 * List one override directory, distinguishing "not there" from "there and unusable".
 *
 * A missing directory is the overwhelmingly common case — almost nobody overrides a
 * section — so it is absence, not failure, and must not be noisy. Every other error
 * means the directory IS there and could not be read: `EACCES` on a directory that
 * became root-owned after a `sudo` edit, `ELOOP` on a broken symlink, a path that is
 * a file. Those used to return the same empty list, so a `PROMPT_SECTIONS` full of
 * overrides the process cannot open produced a prompt with none of them applied and
 * nothing said anywhere — the precise false confidence this module's header says it
 * exists to prevent, a few functions below the code that caused it (Law 10).
 *
 * `isMissingPath` is the one owner of that split, so "does absence include EISDIR?"
 * is not decided again here.
 *
 * The judgement lives at the CALL SITE rather than inside the default reader,
 * because a reader injected by a test or an embedder has to be held to the same
 * contract. Putting it in the default made the guarantee an implementation detail of
 * one code path instead of a property of the loader.
 */
async function listOverrideDir(listDir: (dir: string) => Promise<string[]>, dir: string): Promise<string[]> {
	try {
		return await listDir(dir);
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw new Error(
			`cannot read ${dir}: ${errorMessage(error)}. ` +
				"Prompt section overrides in that directory would not be applied, and the prompt would " +
				"run as shipped with no sign of it. Fix the directory's permissions, or remove it if you " +
				"no longer override any sections.",
			{ cause: error },
		);
	}
}

/**
 * Read one override file that the directory listing just reported.
 *
 * Every failure here is loud, and that is the difference from listing a directory:
 * the file was NAMED in the listing a moment ago, so it exists and was written to
 * change the prompt. Answering an unreadable one with `null` skipped it silently and
 * the operator kept a file on disk that had stopped doing anything. A file that
 * vanished between the listing and the read is reported the same way rather than
 * excused, because at this point in the scan it is an anomaly and not the ordinary
 * "you have no overrides" case the listing already handles.
 */
async function readOverrideFile(readFile: (file: string) => Promise<string>, file: string): Promise<string> {
	try {
		return await readFile(file);
	} catch (error) {
		throw new Error(
			`cannot read prompt section override ${file}: ${errorMessage(error)}. ` +
				"The section would be left as shipped, so this is refused rather than ignored.",
			{ cause: error },
		);
	}
}

/**
 * Fold discovered files into an override map for `assembleDefaultTemplate`.
 *
 * Precedence is per section and mode. A project-level file beats a user-level
 * file for the same section and mode. Replace and append files compose because
 * replacement supplies the body and append extends that assembled section.
 *
 * Replacement files contain body text only. `resolveSectionOverrides` adds the
 * registry-owned banner. Append files are also body-only and follow whichever
 * complete section wins, replacement first and shipped statement assembly
 * otherwise.
 *
 * `assembled` is required because every shipped section comes from statements.
 * There is no template-prose fallback.
 */
export function applySectionOverrides(
	files: readonly SectionOverrideFile[],
	assembled: DefaultTemplateSections,
): Partial<DefaultTemplateSections> {
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
		const addition = file.content.trimEnd();
		if (addition === "") continue;
		assertNoRegisteredBanners(addition, SYSTEM_SECTION_BANNERS, `prompt section append override ${file.path}`);
		const key = kebabToCamel(file.id) as keyof DefaultTemplateSections;
		// A replacement in the same override set wins. Otherwise append to the
		// complete statement-assembled section supplied by the caller.
		const base = resolved[key] ?? assembled[key];
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
		resolved[key] = `${body}\n\n${addition}${trailing}`;
	}
	return resolved;
}

/** Discover and fold in one call against the complete statement assembly. */
export async function loadPromptSectionOverrides(
	options: LoadSectionOverridesOptions,
	assembled: DefaultTemplateSections,
): Promise<Partial<DefaultTemplateSections>> {
	return applySectionOverrides(await loadSectionOverrideFiles(options), assembled);
}

/** Thin adapters: every judgement about failure lives at the call site above. */
async function defaultListDir(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	return readdir(dir);
}

async function defaultReadFile(file: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(file, "utf8");
}
