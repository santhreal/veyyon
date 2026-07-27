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
import { errorMessage, getAgentDir, isMissingPath, kebabToCamel } from "@veyyon/utils";
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
 *
 * `assembled` is the text each converted section currently has, which the caller
 * gets from `statementSectionOverrides`. An append needs it because appending
 * produces a whole-section override, and a whole-section override beats the
 * statements: appending to the wrong base therefore replaces the section with
 * that base. Omit a section from `assembled` only when it is not assembled from
 * statements at all.
 */
export function applySectionOverrides(
	files: readonly SectionOverrideFile[],
	assembled: Partial<DefaultTemplateSections> = {},
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
		const key = kebabToCamel(file.id) as keyof DefaultTemplateSections;
		// WHAT AN APPEND APPENDS TO, in precedence order, and the middle one is the fix for a real
		// defect. A `replace` file in the same override set wins, since the operator has said what the
		// section is. Otherwise the base is the ASSEMBLED section, which for a converted section is
		// the statement registry's output and is the only text a session actually sends. It used to go
		// straight to `DEFAULT_TEMPLATE_SECTIONS`, the copy sliced out of `system-prompt.md`, so an
		// operator appending one line to `role.md` silently reverted the rest of ROLE to the template
		// copy: the append result becomes a section override, and a section override beats the
		// statements. That was invisible only because the two copies are byte-identical today, and it
		// would have started deleting statement edits the moment they diverged. `DEFAULT_TEMPLATE_SECTIONS`
		// remains the base for a section that has NOT been converted, which is what the caller omits
		// from `assembled`.
		const base = resolved[key] ?? assembled[key] ?? DEFAULT_TEMPLATE_SECTIONS[key];
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

/** Thin adapters: every judgement about failure lives at the call site above. */
async function defaultListDir(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	return readdir(dir);
}

async function defaultReadFile(file: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(file, "utf8");
}
