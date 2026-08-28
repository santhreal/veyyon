/** The supported way to change ONE section of the system prompt. none of them was this: */
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
}

export interface LoadSectionOverridesOptions {
	readonly cwd: string;
	/** Injected for tests; defaults to reading from disk. */
	readonly listDir?: (dir: string) => Promise<string[]>;
	readonly readFile?: (file: string) => Promise<string>;
}

const VALID_IDS: readonly string[] = TEMPLATE_SECTION_IDS;

/** Parse a filename into the section it targets, or null when it is not one. Anything that is not a `.md` file is ignored rather than rejected, so a */
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

/** Discover every override file in the ACTIVE PROFILE, and only there. A repository's `<cwd>/.veyyon/PROMPT_SECTIONS/` used to be read here at level */
export async function loadSectionOverrideFiles(
	options: LoadSectionOverridesOptions,
): Promise<readonly SectionOverrideFile[]> {
	const listDir = options.listDir ?? defaultListDir;
	const readFile = options.readFile ?? defaultReadFile;
	const found: SectionOverrideFile[] = [];

	const dir = path.join(getAgentDir(), PROMPT_SECTIONS_DIR);
	for (const filename of await listOverrideDir(listDir, dir)) {
		const parsed = parseSectionOverrideFilename(filename);
		if (!parsed) continue;
		assertKnownSectionId(parsed.id, filename);
		const filePath = path.join(dir, filename);
		const content = await readOverrideFile(readFile, filePath);
		found.push({ id: parsed.id, mode: parsed.mode, path: filePath, content });
	}
	return found;
}

/** List one override directory, distinguishing "not there" from "there and unusable". A missing directory is the overwhelmingly common case — almost nobody overrides a */
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

/** Read one override file that the directory listing just reported. Every failure here is loud, and that is the difference from listing a directory: */
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

/** Fold discovered files into an override map for `assembleDefaultTemplate`. Precedence is per section and mode: one file wins each `<section>:<mode>` */
export function applySectionOverrides(
	files: readonly SectionOverrideFile[],
	assembled: DefaultTemplateSections,
): Partial<DefaultTemplateSections> {
	const winner = new Map<string, SectionOverrideFile>();
	for (const file of files) {
		winner.set(`${file.id}:${file.mode}`, file);
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
		// The addition goes INSIDE the section, one blank line after its text and before whatever trailing whitespace the section already ended with.
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
