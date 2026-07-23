import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import { logger } from "@veyyon/utils";
import { CHANGELOG_CATEGORIES } from "../../commit/types";
import * as git from "../../utils/git";
import { detectChangelogBoundaries } from "./detect";
import { generateChangelogEntries } from "./generate";
import { parseUnreleasedSection } from "./parse";

const CHANGELOG_SECTIONS = CHANGELOG_CATEGORIES;

/** Lower-cased section header -> its Keep-a-Changelog canonical casing. Item text
 *  is already matched case-insensitively (the `.toLowerCase()` compares in
 *  applyDeletions/mergeEntries), so the section KEY must be normalized the same
 *  way or a model-proposed "fixed" would neither match the parsed "Fixed" nor
 *  render (renderUnreleasedSections only emits the canonical keys). */
const CANONICAL_SECTION_BY_LOWER = new Map<string, string>(
	CHANGELOG_SECTIONS.map(section => [section.toLowerCase(), section]),
);

/** Map any-case section header to its canonical Keep-a-Changelog casing. An
 *  unknown name is trimmed but otherwise preserved (the renderer's fixed section
 *  list already governs which sections surface). */
function canonicalizeSectionName(name: string): string {
	const trimmed = name.trim();
	return CANONICAL_SECTION_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Rebuild a section-keyed record under canonical section names, concatenating
 *  the items of any keys that collapse to the same canonical section (e.g. a file
 *  that carries both "Fixed" and "fixed"). Order within a section is preserved. */
function canonicalizeSectionKeys(entries: Record<string, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [section, items] of Object.entries(entries)) {
		const key = canonicalizeSectionName(section);
		result[key] = result[key] ? [...result[key], ...items] : [...items];
	}
	return result;
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
}: ChangelogFlowInput): Promise<string[]> {
	if (stagedFiles.length === 0) return [];
	onProgress?.("Detecting changelog boundaries...");
	const boundaries = await detectChangelogBoundaries(cwd, stagedFiles);
	if (boundaries.length === 0) return [];

	const updated: string[] = [];
	for (const boundary of boundaries) {
		onProgress?.(`Generating entries for ${boundary.changelogPath}…`);
		const diff = await git.diff(cwd, { cached: true, files: boundary.files });
		if (!diff.trim()) continue;
		const stat = await git.diff(cwd, { stat: true, cached: true, files: boundary.files });
		const diffForPrompt = truncateDiff(diff, maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS);
		const changelogContent = await Bun.file(boundary.changelogPath).text();
		let unreleased: { startLine: number; endLine: number; entries: Record<string, string[]> };
		try {
			unreleased = parseUnreleasedSection(changelogContent);
		} catch (error) {
			logger.warn("commit changelog parse skipped", { path: boundary.changelogPath, error: String(error) });
			continue;
		}
		const existingEntries = formatExistingEntries(unreleased.entries);
		const isPackageChangelog = path.resolve(boundary.changelogPath) !== path.resolve(cwd, "CHANGELOG.md");
		const generated = await generateChangelogEntries({
			model,
			apiKey,
			thinkingLevel,
			changelogPath: boundary.changelogPath,
			isPackageChangelog,
			existingEntries: existingEntries || undefined,
			stat,
			diff: diffForPrompt,
		});
		if (Object.keys(generated.entries).length === 0) continue;

		const updatedContent = applyChangelogEntries(changelogContent, unreleased, generated.entries);
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
		let unreleased: { startLine: number; endLine: number; entries: Record<string, string[]> };
		try {
			unreleased = parseUnreleasedSection(changelogContent);
		} catch (error) {
			logger.warn("commit changelog parse skipped", { path: proposal.path, error: String(error) });
			continue;
		}
		const normalized = normalizeEntries(proposal.entries);
		const normalizedDeletions = proposal.deletions ? normalizeEntries(proposal.deletions) : undefined;
		if (Object.keys(normalized).length === 0 && !normalizedDeletions) continue;
		const updatedContent = applyChangelogEntries(changelogContent, unreleased, normalized, normalizedDeletions);
		if (!dryRun) {
			await Bun.write(proposal.path, updatedContent);
			await git.stage.files(cwd, [path.relative(cwd, proposal.path)]);
		}
		updated.push(proposal.path);
	}

	return updated;
}

