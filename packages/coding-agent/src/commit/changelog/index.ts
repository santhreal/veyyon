import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import * as git from "../../utils/git";
import type { ResolveObfuscateProviderText } from "../shared-llm";
import { CHANGELOG_CATEGORIES, type UnreleasedCategory, type UnreleasedLayout } from "../types";
import { detectChangelogBoundaries } from "./detect";
import { generateChangelogEntries } from "./generate";
import { parseUnreleasedLayout, parseUnreleasedSection } from "./parse";

const CHANGELOG_SECTIONS = CHANGELOG_CATEGORIES;

/** Lower-cased section header -> its Keep-a-Changelog canonical casing, so a
 *  proposed "fixed" lands under an existing "### Fixed" heading. */
const CANONICAL_SECTION_BY_LOWER = new Map<string, string>(
	CHANGELOG_SECTIONS.map(section => [section.toLowerCase(), section]),
);

/** Keep-a-Changelog order of each canonical section. Other names sort after all of them. */
const SECTION_RANK = new Map<string, number>(CHANGELOG_SECTIONS.map((section, rank) => [section, rank]));

/** Map any-case section header to its canonical Keep-a-Changelog casing. An
 *  unknown name is trimmed but otherwise preserved. */
function canonicalizeSectionName(name: string): string {
	const trimmed = name.trim();
	return CANONICAL_SECTION_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

function sectionRank(section: string): number {
	return SECTION_RANK.get(section) ?? CHANGELOG_SECTIONS.length;
}

/** Group section-keyed items under their canonical section name, concatenating the
 *  items of keys that differ only in case, in order. A blank name is dropped. */
function groupByCanonicalSection(entries: Record<string, string[]>): Map<string, string[]> {
	const grouped = new Map<string, string[]>();
	for (const [name, items] of Object.entries(entries)) {
		const section = canonicalizeSectionName(name);
		if (!section) continue;
		const list = grouped.get(section);
		if (list) list.push(...items);
		else grouped.set(section, items.slice());
	}
	return grouped;
}

/** The form two entries share when they state the same change: case, runs of
 *  whitespace, and one trailing period do not distinguish them. */
function entryKey(text: string): string {
	return text.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

const DEFAULT_MAX_DIFF_CHARS = 120_000;

export interface ChangelogFlowInput {
	cwd: string;
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	stagedFiles: string[];
	dryRun: boolean;
	maxDiffChars?: number;
	onProgress?: (message: string) => void;
	resolveObfuscateProviderText: ResolveObfuscateProviderText;
}

export interface ChangelogProposalInput {
	cwd: string;
	proposals: Array<{
		path: string;
		entries: Record<string, string[]>;
		deletions?: Record<string, string[]>;
	}>;
	dryRun: boolean;
	onProgress?: (message: string) => void;
}

/**
 * Update CHANGELOG.md entries for staged changes.
 */
export async function runChangelogFlow({
	cwd,
	model,
	apiKey,
	thinkingLevel,
	stagedFiles,
	dryRun,
	maxDiffChars,
	onProgress,
	resolveObfuscateProviderText,
}: ChangelogFlowInput): Promise<string[]> {
	if (stagedFiles.length === 0) return [];
	onProgress?.("Detecting changelog boundaries...");
	const boundaries = await detectChangelogBoundaries(cwd, stagedFiles);
	if (boundaries.length === 0) return [];

	const updated: string[] = [];
	for (const boundary of boundaries) {
		onProgress?.(`Generating entries for ${boundary.changelogPath}…`);
		const diff = await git.diff(cwd, { cached: true, files: boundary.files });
		const sanitizeDiff = await resolveObfuscateProviderText();
		if (!sanitizeDiff(diff).trim()) continue;
		const stat = await git.diff(cwd, { stat: true, cached: true, files: boundary.files });
		const changelogContent = await Bun.file(boundary.changelogPath).text();
		const sanitizeProviderText = await resolveObfuscateProviderText();
		let layout: UnreleasedLayout;
		let providerEntries: Record<string, string[]>;
		try {
			layout = parseUnreleasedLayout(changelogContent);
			// The provider projection is derived only after the whole raw
			// changelog has crossed the confidentiality boundary.
			providerEntries = parseUnreleasedSection(sanitizeProviderText(changelogContent)).entries;
		} catch (error) {
			logger.warn("commit changelog parse skipped", {
				path: sanitizeProviderText(boundary.changelogPath),
				error: sanitizeProviderText(errorMessage(error)),
			});
			continue;
		}
		const existingEntries = formatExistingEntries(providerEntries);
		const isPackageChangelog = path.resolve(boundary.changelogPath) !== path.resolve(cwd, "CHANGELOG.md");
		const generated = await generateChangelogEntries({
			model,
			apiKey,
			thinkingLevel,
			changelogPath: boundary.changelogPath,
			isPackageChangelog,
			existingEntries: existingEntries || undefined,
			stat,
			diff,
			maxDiffChars: maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS,
			resolveObfuscateProviderText,
		});
		if (Object.keys(generated.entries).length === 0) continue;

		const updatedContent = applyChangelogEntries(layout, generated.entries);
		if (updatedContent === changelogContent) continue;
		if (!dryRun) {
			await Bun.write(boundary.changelogPath, updatedContent);
			await git.stage.files(cwd, [path.relative(cwd, boundary.changelogPath)]);
		}
		updated.push(boundary.changelogPath);
	}

	return updated;
}

/**
 * Apply changelog entries provided by the commit agent.
 */
export async function applyChangelogProposals({
	cwd,
	proposals,
	dryRun,
	onProgress,
}: ChangelogProposalInput): Promise<string[]> {
	const updated: string[] = [];
	for (const proposal of proposals) {
		if (
			Object.keys(proposal.entries).length === 0 &&
			(!proposal.deletions || Object.keys(proposal.deletions).length === 0)
		)
			continue;
		onProgress?.(`Applying entries for ${proposal.path}…`);
		const exists = await Bun.file(proposal.path).exists();
		if (!exists) {
			logger.warn("commit changelog path missing", { path: proposal.path });
			continue;
		}
		const changelogContent = await Bun.file(proposal.path).text();
		let layout: UnreleasedLayout;
		try {
			layout = parseUnreleasedLayout(changelogContent);
		} catch (error) {
			logger.warn("commit changelog parse skipped", { path: proposal.path, error: errorMessage(error) });
			continue;
		}
		const normalized = normalizeEntries(proposal.entries);
		const normalizedDeletions = proposal.deletions ? normalizeEntries(proposal.deletions) : undefined;
		if (Object.keys(normalized).length === 0 && !normalizedDeletions) continue;
		const updatedContent = applyChangelogEntries(layout, normalized, normalizedDeletions);
		if (updatedContent === changelogContent) continue;
		if (!dryRun) {
			await Bun.write(proposal.path, updatedContent);
			await git.stage.files(cwd, [path.relative(cwd, proposal.path)]);
		}
		updated.push(proposal.path);
	}

	return updated;
}

function formatExistingEntries(entries: Record<string, string[]>): string {
	const grouped = groupByCanonicalSection(entries);
	const lines: string[] = [];
	for (const section of CHANGELOG_SECTIONS) {
		const values = grouped.get(section);
		if (!values?.length) continue;
		lines.push(`${section}:`);
		for (const value of values) {
			lines.push(`- ${value}`);
		}
	}
	return lines.join("\n");
}

/** Lines to emit before one line of the changelog. */
interface Insertion {
	/** Bullets appended to the category whose entries end here. */
	bullets: string[];
	/** New `### <Section>` blocks, each a heading followed by its bullets. */
	blocks: string[][];
}

/** What one edit removes from and inserts into the changelog's lines. */
interface EditPlan {
	/** 1 at the index of every removed line. */
	removed: Uint8Array;
	inserts: Map<number, Insertion>;
	/** First category of each canonical section, where that section's additions go. */
	firstOf: Map<string, UnreleasedCategory>;
	/** Entry keys of each canonical section that survive the deletions. */
	keptKeys: Map<string, Set<string>>;
	/** Categories whose every entry is deleted and that hold nothing else. */
	emptied: Set<UnreleasedCategory>;
}

/**
 * Add `entries` to and delete `deletions` from the Unreleased section of `layout`.
 *
 * The edit is surgical: the result differs from `layout.lines` only by the lines of
 * each deleted entry, each added bullet, each new category block, the heading of a
 * category whose every entry was deleted, and the blank lines that would otherwise
 * double up where a removal joins two blank runs. Prose, unknown categories, wrapped
 * and nested entries, bullet markers and all other spacing are kept byte-for-byte.
 *
 * Section names match the Keep-a-Changelog categories case-insensitively; entry text
 * matches by {@link entryKey}, so an addition already present is skipped and a
 * deletion finds its entry whatever its case or trailing period.
 *
 * @internal Exported for testing.
 */
export function applyChangelogEntries(
	layout: UnreleasedLayout,
	entries: Record<string, string[]>,
	deletions?: Record<string, string[]>,
): string {
	const adding = groupByCanonicalSection(entries);
	const plan = planDeletions(layout, groupByCanonicalSection(deletions ?? {}), adding);
	const created = planAdditions(plan, adding);
	for (const category of plan.emptied) {
		plan.removed.fill(1, category.headingLine, category.contentEnd);
	}
	placeNewCategories(layout, plan, created);
	return emitEdited(layout, plan);
}

/** Mark deleted entries and collect the entry keys of every section the edit touches;
 *  a section neither side names is never keyed. */
function planDeletions(
	layout: UnreleasedLayout,
	deleting: Map<string, string[]>,
	adding: Map<string, string[]>,
): EditPlan {
	const { lines } = layout;
	const plan: EditPlan = {
		removed: new Uint8Array(lines.length),
		inserts: new Map(),
		firstOf: new Map(),
		keptKeys: new Map(),
		emptied: new Set(),
	};
	const doomedBySection = new Map<string, Set<string>>();
	for (const [section, items] of deleting) doomedBySection.set(section, new Set(items.map(entryKey)));
	for (const category of layout.categories) {
		const section = canonicalizeSectionName(category.name);
		if (!plan.firstOf.has(section)) plan.firstOf.set(section, category);
		const doomed = doomedBySection.get(section);
		if (!doomed && !adding.has(section)) continue;
		let keys = plan.keptKeys.get(section);
		if (!keys) {
			keys = new Set<string>();
			plan.keptKeys.set(section, keys);
		}
		let survivors = 0;
		for (const entry of category.entries) {
			const key = entryKey(entry.text);
			if (doomed?.has(key)) {
				plan.removed.fill(1, entry.startLine, entry.endLine);
			} else {
				keys.add(key);
				survivors += 1;
			}
		}
		if (survivors === 0 && category.entries.length > 0 && !hasProse(lines, category)) {
			plan.emptied.add(category);
		}
	}
	return plan;
}

/** Queue each new bullet after the last entry of its section's first category, or after
 *  that category's content when it has no entry, so the bullet never sits above an
 *  indented line it would absorb. Returns the bullets of sections with no category yet. */
function planAdditions(plan: EditPlan, adding: Map<string, string[]>): Array<{ section: string; bullets: string[] }> {
	const created: Array<{ section: string; bullets: string[] }> = [];
	for (const [section, items] of adding) {
		const seen = plan.keptKeys.get(section) ?? new Set<string>();
		const bullets: string[] = [];
		for (const item of items) {
			const key = entryKey(item);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			bullets.push(`- ${item.trim()}`);
		}
		if (bullets.length === 0) continue;
		const target = plan.firstOf.get(section);
		if (target) {
			plan.emptied.delete(target);
			const at = target.entries.at(-1)?.endLine ?? target.contentEnd;
			insertionAt(plan.inserts, at).bullets.push(...bullets);
		} else {
			created.push({ section, bullets });
		}
	}
	return created;
}

/** A new category goes after the last kept category that sorts before it, else after
 *  the text that precedes the first category. Blocks sharing a position keep section order. */
function placeNewCategories(
	layout: UnreleasedLayout,
	plan: EditPlan,
	created: Array<{ section: string; bullets: string[] }>,
): void {
	created.sort((a, b) => sectionRank(a.section) - sectionRank(b.section));
	for (const { section, bullets } of created) {
		const rank = sectionRank(section);
		let at = layout.preambleEnd;
		for (const category of layout.categories) {
			if (!plan.emptied.has(category) && sectionRank(canonicalizeSectionName(category.name)) < rank) {
				at = category.contentEnd;
			}
		}
		insertionAt(plan.inserts, at).blocks.push([`### ${section}`, ...bullets]);
	}
}

/**
 * Write the kept lines with the insertions in place. A new block is set off by one
 * blank line on each side. A blank line that follows a removal and would extend a
 * blank run already written is dropped, and so is a trailing blank line the source
 * did not end with, so a removal never leaves a doubled gap or adds a final newline.
 */
function emitEdited(layout: UnreleasedLayout, plan: EditPlan): string {
	const { lines, startLine, endLine } = layout;
	// Every removal and insertion lies inside the section, so the lines through its
	// heading, and from the next release heading on, are copied unchanged.
	const out = lines.slice(0, startLine + 1);
	let blankBeforeNext = false;
	let removedSinceWrite = false;
	for (let i = startLine + 1; i <= endLine; i += 1) {
		const insert = plan.inserts.get(i);
		if (insert) {
			out.push(...insert.bullets);
			for (const block of insert.blocks) {
				if (out[out.length - 1].trim() !== "") out.push("");
				out.push(...block);
				blankBeforeNext = true;
			}
		}
		if (i === endLine) break;
		const line = lines[i];
		const blank = line.trim() === "";
		if (plan.removed[i] === 1 || (blank && removedSinceWrite && out[out.length - 1].trim() === "")) {
			removedSinceWrite = true;
			continue;
		}
		if (blankBeforeNext && !blank) out.push("");
		blankBeforeNext = false;
		removedSinceWrite = false;
		out.push(line);
	}
	if (endLine < lines.length) {
		// `lines[endLine]` is the next `## ` heading, never blank.
		if (blankBeforeNext) out.push("");
		for (let i = endLine; i < lines.length; i += 1) out.push(lines[i]);
	} else if (lines[endLine - 1].trim() !== "") {
		// The section ends the file without a final newline; the Unreleased heading stops the loop.
		while (out[out.length - 1].trim() === "") out.pop();
	}
	return out.join("\n");
}

function insertionAt(inserts: Map<number, Insertion>, line: number): Insertion {
	let insert = inserts.get(line);
	if (!insert) {
		insert = { bullets: [], blocks: [] };
		inserts.set(line, insert);
	}
	return insert;
}

/** Whether a non-blank line under the category heading lies outside every entry. */
function hasProse(lines: string[], category: UnreleasedCategory): boolean {
	let line = category.headingLine + 1;
	for (const entry of category.entries) {
		for (; line < entry.startLine; line += 1) {
			if (lines[line].trim() !== "") return true;
		}
		line = entry.endLine;
	}
	for (; line < category.contentEnd; line += 1) {
		if (lines[line].trim() !== "") return true;
	}
	return false;
}

function normalizeEntries(entries: Record<string, string[]>): Record<string, string[]> {
	const normalized: Array<[string, string[]]> = [];
	for (const [section, items] of Object.entries(entries)) {
		const trimmed = items.map(item => item.trim().replace(/\.$/, "")).filter(item => item.length > 0);
		if (trimmed.length > 0) normalized.push([section, trimmed]);
	}
	return Object.fromEntries(normalized);
}