function truncateDiff(diff: string, maxChars: number): string {
	if (diff.length <= maxChars) return diff;
	return `${diff.slice(0, maxChars)}\n[…${diff.length - maxChars}ch elided…]`;
}

function formatExistingEntries(entries: Record<string, string[]>): string {
	const lines: string[] = [];
	for (const section of CHANGELOG_SECTIONS) {
		const values = entries[section] ?? [];
		if (values.length === 0) continue;
		lines.push(`${section}:`);
		for (const value of values) {
			lines.push(`- ${value}`);
		}
	}
	return lines.join("\n");
}

/** @internal Exported for testing. */
export function applyChangelogEntries(
	content: string,
	unreleased: { startLine: number; endLine: number; entries: Record<string, string[]> },
	entries: Record<string, string[]>,
	deletions?: Record<string, string[]>,
): string {
	const lines = content.split("\n");
	const before = lines.slice(0, unreleased.startLine + 1);
	const after = lines.slice(unreleased.endLine);

	// Canonicalize every section key up front — the parsed base, the incoming
	// entries, and the deletions — so all three agree on case. Both callers
	// (updateChangelogForCommit with raw generated.entries, and applyChangelogEntries
	// via the commit agent) funnel through here, so this is the single owner of
	// section-key casing.
	let base = canonicalizeSectionKeys(unreleased.entries);
	const canonicalEntries = canonicalizeSectionKeys(entries);
	if (deletions) {
		base = applyDeletions(base, canonicalizeSectionKeys(deletions));
	}
	const merged = mergeEntries(base, canonicalEntries);
	const sectionLines = renderUnreleasedSections(merged);
	// `after` begins at the next `## [x.y.z]` release heading (parse's endLine points
	// AT it, so there is no leading blank). Keep-a-Changelog requires a blank line
	// before a heading, so insert exactly one separator when there is following
	// content, and none at end-of-file so the changelog gains no trailing blank.
	const separator = after.length > 0 ? [""] : [];
	return [...before, ...sectionLines, ...separator, ...after].join("\n");
}

function applyDeletions(
	existing: Record<string, string[]>,
	deletions: Record<string, string[]>,
): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [section, items] of Object.entries(existing)) {
		const toDelete = new Set((deletions[section] ?? []).map(d => d.toLowerCase()));
		const filtered = items.filter(item => !toDelete.has(item.toLowerCase()));
		if (filtered.length > 0) {
			result[section] = filtered;
		}
	}
	return result;
}

function mergeEntries(
	existing: Record<string, string[]>,
	incoming: Record<string, string[]>,
): Record<string, string[]> {
	const merged: Record<string, string[]> = { ...existing };
	for (const [section, items] of Object.entries(incoming)) {
		const current = merged[section] ?? [];
		const lower = new Set(current.map(item => item.toLowerCase()));
		for (const item of items) {
			const key = item.toLowerCase();
			if (!lower.has(key)) {
				current.push(item);
				// Track the just-added item so duplicates LATER in the same incoming
				// batch are also deduped — without this the membership set was stale and
				// every repeat within one batch slipped through.
				lower.add(key);
			}
		}
		merged[section] = current;
	}
	return merged;
}

// Render the Unreleased body: one leading blank line after the `## [Unreleased]`
// header, then each non-empty category. It deliberately returns NO trailing blank
// line; the caller (applyChangelogEntries) owns spacing to whatever follows.
function renderUnreleasedSections(entries: Record<string, string[]>): string[] {
	const lines: string[] = [""];
	for (const section of CHANGELOG_SECTIONS) {
		const items = entries[section] ?? [];
		if (items.length === 0) continue;
		lines.push(`### ${section}`);
		for (const item of items) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function normalizeEntries(entries: Record<string, string[]>): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const [section, items] of Object.entries(entries)) {
		const trimmed = items.map(item => item.trim().replace(/\.$/, "")).filter(item => item.length > 0);
		if (trimmed.length === 0) continue;
		result[section] = Array.from(new Set(trimmed.map(item => item.trim())));
	}
	return result;
}
